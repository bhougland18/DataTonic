//! Talend job (`.item`) importer.
//!
//! Reads the XML a Talend Studio job is stored as and produces a Duckle
//! pipeline. This is an interoperability reader for a file format: it parses
//! their data, never their code, and nothing here is derived from their
//! implementation.
//!
//! Coverage is deliberately the head of the distribution rather than the whole
//! catalogue. Talend ships 900+ components, but real jobs use a couple of
//! dozen: across a 44-job corpus only 16 distinct components appeared, and the
//! three hardest of them (the mapper, the child-job call, the parallel branch)
//! already have Duckle equivalents. Everything outside the table below is
//! reported as an unmapped node, never silently dropped, because a migration
//! that quietly loses a step is worse than one that refuses it.
//!
//! Three things deliberately do NOT convert:
//!   * Encrypted passwords (`enc:system.encryption.key.v1:...`). We cannot read
//!     them and would not want to bake them into a file if we could, so the
//!     property becomes an `${ENV:...}` placeholder and the run is reported.
//!   * Repository connections (`PROPERTY_TYPE=REPOSITORY`), where the host and
//!     credentials live in a separate repository item, not in the job. The job
//!     alone does not contain enough to connect.
//!   * Java expressions in mapper outputs (`TalendDate.getCurrentDate()`,
//!     `context.getProperty(..)`). A plain `Table.Column` reference maps to a
//!     column; anything else is reported for a human to translate.

use duckle_metadata::{EdgeData, NodeData, PipelineEdge, PipelineNode, Position};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeMap;

/// A component Duckle could not translate, or a value it refused to guess.
#[derive(Debug, Clone, PartialEq)]
pub enum Warning {
    /// No Duckle equivalent for this Talend component.
    UnmappedComponent { node: String, component: String },
    /// Host/credentials live in a repository item, not in this job file.
    RepositoryConnection { node: String, component: String },
    /// Password is encrypted with a Studio key; emitted as a placeholder.
    EncryptedSecret { node: String, property: String, placeholder: String },
    /// A mapper output expression that is Java, not a column reference.
    JavaExpression { node: String, column: String, expression: String },
    /// A Java body on a tJava/tJavaRow, which has to be ported by hand.
    ///
    /// `only_prints` when every statement is a print, so the body carries no rules. It
    /// still arrives with no SQL and still fails: the flag is there to triage a long
    /// list, not to let anything run.
    JavaBody { node: String, only_prints: bool },
}

impl std::fmt::Display for Warning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Warning::UnmappedComponent { node, component } => write!(
                f,
                "{node}: no Duckle equivalent for {component}; the node was imported as a \
                 placeholder and needs replacing by hand"
            ),
            Warning::RepositoryConnection { node, component } => write!(
                f,
                "{node} ({component}) uses a repository connection, so its host and credentials \
                 are not in this job file. Fill them in, or point the node at a saved connection"
            ),
            Warning::EncryptedSecret { node, property, placeholder } => write!(
                f,
                "{node}: {property} is encrypted with a Studio key and cannot be read. Set \
                 {placeholder} in the environment before running"
            ),
            Warning::JavaExpression { node, column, expression } => write!(
                f,
                "{node}: output column {column} is computed by Java (`{expression}`), which does \
                 not translate. Rewrite it as a SQL expression"
            ),
            Warning::JavaBody { node, only_prints: true } => write!(
                f,
                "{node}: the Java body only prints, so it carries no rules to port. Drop the \
                 node, or replace it with a log"
            ),
            Warning::JavaBody { node, only_prints: false } => write!(
                f,
                "{node}: the Java body has to be rewritten as SQL before this job runs"
            ),
        }
    }
}

/// The result of reading one `.item` file.
#[derive(Debug)]
pub struct Import {
    /// Job name, taken from the file stem.
    pub name: String,
    pub nodes: Vec<PipelineNode>,
    pub edges: Vec<PipelineEdge>,
    /// Everything a human still has to resolve. Empty means a clean import.
    pub warnings: Vec<Warning>,
    /// Talend component name -> how many of them were seen.
    pub components: BTreeMap<String, usize>,
    /// Loop bodies lifted out of this job into pipelines of their own.
    ///
    /// A legacy job writes a loop's body inline, as the subjob hanging off the
    /// loop's iterate link. Duckle points a loop at a child pipeline instead, so
    /// the body has to become a file and the loop has to name it.
    pub children: Vec<Import>,
}

impl Import {
    /// Serialise to the same pipeline JSON the canvas and the runner read.
    pub fn to_pipeline_json(&self) -> JsonValue {
        serde_json::json!({
            "name": self.name,
            "nodes": self.nodes,
            "edges": self.edges,
        })
    }
}

/// One `<node>` as read from the file, before mapping.
struct RawNode {
    component: String,
    /// Talend's `UNIQUE_NAME`, e.g. `tDBInput_1`. Used as the Duckle node id
    /// because it is already unique within the job and appears verbatim in the
    /// `<connection>` elements.
    unique: String,
    params: BTreeMap<String, String>,
    /// Multi-row settings: parameter name -> rows, each row a field->value map.
    ///
    /// A `TABLE` parameter holds a list rather than a value - the key columns of
    /// a de-duplicate, a sort's criteria, a file mask list - and a reader that
    /// only sees flat name/value pairs finds nothing on them, which leaves the
    /// component unconfigured and failing validation for a setting that IS in
    /// the file.
    tables: BTreeMap<String, Vec<BTreeMap<String, String>>>,
    /// Column names the node declares on its main output.
    ///
    /// Some components take their output shape from the schema rather than from
    /// a parameter, so a reader that skips the metadata cannot configure them
    /// at all - the names are in the file, just not where parameters live.
    columns: Vec<String>,
    /// Mapper output expressions, keyed by output column.
    mapper_out: Vec<(String, String)>,
    x: f64,
    y: f64,
}

/// Talend component -> (Duckle component id, React Flow node type).
///
/// `tDBInput`/`tDBOutput` are the modern generic forms; the concrete database
/// comes from the node's own `TYPE` parameter, so they are resolved separately
/// in [`map_component`].
/// Read a value out of the `PROPERTIES` blob a generic (tcomp) Talend component
/// carries.
///
/// Such a component keeps its whole configuration in one JSON document inside a
/// single `elementParameter`, so a reader that sees only flat name/value pairs
/// finds nothing on it at all: no account, no table, no query. On one corpus
/// that was every node of the largest connector family.
///
/// A value lives at `<path>.storedValue`. That is a bare scalar for most
/// properties, an object carrying `value` for booleans and numbers, and an
/// object carrying `name` for enums. Reading `value` on an enum yields nothing,
/// which silently drops exactly the settings worth importing - the
/// authentication type, the grant type - while looking like it worked.
fn tcomp_value(blob: &JsonValue, path: &str) -> Option<String> {
    let mut cur = blob;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    match cur.get("storedValue")? {
        JsonValue::String(s) if !s.is_empty() => Some(s.clone()),
        JsonValue::Bool(b) => Some(b.to_string()),
        JsonValue::Number(n) => Some(n.to_string()),
        // Enum before boolean: an enum object has `name` and no `value`, a
        // boolean has `value` and no `name`, so asking for `name` first reads
        // both correctly.
        JsonValue::Object(o) => match o.get("name").or_else(|| o.get("value")) {
            Some(JsonValue::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(JsonValue::Bool(b)) => Some(b.to_string()),
            Some(JsonValue::Number(n)) => Some(n.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// The parsed `PROPERTIES` blob, if this node carries one.
fn tcomp_blob(raw: &RawNode) -> Option<JsonValue> {
    let text = raw.params.get("PROPERTIES")?;
    if text.len() < 2 {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn static_map(component: &str) -> Option<(&'static str, &'static str)> {
    Some(match component {
        "tMysqlInput" => ("src.mysql", "source"),
        "tMysqlOutput" => ("snk.mysql", "sink"),
        "tOracleInput" => ("src.oracle", "source"),
        "tOracleOutput" => ("snk.oracle", "sink"),
        "tMSSqlInput" => ("src.sqlserver", "source"),
        "tMSSqlOutput" => ("snk.sqlserver", "sink"),
        "tPostgresqlInput" => ("src.postgres", "source"),
        "tPostgresqlOutput" => ("snk.postgres", "sink"),
        "tFileInputDelimited" => ("src.csv", "source"),
        "tFileOutputDelimited" => ("snk.csv", "sink"),
        "tFileInputExcel" => ("src.excel", "source"),
        "tFileOutputExcel" => ("snk.excel", "sink"),
        "tMap" => ("xf.map", "transform"),
        "tRunJob" => ("ctl.runjob", "transform"),
        "tUniqRow" => ("qa.unique", "transform"),
        // Markers, not work. Pre-job and post-job bracket a job, and Talend's
        // parallelize FANS SUBJOBS OUT rather than splitting rows - which is a
        // different thing from Duckle's ctl.parallelize, so mapping it there
        // asserted a row fan-out the job never had. All three exist to anchor
        // ordering links, which is what ctl.anchor is for.
        "tPrejob" | "tPostjob" | "tParallelize" => ("ctl.anchor", "transform"),
        // Opening and closing a shared connection is not work Duckle does: a
        // node resolves its own connection when it runs, so these mark a point
        // in the sequence and nothing else. Keeping them as anchors preserves
        // the ordering the job expressed through them.
        // A stopwatch measures how long a stretch of the job took. Duckle
        // records a duration for every stage already, so these mark a point in
        // the sequence and nothing else.
        "tChronometerStart" | "tChronometerStop" => ("ctl.anchor", "transform"),
        "tDBConnection" | "tDBClose" | "tSnowflakeConnection" | "tSnowflakeClose"
        | "tMysqlConnection" | "tMysqlClose" | "tOracleConnection" | "tOracleClose"
        | "tPostgresqlConnection" | "tPostgresqlClose" | "tMSSqlConnection"
        | "tMSSqlClose" => ("ctl.anchor", "transform"),
        // A log-catcher is a SOURCE of error rows, not a sink for them: what it
        // emits is mailed or written to a table downstream.
        "tLogCatcher" => ("src.runevents", "source"),
        // Both turn values into a row: one from constants, the other from the
        // iteration's current item, which ForEach exposes as ${ITER_ITEM_*}.
        "tFixedFlowInput" | "tIterateToFlow" => ("src.inline", "source"),
        "tFileList" => ("src.filelist", "source"),
        // A file-existence check is a listing of one path: one row, or none.
        "tFileExist" => ("src.filelist", "source"),
        // Turning a flow into an iteration IS the ForEach: each row becomes one
        // pass, and the row's fields are exposed to the child as ${ITER_ITEM_*}.
        "tFlowToIterate" => ("ctl.foreach", "transform"),
        "tFileCopy" | "tFileDelete" | "tFileArchive" => ("ctl.file", "transform"),
        // Components Duckle already has; these were placeholders only because
        // nobody had written the mapping line.
        "tSendMail" => ("snk.email", "sink"),
        "tLoop" => ("ctl.iterate", "transform"),
        "tSortRow" => ("xf.sort", "transform"),
        // Splitting one delimited column into named columns is Text to Columns.
        "tExtractDelimitedFields" => ("xf.text.tocolumns", "transform"),
        "tFileInputFullRow" => ("src.csv", "source"),
        // A raw statement against the connection, whichever family it is.
        "tDBRow" | "tSnowflakeRow" => ("code.sql", "transform"),
        // A Java body is business logic, and Duckle runs SQL. It cannot be
        // translated here - the proven reference implementation for this corpus
        // wrote a generic Java-to-SQL translator and abandoned it in favour of
        // porting the rules by hand.
        //
        // It maps to a custom-SQL node with NO sql, which fails validation and
        // says so. Mapping it to something that compiles - a log line, a
        // passthrough - would produce a pipeline that runs happily and silently
        // omits the rules, which is the worst outcome available: the shape looks
        // migrated and the numbers are wrong.
        "tJava" | "tJavaRow" => ("code.sql", "transform"),
        // Duckle already speaks Snowflake; these were arriving as placeholders
        // only because their configuration is in the tcomp PROPERTIES blob.
        "tSnowflakeInput" => ("src.snowflake", "source"),
        "tSnowflakeOutput" => ("snk.snowflake", "sink"),
        "tConvertType" => ("xf.cast", "transform"),
        // Passes rows through and prints them, which is what tLogRow does.
        "tLogRow" => ("xf.log", "transform"),
        // A raw SQL statement against the connection, whatever the family.
        "tMysqlRow" | "tOracleRow" | "tMSSqlRow" | "tPostgresqlRow" => ("code.sql", "transform"),
        // Talend's SCD components write a type-2 dimension.
        "tMysqlSCD" | "tOracleSCD" | "tMSSqlSCD" | "tPostgresqlSCD" => ("xf.cdc.scd2", "transform"),
        // A reusable sub-flow, invoked by name. Every built-in is spelled t
        // followed by a capital, so a name that is not is the project's own
        // sub-flow rather than a component nobody mapped - and calling another
        // pipeline is exactly what the run-job component does.
        other if is_subflow_name(other) => ("ctl.runjob", "transform"),
        _ => return None,
    })
}

/// True for a name that is not one of the built-in components.
///
/// The built-ins are all `t` followed by a capital letter. The port pseudo-nodes
/// a sub-flow's boundary produces are not invocations and must not be treated as
/// one, or a sub-flow would try to call itself.
fn is_subflow_name(name: &str) -> bool {
    if matches!(name, "INPUT" | "OUTPUT") {
        return false;
    }
    let mut c = name.chars();
    !matches!((c.next(), c.next()), (Some('t'), Some(second)) if second.is_ascii_uppercase())
}

/// Resolve the generic `tDBInput` / `tDBOutput` via the node's `TYPE` value.
fn map_component(raw: &RawNode) -> Option<(&'static str, &'static str)> {
    if let Some(hit) = static_map(&raw.component) {
        return Some(hit);
    }
    let family = raw.params.get("TYPE").map(|s| unquote(s).to_uppercase());
    let out = matches!(raw.component.as_str(), "tDBOutput");
    match (raw.component.as_str(), family.as_deref()) {
        ("tDBInput" | "tDBOutput", Some(fam)) => Some(match (fam, out) {
            ("MYSQL", false) => ("src.mysql", "source"),
            ("MYSQL", true) => ("snk.mysql", "sink"),
            ("ORACLE", false) => ("src.oracle", "source"),
            ("ORACLE", true) => ("snk.oracle", "sink"),
            ("MSSQL", false) => ("src.sqlserver", "source"),
            ("MSSQL", true) => ("snk.sqlserver", "sink"),
            ("POSTGRESQL", false) => ("src.postgres", "source"),
            ("POSTGRESQL", true) => ("snk.postgres", "sink"),
            _ => return None,
        }),
        _ => None,
    }
}

/// Talend stores parameter values as Java source, so a string literal arrives
/// wrapped in quotes. Strip one balanced pair; leave anything else (a bare
/// number, a `context.x` reference, an expression) untouched.
fn unquote(v: &str) -> String {
    let t = v.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// True for a value we must not copy into a pipeline file.
fn is_encrypted(v: &str) -> bool {
    v.trim_matches('"').starts_with("enc:")
}

/// `context.foo` and `context.getProperty("foo")` become Duckle's `${foo}`, so
/// an imported job keeps using a context variable rather than freezing a value.
fn rewrite_context(v: &str) -> Option<String> {
    let t = v.trim();
    if let Some(rest) = t.strip_prefix("context.getProperty(") {
        let name = rest.trim_end_matches(')').trim().trim_matches('"');
        if !name.is_empty() {
            return Some(format!("${{{name}}}"));
        }
    }
    if let Some(name) = t.strip_prefix("context.") {
        let name = name.trim();
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Some(format!("${{{name}}}"));
        }
    }
    None
}

/// Turn one Talend parameter into a Duckle property value, recording a warning
/// when the value cannot be carried across.
fn value_for(
    raw: &RawNode,
    key: &str,
    warnings: &mut Vec<Warning>,
) -> Option<JsonValue> {
    let raw_val = raw.params.get(key)?;
    if raw_val.trim().is_empty() {
        return None;
    }
    if is_encrypted(raw_val) {
        let placeholder = format!("${{ENV:{}_{}}}", raw.unique.to_uppercase(), key);
        warnings.push(Warning::EncryptedSecret {
            node: raw.unique.clone(),
            property: key.to_string(),
            placeholder: placeholder.clone(),
        });
        return Some(JsonValue::String(placeholder));
    }
    if let Some(ctx) = rewrite_context(raw_val) {
        return Some(JsonValue::String(ctx));
    }
    let v = unquote(raw_val);
    if v.is_empty() {
        return None;
    }
    Some(JsonValue::String(v))
}

/// Copy `(talend_key, duckle_key)` pairs into a property map.
fn copy_params(
    raw: &RawNode,
    pairs: &[(&str, &str)],
    props: &mut JsonMap<String, JsonValue>,
    warnings: &mut Vec<Warning>,
) {
    for (from, to) in pairs {
        if let Some(v) = value_for(raw, from, warnings) {
            props.insert((*to).to_string(), v);
        }
    }
}

/// Build the Duckle property map for one mapped node.
fn properties_for(
    raw: &RawNode,
    component_id: &str,
    context: &BTreeMap<String, String>,
    warnings: &mut Vec<Warning>,
) -> JsonMap<String, JsonValue> {
    let mut props = JsonMap::new();
    match component_id {
        "code.sql" if raw.component.starts_with("tJava") => {
            let mut only_prints = false;
            // Keep the Java on the node so whoever writes the SQL can see what
            // it has to do, and leave `sql` empty so the node cannot be mistaken
            // for one that works.
            if let Some(code) = raw
                .params
                .get("CODE")
                .filter(|c| !c.trim().is_empty())
                .map(|c| unquote(c))
            {
                only_prints = java_body_only_prints(&code);
                props.insert("untranslatedSource".into(), JsonValue::String(code));
            }
            warnings.push(Warning::JavaBody { node: raw.unique.clone(), only_prints });
        }
        "code.sql" => {
            // The statement lives in the tcomp blob for a generic component and
            // in a flat parameter for a family-specific one, so try both before
            // giving up. Left unquoted: it is SQL, not a Java string literal.
            let sql = tcomp_blob(raw)
                .and_then(|b| tcomp_value(&b, "query"))
                .or_else(|| raw.params.get("QUERY").map(|v| unquote(v)))
                .or_else(|| raw.params.get("SQLQUERY").map(|v| unquote(v)));
            match sql.filter(|q| !q.trim().is_empty()) {
                Some(q) => {
                    props.insert("sql".into(), JsonValue::String(q));
                }
                None => warnings.push(Warning::RepositoryConnection {
                    node: raw.unique.clone(),
                    component: raw.component.clone(),
                }),
            }
        }
        "xf.text.tocolumns" => {
            copy_params(
                raw,
                &[("FIELD", "column"), ("FIELDSEPARATOR", "delimiter")],
                &mut props,
                warnings,
            );
            // The output names come from the node's declared schema rather than
            // a parameter: the split produces one column per declared field.
            if !raw.columns.is_empty() {
                props.insert(
                    "outputColumns".into(),
                    JsonValue::String(raw.columns.join(",")),
                );
            }
        }
        "qa.unique" => {
            // The key columns are a TABLE parameter: one row per column, with a
            // flag saying whether it takes part in the key. Reading only flat
            // parameters left this unset, so the node failed validation for a
            // setting that was in the file all along.
            let keys: Vec<JsonValue> = raw
                .tables
                .get("UNIQUE_KEY")
                .map(|rows| {
                    rows.iter()
                        .filter(|r| {
                            r.get("KEY_ATTRIBUTE")
                                .map(|v| v.eq_ignore_ascii_case("true"))
                                .unwrap_or(false)
                        })
                        .filter_map(|r| r.get("SCHEMA_COLUMN"))
                        .map(|c| JsonValue::String(unquote(c)))
                        .collect()
                })
                .unwrap_or_default();
            if !keys.is_empty() {
                props.insert("columns".into(), JsonValue::Array(keys));
            }
        }
        "ctl.iterate" => {
            // A counted loop runs from FROM to TO inclusive. Either bound may be
            // a context reference rather than a number, and a reference cannot
            // be turned into a count here, so it is passed through for the run
            // to resolve rather than guessed at.
            let num = |k: &str| -> Option<i64> {
                raw.params.get(k).and_then(|v| unquote(v).trim().parse().ok())
            };
            match (num("FROM"), num("TO")) {
                (Some(from), Some(to)) if to >= from => {
                    let step = num("STEP").filter(|s| *s > 0).unwrap_or(1);
                    let count = ((to - from) / step) + 1;
                    props.insert("count".into(), JsonValue::from(count));
                }
                _ => {
                    if let Some(to) = raw.params.get("TO") {
                        let name = unquote(to);
                        let name = name.strip_prefix("context.").unwrap_or(&name).to_string();
                        // The job carries its own context, so a bound written as
                        // context.NAME is resolvable here. Falling back to a
                        // placeholder leaves a pipeline that cannot run alone.
                        match context.get(&name).map(|v| unquote(v)) {
                            Some(v) if v.trim().parse::<i64>().is_ok() => {
                                props.insert("count".into(), JsonValue::String(v.trim().to_string()));
                            }
                            _ => {
                                props.insert(
                                    "count".into(),
                                    JsonValue::String(format!("${{{}}}", name)),
                                );
                            }
                        }
                    }
                    warnings.push(Warning::RepositoryConnection {
                        node: raw.unique.clone(),
                        component: "loop bound is a context value, not a number".into(),
                    });
                }
            }
        }
        "ctl.file" => {
            // Talend spells a move as "copy, then remove the source".
            let removing = raw
                .params
                .get("REMOVE_FILE")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let op = if raw.component == "tFileArchive" {
                "archive"
            } else if raw.component == "tFileDelete" {
                "delete"
            } else if removing {
                "move"
            } else {
                "copy"
            };
            props.insert("op".into(), JsonValue::String(op.into()));
            copy_params(
                raw,
                &[
                    ("FILENAME", "source"),
                    ("DESTINATION", "destination"),
                    ("REPLACE_FILE", "overwrite"),
                    ("FAILON", "failOnError"),
                    // The archive component spells the same two differently.
                    ("SOURCE_FILE", "source"),
                    ("TARGET", "destination"),
                    ("OVERWRITE", "overwrite"),
                ],
                &mut props,
                warnings,
            );
        }
        "src.filelist" => copy_params(
            raw,
            &[
                ("DIRECTORY", "directory"),
                ("EXCLUDEFILEMASK", "exclude"),
                ("FILE_NAME", "path"),
            ],
            &mut props,
            warnings,
        ),
        "snk.email" => copy_params(
            raw,
            &[
                ("SMTP_HOST", "host"),
                ("SMTP_PORT", "port"),
                ("FROM", "fromAddress"),
                ("TO", "to"),
                ("SUBJECT", "subject"),
                ("MESSAGE", "body"),
                ("AUTH_USERNAME", "user"),
                ("AUTH_PASSWORD", "password"),
            ],
            &mut props,
            warnings,
        ),
        "src.snowflake" | "snk.snowflake" => {
            // A shared tSnowflakeConnection is mirrored into the node's own blob
            // under referencedComponent.reference, so read that first and fall
            // back to the node's inline connection.
            let blob = match tcomp_blob(raw) {
                Some(b) => b,
                None => {
                    warnings.push(Warning::RepositoryConnection {
                        node: raw.unique.clone(),
                        component: raw.component.clone(),
                    });
                    JsonValue::Null
                }
            };
            let pick = |leaf: &str| -> Option<String> {
                tcomp_value(&blob, &format!("connection.referencedComponent.reference.{leaf}"))
                    .or_else(|| tcomp_value(&blob, &format!("connection.{leaf}")))
            };
            for (leaf, prop) in [
                ("account", "account"),
                ("db", "database"),
                ("schemaName", "schema"),
                ("warehouse", "warehouse"),
                ("role", "role"),
                ("userPassword.userId", "username"),
            ] {
                if let Some(v) = pick(leaf) {
                    props.insert(prop.into(), JsonValue::String(v));
                }
            }
            if let Some(t) = tcomp_value(&blob, "table.tableName") {
                props.insert("tableName".into(), JsonValue::String(unquote(&t)));
            }
            if let Some(q) = tcomp_value(&blob, "query") {
                if component_id == "src.snowflake" && !q.trim().is_empty() {
                    props.insert("query".into(), JsonValue::String(unquote(&q)));
                }
            }
            // The password is Studio-encrypted and cannot be recovered here, so
            // name it as a placeholder rather than importing a value that would
            // fail at run time with no explanation.
            // The legacy component signs in with a user name and a password.
            // Duckle reaches Snowflake over the SQL API, which takes a token or
            // a key pair and has no password mode, so a password cannot be
            // carried across even if it were recoverable - and it is not, being
            // encrypted with a Studio key. Name the token the connection needs
            // and say why, rather than emitting a node that cannot authenticate.
            let placeholder = format!("${{ENV:{}_TOKEN}}", raw.unique.to_uppercase());
            props.insert("pat".into(), JsonValue::String(placeholder.clone()));
            warnings.push(Warning::EncryptedSecret {
                node: raw.unique.clone(),
                property: "pat".into(),
                placeholder,
            });
        }
        "src.mysql" | "snk.mysql" | "src.postgres" | "snk.postgres" => copy_params(
            raw,
            &[
                ("HOST", "host"),
                ("PORT", "port"),
                ("DBNAME", "database"),
                ("USER", "username"),
                ("PASS", "password"),
                ("TABLE", "tableName"),
            ],
            &mut props,
            warnings,
        ),
        "src.sqlserver" | "snk.sqlserver" => copy_params(
            raw,
            &[
                ("HOST", "host"),
                ("PORT", "port"),
                ("DBNAME", "database"),
                ("USER", "user"),
                ("PASS", "password"),
                ("DB_SCHEMA", "schema"),
                ("TABLE", "tableName"),
            ],
            &mut props,
            warnings,
        ),
        "src.oracle" | "snk.oracle" => {
            copy_params(
                raw,
                &[("USER", "user"), ("PASS", "password"), ("TABLE", "tableName")],
                &mut props,
                warnings,
            );
            // src.oracle wants one `connect` string rather than host/port/SID.
            let host = raw.params.get("HOST").map(|v| unquote(v)).unwrap_or_default();
            let port = raw.params.get("PORT").map(|v| unquote(v)).unwrap_or_default();
            let sid = raw
                .params
                .get("SID")
                .or_else(|| raw.params.get("SERVICE_NAME"))
                .or_else(|| raw.params.get("DBNAME"))
                .map(|v| unquote(v))
                .unwrap_or_default();
            if !host.is_empty() && !sid.is_empty() {
                let port = if port.is_empty() { "1521".to_string() } else { port };
                props.insert("connect".into(), JsonValue::String(format!("{host}:{port}/{sid}")));
            }
        }
        "src.csv" | "snk.csv" => {
            copy_params(raw, &[("FILENAME", "path")], &mut props, warnings);
            if let Some(sep) = value_for(raw, "FIELDSEPARATOR", warnings) {
                props.insert("delimiter".into(), sep);
            }
            // Talend counts header ROWS; Duckle asks whether there is a header.
            if let Some(h) = raw.params.get("HEADER") {
                let n: i64 = unquote(h).parse().unwrap_or(0);
                props.insert("hasHeader".into(), JsonValue::Bool(n > 0));
                if n > 1 {
                    props.insert("skipLines".into(), JsonValue::from(n - 1));
                }
            }
        }
        "src.excel" | "snk.excel" => {
            copy_params(raw, &[("FILENAME", "path")], &mut props, warnings);
        }
        "ctl.runjob" => {
            copy_params(raw, &[("PROCESS", "pipelineRef")], &mut props, warnings);
            // PROCESS holds the child's bare name, but pipelineRef is a path to the
            // child pipeline, and every child is written as `<name>.json`. Copying the
            // name verbatim left the reference pointing at nothing.
            let with_extension = match props.get("pipelineRef") {
                Some(JsonValue::String(n)) if !n.is_empty() && !n.ends_with(".json") => {
                    Some(format!("{n}.json"))
                }
                _ => None,
            };
            if let Some(path) = with_extension {
                props.insert("pipelineRef".into(), JsonValue::String(path));
            }
            // A sub-flow carries no PROCESS parameter: it IS the name, and the
            // importer writes it out under that name.
            if !props.contains_key("pipelineRef") && is_subflow_name(&raw.component) {
                props.insert(
                    "pipelineRef".into(),
                    JsonValue::String(format!("{}.json", raw.component)),
                );
            }
        }
        _ => {}
    }

    // A source with a hand-written query should carry it, whichever family.
    if component_id.starts_with("src.") {
        let query_key = if component_id == "src.mysql" || component_id == "src.postgres" {
            "sql"
        } else {
            "query"
        };
        if let Some(q) = value_for(raw, "QUERY", warnings) {
            let text = q.as_str().unwrap_or_default().trim().to_string();
            if !text.is_empty() {
                props.insert(query_key.to_string(), JsonValue::String(text));
                props.insert("mode".into(), JsonValue::String("query".into()));
            }
        }
    }
    props
}

/// Is every parenthesis in `s` closed in order?
fn balanced(s: &str) -> bool {
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// The arguments of `name(...)`, split on top-level commas, when the whole expression is
/// that one call.
fn call_args<'a>(e: &'a str, name: &str) -> Option<Vec<&'a str>> {
    let rest = e.strip_prefix(name)?.trim_start();
    let inner = rest.strip_prefix('(')?.strip_suffix(')')?;
    if !balanced(inner) {
        return None;
    }
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in inner.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&inner[start..]);
    Some(out)
}

/// Does every statement in a Java body just print?
///
/// Such a body has no effect on the data, so it carries no rules to port. Anything else -
/// an assignment, a context write, a call - counts as a rule, because treating one as
/// harmless is how a pipeline ends up running happily while omitting the logic.
fn java_body_only_prints(code: &str) -> bool {
    let without_block_comments = {
        let mut out = String::with_capacity(code.len());
        let mut rest = code;
        while let Some(start) = rest.find("/*") {
            out.push_str(&rest[..start]);
            match rest[start + 2..].find("*/") {
                Some(end) => rest = &rest[start + 2 + end + 2..],
                None => return false,
            }
        }
        out.push_str(rest);
        out
    };
    let source: String = without_block_comments
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("
");
    let statements: Vec<&str> =
        source.split(';').map(str::trim).filter(|s| !s.is_empty()).collect();
    !statements.is_empty()
        && statements
            .iter()
            .all(|s| s.starts_with("System.out.print") || s.starts_with("System.err.print"))
}

/// Split a Java conditional `cond ? a : b` at its own `?` and matching `:`.
///
/// A chain is right-associative, so the matching colon is the one that balances the
/// question marks after it rather than simply the next one.
fn split_ternary(e: &str) -> Option<(&str, &str, &str)> {
    let bytes = e.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut q = None;
    for (i, &c) in bytes.iter().enumerate() {
        match c {
            b'"' => in_string = !in_string,
            _ if in_string => {}
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'?' if depth == 0 => {
                q = Some(i);
                break;
            }
            _ => {}
        }
    }
    let q = q?;
    let (mut depth, mut pending, mut in_string) = (0i32, 0i32, false);
    for (i, &c) in bytes.iter().enumerate().skip(q + 1) {
        match c {
            b'"' => in_string = !in_string,
            _ if in_string => {}
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'?' if depth == 0 => pending += 1,
            b':' if depth == 0 => {
                if pending == 0 {
                    return Some((&e[..q], &e[q + 1..i], &e[i + 1..]));
                }
                pending -= 1;
            }
            _ => {}
        }
    }
    None
}

/// Translate a Java boolean to SQL. Only equality is read: an ordering would need its
/// sign checked against the comparison's contract, which is a guess we do not make.
fn java_condition_to_sql(cond: &str) -> Option<String> {
    let c = cond.trim();
    if let Some(inner) = c.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        if balanced(inner) {
            return java_condition_to_sql(inner);
        }
    }
    for (token, op) in [("==", "="), ("!=", "<>")] {
        let Some((lhs, rhs)) = c.split_once(token) else { continue };
        if !rhs.trim().eq("0") {
            continue;
        }
        let (recv, args) = method_call(lhs.trim(), "compareTo")?;
        if args.len() != 1 {
            return None;
        }
        return Some(format!(
            "{} {op} {}",
            java_expr_to_sql(recv)?,
            java_expr_to_sql(args[0])?
        ));
    }
    let (recv, args) = method_call(c, "equals")?;
    if args.len() != 1 {
        return None;
    }
    Some(format!(
        "{} = {}",
        java_expr_to_sql(recv)?,
        java_expr_to_sql(args[0])?
    ))
}

/// An optionally signed decimal number, written out in full.
fn is_number(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    !t.is_empty()
        && t.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && t.bytes().filter(|b| *b == b'.').count() <= 1
        && t.bytes().any(|b| b.is_ascii_digit())
}

/// Split `<receiver>.name(<args>)` when the whole expression is that one method call.
fn method_call<'a>(e: &'a str, name: &str) -> Option<(&'a str, Vec<&'a str>)> {
    let open = format!(".{name}(");
    let (mut depth, mut at) = (0i32, None);
    for (i, c) in e.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            '.' if depth == 0 && e[i..].starts_with(&open) => at = Some(i),
            _ => {}
        }
    }
    let i = at?;
    let args = call_args(&e[i + 1..], name)?;
    Some((&e[..i], args))
}

/// The sole argument of `name(...)`, when the whole expression is that one call.
fn single_arg<'a>(e: &'a str, name: &str) -> Option<&'a str> {
    let args = call_args(e, name)?;
    (args.len() == 1).then(|| args[0])
}

/// Translate one mapper output expression to SQL, or `None` when it needs a human.
///
/// Only forms with a single faithful SQL reading are translated. Arithmetic, branching
/// and anything whose index base is not established stay reported: guessing one of those
/// wrong produces a silently wrong number instead of a failure.
fn java_expr_to_sql(expr: &str) -> Option<String> {
    let e = expr.trim();
    if e.is_empty() {
        return None;
    }
    if e == "null" {
        return Some("NULL".to_string());
    }
    if e == "BigDecimal.ZERO" {
        return Some("0".to_string());
    }
    if e == "BigDecimal.ONE" {
        return Some("1".to_string());
    }
    if is_number(e) {
        return Some(e.to_string());
    }
    // A choice reads as a CASE, and a chain of them nests.
    if let Some((cond, yes, no)) = split_ternary(e) {
        return Some(format!(
            "CASE WHEN {} THEN {} ELSE {} END",
            java_condition_to_sql(cond)?,
            java_expr_to_sql(yes)?,
            java_expr_to_sql(no)?
        ));
    }
    if let Some(inner) = e.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        // An escape would need Java's rules, so leave those to a human.
        if !inner.contains('"') && !inner.contains('\\') {
            return Some(format!("'{}'", inner.replace('\'', "''")));
        }
    }
    if let Some(inner) = e.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        if balanced(inner) {
            return java_expr_to_sql(inner);
        }
    }
    if let Some(head) = e.strip_suffix(".toString()") {
        return java_expr_to_sql(head);
    }
    if let Some(arg) = single_arg(e, "Double.valueOf") {
        return Some(format!("TRY_CAST({} AS DOUBLE)", java_expr_to_sql(arg)?));
    }
    if let Some(arg) = single_arg(e, "new BigDecimal") {
        let inner = arg.trim();
        // The double-valued form goes through a double in Java, so DOUBLE is faithful.
        if single_arg(inner, "Double.valueOf").is_some() {
            return java_expr_to_sql(inner);
        }
        // A quoted number is an exact decimal, and the literal already carries its own
        // scale, so writing it through keeps that rather than inventing a cast.
        if let Some(lit) = inner.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            if is_number(lit) {
                return Some(lit.to_string());
            }
        }
        // `new BigDecimal(reference)` reads as an exact decimal or a double depending on
        // the reference's Java type, which the job file does not record.
        return None;
    }
    if let Some(arg) = single_arg(e, "StringHandling.TRIM") {
        return Some(format!("trim({})", java_expr_to_sql(arg)?));
    }
    // The character helpers. SUBSTR takes a start and a length counted from 1, the same
    // as SQL, rather than Java's begin/end: a reference migration of this dialect renders
    // it verbatim as SUBSTR and its output matches the SQL reading on every row. The
    // counts must be plain integers, since a computed one would be a Java expression.
    for (name, sql_fn, arity) in [
        ("StringHandling.LEFT", "left", 2),
        ("StringHandling.RIGHT", "right", 2),
        ("StringHandling.SUBSTR", "substr", 3),
    ] {
        let Some(args) = call_args(e, name) else { continue };
        if args.len() != arity {
            return None;
        }
        let subject = java_expr_to_sql(args[0])?;
        let counts = args[1..]
            .iter()
            .map(|a| {
                let t = a.trim();
                (!t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())).then_some(t)
            })
            .collect::<Option<Vec<_>>>()?;
        return Some(format!("{sql_fn}({subject}, {})", counts.join(", ")));
    }
    // Sign-changing arithmetic on an exact decimal, which SQL does the same way.
    if let Some(recv) = e.strip_suffix(".negate()") {
        return Some(format!("-({})", java_expr_to_sql(recv)?));
    }
    for (name, op) in [("multiply", "*"), ("subtract", "-"), ("add", "+")] {
        let Some((recv, args)) = method_call(e, name) else { continue };
        if args.len() != 1 {
            return None;
        }
        return Some(format!(
            "({}) {op} ({})",
            java_expr_to_sql(recv)?,
            java_expr_to_sql(args[0])?
        ));
    }
    if let Some(arg) = single_arg(e, "String.valueOf") {
        return Some(format!("CAST({} AS VARCHAR)", java_expr_to_sql(arg)?));
    }
    // `Table.Column`, the only bare form that reads one way.
    let (table, column) = e.split_once('.')?;
    let ident = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_');
    (ident(table) && ident(column)).then(|| column.to_string())
}

/// Translate mapper output expressions. Anything without one faithful SQL reading is
/// reported rather than guessed at.
fn mapper_expressions(raw: &RawNode, warnings: &mut Vec<Warning>) -> JsonValue {
    let mut out = JsonMap::new();
    for (col, expr) in &raw.mapper_out {
        let e = expr.trim();
        if e.is_empty() {
            continue;
        }
        match java_expr_to_sql(e) {
            Some(c) => {
                out.insert(col.clone(), JsonValue::String(c));
            }
            None => warnings.push(Warning::JavaExpression {
                node: raw.unique.clone(),
                column: col.clone(),
                expression: e.to_string(),
            }),
        }
    }
    JsonValue::Object(out)
}

/// Read one Talend `.item` file.
pub fn import_item(xml: &str, job_name: &str) -> Result<Import, String> {
    let (raw_nodes, connections, context) = parse(xml)?;

    let mut components: BTreeMap<String, usize> = BTreeMap::new();
    for n in &raw_nodes {
        *components.entry(n.component.clone()).or_default() += 1;
    }

    let mut warnings = Vec::new();
    let mut nodes = Vec::new();

    for raw in &raw_nodes {
        // A repository connection means the credentials are not in this file.
        if raw.params.get("PROPERTY:PROPERTY_TYPE").map(|s| s.as_str()) == Some("REPOSITORY") {
            warnings.push(Warning::RepositoryConnection {
                node: raw.unique.clone(),
                component: raw.component.clone(),
            });
        }

        let (component_id, flow_type) = match map_component(raw) {
            Some(hit) => hit,
            None => {
                warnings.push(Warning::UnmappedComponent {
                    node: raw.unique.clone(),
                    component: raw.component.clone(),
                });
                // Import it as a labelled placeholder so the shape of the job
                // survives and the gap is visible on the canvas.
                nodes.push(PipelineNode {
                    id: raw.unique.clone(),
                    flow_type: Some("transform".into()),
                    position: Position { x: raw.x, y: raw.y },
                    data: node_data(format!("{} (unmapped)", raw.component), None, None),
                });
                continue;
            }
        };

        let mut props = properties_for(raw, component_id, &context, &mut warnings);
        if component_id == "xf.map" {
            props.insert("expressions".into(), mapper_expressions(raw, &mut warnings));
        }

        nodes.push(PipelineNode {
            id: raw.unique.clone(),
            flow_type: Some(flow_type.into()),
            position: Position { x: raw.x, y: raw.y },
            data: node_data(
                raw.unique.clone(),
                Some(component_id.into()),
                Some(JsonValue::Object(props)),
            ),
        });
    }

    let known: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    // A join takes a second row-carrying input on its LOOKUP port, not a second
    // main. Sending both to `main` reads as two upstreams feeding one input,
    // which the planner refuses. Only the first row link into a node is main;
    // the rest are lookups, in the order the file lists them.
    let mut seen_main: std::collections::HashSet<&str> = Default::default();
    let mut target_port: std::collections::HashMap<usize, &'static str> = Default::default();
    for (i, c) in connections.iter().enumerate() {
        if connection_type_for(c.connector.as_deref()) != "main" {
            continue;
        }
        if !known.contains(c.source.as_str()) || !known.contains(c.target.as_str()) {
            continue;
        }
        let port = if seen_main.insert(c.target.as_str()) {
            "main"
        } else {
            "lookup"
        };
        target_port.insert(i, port);
    }
    let edges = connections
        .iter()
        .enumerate()
        // Drop dangling links rather than emit an edge to a node that is not
        // in the file; a dangling edge fails to compile with a worse message.
        .filter(|(_, c)| known.contains(c.source.as_str()) && known.contains(c.target.as_str()))
        .map(|(i, c)| PipelineEdge {
            id: format!("e{}", i + 1),
            source: c.source.clone(),
            target: c.target.clone(),
            source_handle: Some("main".into()),
            target_handle: Some(target_port.get(&i).copied().unwrap_or("main").into()),
            edge_type: None,
            data: Some(EdgeData {
                connection_type: connection_type_for(c.connector.as_deref()).into(),
                label: None,
                condition: None,
            }),
        })
        .collect();

    // A loop's body is inline in the source job; Duckle runs a child pipeline by
    // reference, so lift each body out and point its loop at the new file.
    let mut nodes = nodes;
    let mut edges = edges;
    let mut warnings = warnings;
    let children = extract_loop_bodies(job_name, &mut nodes, &mut edges, &mut warnings);

    Ok(Import {
        name: job_name.to_string(),
        nodes,
        edges,
        warnings,
        components,
        children,
    })
}

/// `NodeData` has no `Default`, and an imported node only ever sets three of
/// its fields, so build it in one place rather than spelling out the rest twice.
fn node_data(label: String, component_id: Option<String>, properties: Option<JsonValue>) -> NodeData {
    NodeData {
        label,
        subtitle: None,
        component_id,
        properties,
        schema: None,
        sample_rows: None,
        disabled: None,
        alias: None,
    }
}

struct Conn {
    source: String,
    target: String,
    /// Talend's `connectorName`. It says whether a link carries rows or only
    /// ordering, and dropping it turned every trigger into a data dependency.
    connector: Option<String>,
}

/// Lift each loop's body out into a pipeline of its own and point the loop at it.
///
/// A legacy job expresses a loop by hanging its body off an iterate link inside
/// the same job. Duckle's loop components run a child pipeline by reference, so
/// an imported loop had no body to run and refused to compile for want of one.
///
/// Only a body that belongs solely to the loop is lifted. If any node in it is
/// also fed from outside the loop, moving it would silently cut the main flow,
/// so the loop is left alone and the job says so instead. Extracting the wrong
/// subgraph is worse than not extracting it.
fn extract_loop_bodies(
    parent_name: &str,
    nodes: &mut Vec<PipelineNode>,
    edges: &mut Vec<PipelineEdge>,
    warnings: &mut Vec<Warning>,
) -> Vec<Import> {
    let loops: Vec<String> = nodes
        .iter()
        .filter(|n| {
            matches!(
                n.data.component_id.as_deref(),
                Some("ctl.foreach") | Some("ctl.iterate")
            )
        })
        .map(|n| n.id.clone())
        .collect();

    let mut children = Vec::new();
    for loop_id in loops {
        // The body starts at whatever the loop's iterate link points to.
        let entries: Vec<String> = edges
            .iter()
            .filter(|e| {
                e.source == loop_id
                    && e.data.as_ref().map(|d| d.connection_type.as_str()) == Some("iterate")
            })
            .map(|e| e.target.clone())
            .collect();
        if entries.is_empty() {
            continue;
        }

        // Everything reachable from those entries, not passing back through the
        // loop itself.
        let mut body: std::collections::HashSet<String> = Default::default();
        let mut queue = entries.clone();
        while let Some(id) = queue.pop() {
            if id == loop_id || !body.insert(id.clone()) {
                continue;
            }
            for e in edges.iter().filter(|e| e.source == id) {
                if e.target != loop_id {
                    queue.push(e.target.clone());
                }
            }
        }
        if body.is_empty() {
            continue;
        }

        // A join inside the loop reads its reference table from a source that
        // sits outside it. That source is part of the body's work, not of the
        // main flow, so pull it in - along with whatever feeds it - rather than
        // refusing a loop whose only sin is having a lookup.
        loop {
            let pull: Vec<String> = edges
                .iter()
                .filter(|e| body.contains(&e.target) && e.source != loop_id)
                .filter(|e| !body.contains(&e.source))
                .filter(|e| {
                    e.data.as_ref().map(|d| d.connection_type.as_str()) == Some("lookup")
                        || e.target_handle.as_deref() == Some("lookup")
                })
                .map(|e| e.source.clone())
                .collect();
            // Only if nothing outside the body still reads it: moving a source
            // the main flow also uses would cut the parent.
            let safe: Vec<String> = pull
                .into_iter()
                .filter(|src| {
                    !edges.iter().any(|e| {
                        e.source == *src && !body.contains(&e.target) && e.target != loop_id
                    })
                })
                .collect();
            if safe.is_empty() {
                break;
            }
            for id in safe {
                let mut q = vec![id];
                while let Some(x) = q.pop() {
                    if x == loop_id || !body.insert(x.clone()) {
                        continue;
                    }
                    for e in edges.iter().filter(|e| e.target == x) {
                        q.push(e.source.clone());
                    }
                }
            }
        }

        // Refuse if anything in the body is still fed from outside it: that is a
        // step the main flow shares, and moving it would cut the parent.
        let fed_from_outside = edges.iter().any(|e| {
            body.contains(&e.target) && e.source != loop_id && !body.contains(&e.source)
        });
        if fed_from_outside {
            warnings.push(Warning::RepositoryConnection {
                node: loop_id.clone(),
                component: "loop body shared with the main flow".into(),
            });
            continue;
        }

        let child_name = format!("{}__{}", parent_name, loop_id);
        let mut child_nodes: Vec<PipelineNode> = nodes
            .iter()
            .filter(|n| body.contains(&n.id))
            .cloned()
            .collect();
        let mut child_edges: Vec<PipelineEdge> = edges
            .iter()
            .filter(|e| body.contains(&e.source) && body.contains(&e.target))
            .cloned()
            .collect();

        // A body can contain a loop of its own. Lift those too, and hand them
        // back alongside this one: names carry their whole ancestry, so they
        // stay distinct however deeply they nest.
        let nested = extract_loop_bodies(&child_name, &mut child_nodes, &mut child_edges, warnings);

        // The parent keeps the loop and loses the body.
        nodes.retain(|n| !body.contains(&n.id));
        edges.retain(|e| !body.contains(&e.source) && !body.contains(&e.target));

        // Point the loop at the file the body is about to become.
        if let Some(l) = nodes.iter_mut().find(|n| n.id == loop_id) {
            let props = l
                .data
                .properties
                .get_or_insert_with(|| JsonValue::Object(Default::default()));
            if let Some(map) = props.as_object_mut() {
                map.insert(
                    "pipelineRef".into(),
                    JsonValue::String(format!("{}.json", child_name)),
                );
            }
        }

        children.extend(nested);
        children.push(Import {
            name: child_name,
            nodes: child_nodes,
            edges: child_edges,
            warnings: Vec::new(),
            components: BTreeMap::new(),
            children: Vec::new(),
        });
    }
    children
}

/// Talend's connector name mapped to the edge vocabulary the canvas draws.
///
/// Talend links are not all data: most of them order the job rather than feed
/// it. Importing them all as `main` asserted a data dependency that the job
/// never had, which is both wrong on the canvas and wrong to the planner. The
/// row-carrying names become `main`; the rest keep their own meaning.
///
/// PARALLELIZE and SYNCHRONIZE have no exact counterpart. Both mean "after
/// this", so they import as `on-subjob-ok`: the ordering survives and the
/// parallelism does not, which is the honest half to keep. An unrecognised
/// name stays `main` rather than becoming a trigger nobody asked for.
fn connection_type_for(connector: Option<&str>) -> &'static str {
    match connector.unwrap_or("").to_ascii_uppercase().as_str() {
        "ITERATE" => "iterate",
        "RUN_IF" => "run-if",
        "SUBJOB_OK" => "on-subjob-ok",
        "SUBJOB_ERROR" => "on-subjob-error",
        "COMPONENT_OK" => "on-component-ok",
        "COMPONENT_ERROR" => "on-component-error",
        "PARALLELIZE" | "SYNCHRONIZE" => "on-subjob-ok",
        _ => "main",
    }
}

/// Pull `<node>`, its `<elementParameter>`s, its mapper output entries, and the
/// `<connection>` list out of the job XML.
fn parse(xml: &str) -> Result<(Vec<RawNode>, Vec<Conn>, BTreeMap<String, String>), String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut nodes: Vec<RawNode> = Vec::new();
    let mut conns: Vec<Conn> = Vec::new();
    let mut cur: Option<RawNode> = None;
    // Mapper entries are only outputs when we are inside <outputTables>.
    let mut in_output_table = false;
    // The TABLE parameter whose rows we are currently collecting, if any.
    let mut table_param: Option<String> = None;
    let mut in_flow_metadata = false;
    // The job's own context parameters. A bound or a table name written as
    // context.NAME is resolvable from here, and leaving it unresolved is what
    // stopped an imported loop from compiling on its own.
    let mut context: BTreeMap<String, String> = BTreeMap::new();
    let mut buf = Vec::new();

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("talend import: malformed XML at {}: {e}", reader.buffer_position()))?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = e.local_name();
                let tag = String::from_utf8_lossy(name.as_ref()).to_string();
                // Values must be unescaped: Talend stores Java string literals,
                // so the quotes arrive as `&quot;` and a raw read would leave
                // `&quot;localhost&quot;` where `localhost` belongs.
                let attr = |k: &str| -> Option<String> {
                    e.attributes().flatten().find_map(|a| {
                        (a.key.local_name().as_ref() == k.as_bytes()).then(|| {
                            a.unescape_value()
                                .map(|v| v.into_owned())
                                .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).to_string())
                        })
                    })
                };
                match tag.as_str() {
                    // A joblet writes its boundary ports as `jobletNodes`. They carry a
                    // component and a name like any other node and connections reference
                    // them, so reading only `node` drops the port and the link with it.
                    "node" | "jobletNodes" => {
                        if let Some(done) = cur.take() {
                            nodes.push(done);
                        }
                        cur = Some(RawNode {
                            component: attr("componentName").unwrap_or_default(),
                            unique: String::new(),
                            columns: Vec::new(),
                            tables: BTreeMap::new(),
                            params: BTreeMap::new(),
                            mapper_out: Vec::new(),
                            x: attr("posX").and_then(|v| v.parse().ok()).unwrap_or(0.0),
                            y: attr("posY").and_then(|v| v.parse().ok()).unwrap_or(0.0),
                        });
                        in_output_table = false;
                    }
                    "elementParameter" => {
                        if let (Some(n), Some(k)) = (cur.as_mut(), attr("name")) {
                            let v = attr("value").unwrap_or_default();
                            if k == "UNIQUE_NAME" {
                                n.unique = v.clone();
                            }
                            // A TABLE parameter carries its rows as the
                            // elementValue children that follow it.
                            if attr("field").as_deref() == Some("TABLE") {
                                table_param = Some(k.clone());
                                n.tables.entry(k.clone()).or_default();
                            } else {
                                table_param = None;
                            }
                            n.params.insert(k, v);
                        }
                    }
                    // One row per repeat of the first field seen: the ids run
                    // straight through the whole table rather than restarting.
                    "elementValue" => {
                        if let (Some(n), Some(tp)) = (cur.as_mut(), table_param.clone()) {
                            if let (Some(field), Some(v)) = (attr("elementRef"), attr("value")) {
                                let rows = n.tables.entry(tp).or_default();
                                let start_new = rows
                                    .last()
                                    .map(|r| r.contains_key(&field))
                                    .unwrap_or(true);
                                if start_new {
                                    rows.push(BTreeMap::new());
                                }
                                if let Some(r) = rows.last_mut() {
                                    r.insert(field, v);
                                }
                            }
                        }
                    }
                    // A node declares one schema per connector; the main output
                    // is the FLOW one. Reject and other connectors describe
                    // different shapes and must not be mixed into it.
                    "contextParameter" => {
                        if let (Some(k), Some(v)) = (attr("name"), attr("value")) {
                            // First definition wins: a job repeats its context
                            // once per environment and the default comes first.
                            context.entry(k).or_insert(v);
                        }
                    }
                    "metadata" => {
                        in_flow_metadata = attr("connector").as_deref() == Some("FLOW");
                    }
                    "column" => {
                        if in_flow_metadata {
                            if let (Some(n), Some(c)) = (cur.as_mut(), attr("name")) {
                                n.columns.push(c);
                            }
                        }
                    }
                    "outputTables" => in_output_table = true,
                    "inputTables" | "varTables" => in_output_table = false,
                    "mapperTableEntries" => {
                        if in_output_table {
                            if let (Some(n), Some(col)) = (cur.as_mut(), attr("name")) {
                                if let Some(expr) = attr("expression") {
                                    n.mapper_out.push((col, expr));
                                }
                            }
                        }
                    }
                    "connection" => {
                        if let (Some(s), Some(t)) = (attr("source"), attr("target")) {
                            conns.push(Conn {
                                source: s,
                                target: t,
                                connector: attr("connectorName"),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Event::End(ref e) => {
                let name = e.local_name();
                if name.as_ref() == b"node" || name.as_ref() == b"jobletNodes" {
                    if let Some(done) = cur.take() {
                        nodes.push(done);
                    }
                } else if name.as_ref() == b"outputTables" {
                    in_output_table = false;
                }
            }
            _ => {}
        }
        buf.clear();
    }
    if let Some(done) = cur.take() {
        nodes.push(done);
    }

    // A node with no UNIQUE_NAME cannot be referenced by a connection; fall
    // back to the component name plus an index so the import still holds.
    for (i, n) in nodes.iter_mut().enumerate() {
        if n.unique.is_empty() {
            n.unique = format!("{}_{}", n.component, i + 1);
        }
    }
    Ok((nodes, conns, context))
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_loop_body_moves_into_its_own_pipeline_and_the_loop_names_it() {
        // A legacy job writes a loop's body inline. Duckle runs a child pipeline
        // by reference, so the body has to become a file and the loop has to
        // name it, or the loop compiles to nothing to run.
        let mut nodes = vec![
            imported_node("root", "src.csv", 0.0, 0.0),
            imported_node("loop", "ctl.foreach", 1.0, 0.0),
            imported_node("body1", "xf.filter", 2.0, 0.0),
            imported_node("body2", "snk.parquet", 3.0, 0.0),
        ];
        let mut edges = vec![
            test_edge("e1", "root", "loop", "main"),
            test_edge("e2", "loop", "body1", "iterate"),
            test_edge("e3", "body1", "body2", "main"),
        ];
        let mut warnings = Vec::new();
        let kids = extract_loop_bodies("job", &mut nodes, &mut edges, &mut warnings);

        assert_eq!(kids.len(), 1, "one loop, one body");
        let kid = &kids[0];
        assert_eq!(kid.nodes.len(), 2, "the body moved wholesale");
        assert_eq!(kid.edges.len(), 1, "and kept its internal wiring");

        // The parent keeps the loop and loses the body.
        let left: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(left, vec!["root", "loop"]);
        assert_eq!(edges.len(), 1, "only the link into the loop remains");

        // And the loop names the file the body became.
        let r = nodes[1].data.properties.as_ref().unwrap()["pipelineRef"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(r, format!("{}.json", kid.name));
    }

    #[test]
    fn a_lookup_feeding_the_loop_body_travels_with_it() {
        // A join inside a loop reads its reference table from a source outside
        // it. That source is part of the body's work, not the main flow's, so
        // refusing to lift the loop over it would strand a whole job.
        let mut nodes = vec![
            imported_node("loop", "ctl.foreach", 0.0, 0.0),
            imported_node("join", "xf.map", 1.0, 0.0),
            imported_node("ref", "src.snowflake", 2.0, 0.0),
        ];
        let mut edges = vec![
            test_edge("e1", "loop", "join", "iterate"),
            test_edge("e2", "ref", "join", "lookup"),
        ];
        let mut warnings = Vec::new();
        let kids = extract_loop_bodies("job", &mut nodes, &mut edges, &mut warnings);

        assert_eq!(kids.len(), 1, "the loop should still lift");
        let ids: Vec<&str> = kids[0].nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"join") && ids.contains(&"ref"),
                "the lookup source travels with the body, got {:?}", ids);
        assert_eq!(nodes.len(), 1, "only the loop stays behind");
    }

    #[test]
    fn a_lookup_the_main_flow_also_reads_is_left_where_it_is() {
        // Moving a source the parent still reads would cut the parent, so the
        // loop is refused rather than the reference stolen from under it.
        let mut nodes = vec![
            imported_node("loop", "ctl.foreach", 0.0, 0.0),
            imported_node("join", "xf.map", 1.0, 0.0),
            imported_node("ref", "src.snowflake", 2.0, 0.0),
            imported_node("other", "snk.csv", 3.0, 0.0),
        ];
        let mut edges = vec![
            test_edge("e1", "loop", "join", "iterate"),
            test_edge("e2", "ref", "join", "lookup"),
            test_edge("e3", "ref", "other", "main"),
        ];
        let mut warnings = Vec::new();
        let kids = extract_loop_bodies("job", &mut nodes, &mut edges, &mut warnings);
        assert!(kids.is_empty(), "nothing should have been lifted");
        assert_eq!(nodes.len(), 4, "the parent is untouched");
    }

    #[test]
    fn a_loop_body_shared_with_the_main_flow_is_left_alone() {
        // Moving a node that the main flow also feeds would silently cut the
        // parent. Refusing and saying so beats extracting the wrong subgraph.
        let mut nodes = vec![
            imported_node("root", "src.csv", 0.0, 0.0),
            imported_node("loop", "ctl.foreach", 1.0, 0.0),
            imported_node("shared", "xf.filter", 2.0, 0.0),
        ];
        let mut edges = vec![
            test_edge("e1", "loop", "shared", "iterate"),
            test_edge("e2", "root", "shared", "main"),
        ];
        let mut warnings = Vec::new();
        let kids = extract_loop_bodies("job", &mut nodes, &mut edges, &mut warnings);

        assert!(kids.is_empty(), "nothing should have been lifted");
        assert_eq!(nodes.len(), 3, "the parent is untouched");
        assert_eq!(warnings.len(), 1, "and the job says why");
        assert!(
            nodes[1].data.properties.as_ref().map_or(true, |p| p.get("pipelineRef").is_none()),
            "a loop with no lifted body must not name a file that was never written"
        );
    }

    fn imported_node(id: &str, component: &str, x: f64, y: f64) -> PipelineNode {
        PipelineNode {
            id: id.into(),
            flow_type: Some("transform".into()),
            position: Position { x, y },
            data: node_data(id.into(), Some(component.into()), None),
        }
    }

    fn test_edge(id: &str, from: &str, to: &str, kind: &str) -> PipelineEdge {
        PipelineEdge {
            id: id.into(),
            source: from.into(),
            target: to.into(),
            source_handle: Some("main".into()),
            target_handle: Some("main".into()),
            edge_type: None,
            data: Some(EdgeData {
                connection_type: kind.into(),
                label: None,
                condition: None,
            }),
        }
    }

    #[test]
    fn tcomp_reads_scalars_enums_and_booleans_from_the_properties_blob() {
        // A generic Talend component keeps its whole configuration in one JSON
        // document. Scalars sit at storedValue; booleans wrap it in an object
        // with `value`; enums wrap it in an object with `name` and NO `value`.
        // Reading `value` everywhere returns nothing for the enums, which drops
        // the auth type while looking like it worked.
        let blob: JsonValue = serde_json::from_str(
            r#"{
                "connection": {
                    "account":  { "storedValue": "acct-1" },
                    "db":       { "storedValue": "DB1" },
                    "autoCommit":         { "storedValue": { "@type": "b", "value": true } },
                    "authenticationType": { "storedValue": { "@type": "e", "name": "KEY_PAIR" } },
                    "loginTimeout":       { "storedValue": { "@type": "n", "value": 30 } },
                    "sharedConnectionName": { "storedValue": null },
                    "role": { "storedValue": "" },
                    "referencedComponent": {
                        "reference": { "warehouse": { "storedValue": "WH_SHARED" } }
                    }
                },
                "table": { "tableName": { "storedValue": "T1" } }
            }"#,
        )
        .unwrap();

        assert_eq!(tcomp_value(&blob, "connection.account").as_deref(), Some("acct-1"));
        assert_eq!(tcomp_value(&blob, "connection.db").as_deref(), Some("DB1"));
        assert_eq!(tcomp_value(&blob, "table.tableName").as_deref(), Some("T1"));
        // The enum: `name`, not `value`.
        assert_eq!(
            tcomp_value(&blob, "connection.authenticationType").as_deref(),
            Some("KEY_PAIR"),
            "an enum stores its token under name; reading value loses it"
        );
        // The boolean and the number still come back.
        assert_eq!(tcomp_value(&blob, "connection.autoCommit").as_deref(), Some("true"));
        assert_eq!(tcomp_value(&blob, "connection.loginTimeout").as_deref(), Some("30"));
        // A shared connection is mirrored under referencedComponent.reference.
        assert_eq!(
            tcomp_value(&blob, "connection.referencedComponent.reference.warehouse").as_deref(),
            Some("WH_SHARED")
        );
        // Absent, null and empty are all "not set", not an empty string that
        // would overwrite a default with nothing.
        assert_eq!(tcomp_value(&blob, "connection.sharedConnectionName"), None);
        assert_eq!(tcomp_value(&blob, "connection.role"), None);
        assert_eq!(tcomp_value(&blob, "connection.nosuch"), None);
        assert_eq!(tcomp_value(&blob, "nosuch.deep.path"), None);
    }

    #[test]
    fn a_trigger_link_does_not_import_as_a_data_edge() {
        // Talend orders a job with links that carry no rows. Importing them as
        // `main` asserted a data dependency the job never had: on one corpus
        // that turned 164 ordering links and 24 iterate links into data edges.
        assert_eq!(connection_type_for(Some("FLOW")), "main");
        assert_eq!(connection_type_for(Some("MAIN")), "main");
        assert_eq!(connection_type_for(Some("ITERATE")), "iterate");
        assert_eq!(connection_type_for(Some("RUN_IF")), "run-if");
        assert_eq!(connection_type_for(Some("SUBJOB_OK")), "on-subjob-ok");
        assert_eq!(connection_type_for(Some("SUBJOB_ERROR")), "on-subjob-error");
        assert_eq!(connection_type_for(Some("COMPONENT_OK")), "on-component-ok");
        assert_eq!(connection_type_for(Some("COMPONENT_ERROR")), "on-component-error");
        // No counterpart for these two: keep the ordering, lose the parallelism.
        assert_eq!(connection_type_for(Some("PARALLELIZE")), "on-subjob-ok");
        assert_eq!(connection_type_for(Some("SYNCHRONIZE")), "on-subjob-ok");
        // A named output port still carries rows, and so does an unknown name:
        // inventing a trigger from a name we do not recognise would silently
        // cut the flow.
        assert_eq!(connection_type_for(Some("OUTPUT_1")), "main");
        assert_eq!(connection_type_for(Some("UNIQUE")), "main");
        assert_eq!(connection_type_for(None), "main");
        assert_eq!(connection_type_for(Some("")), "main");
        // Talend has written these lowercase in older exports.
        assert_eq!(connection_type_for(Some("subjob_ok")), "on-subjob-ok");
    }
    use super::*;

    const JOB: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tMSSqlInput" posX="100" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="tDBInput_1"/>
    <elementParameter field="TECHNICAL" name="PROPERTY:PROPERTY_TYPE" value="REPOSITORY"/>
    <elementParameter field="TEXT" name="HOST" value="&quot;localhost&quot;"/>
    <elementParameter field="TEXT" name="PORT" value="&quot;1433&quot;"/>
    <elementParameter field="TEXT" name="DBNAME" value="&quot;AdventureWorks&quot;"/>
    <elementParameter field="TEXT" name="USER" value="&quot;sa&quot;"/>
    <elementParameter field="PASSWORD" name="PASS" value="enc:system.encryption.key.v1:AAAA"/>
    <elementParameter field="DBTABLE" name="TABLE" value="&quot;Location&quot;"/>
  </node>
  <node componentName="tMap" posX="300" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="tMap_1"/>
    <outputTables name="dim_location">
      <mapperTableEntries name="LocationID" expression="Location.LocationID"/>
      <mapperTableEntries name="DI_Created_Date" expression="TalendDate.getCurrentDate()"/>
    </outputTables>
  </node>
  <node componentName="tSomethingExotic" posX="500" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="tExotic_1"/>
  </node>
  <connection connectorName="FLOW" source="tDBInput_1" target="tMap_1" label="Location"/>
  <connection connectorName="FLOW" source="tMap_1" target="tExotic_1" label="out"/>
</talendfile:ProcessType>"#;

    #[test]
    fn maps_the_component_head_and_wires_the_flow() {
        let im = import_item(JOB, "dim_location").expect("parses");
        assert_eq!(im.nodes.len(), 3);
        assert_eq!(im.edges.len(), 2);
        let src = &im.nodes[0];
        assert_eq!(src.id, "tDBInput_1");
        assert_eq!(src.data.component_id.as_deref(), Some("src.sqlserver"));
        let p = src.data.properties.as_ref().unwrap();
        assert_eq!(p["host"], "localhost");
        assert_eq!(p["database"], "AdventureWorks");
        assert_eq!(p["tableName"], "Location");
    }

    #[test]
    fn an_encrypted_password_becomes_a_placeholder_not_a_guess() {
        let im = import_item(JOB, "j").unwrap();
        let p = im.nodes[0].data.properties.as_ref().unwrap();
        // Never the ciphertext, and never a blank that would look configured.
        assert_eq!(p["password"], "${ENV:TDBINPUT_1_PASS}");
        assert!(im
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::EncryptedSecret { property, .. } if property == "PASS")));
    }

    #[test]
    fn a_repository_connection_is_reported_because_the_job_lacks_the_credentials() {
        let im = import_item(JOB, "j").unwrap();
        assert!(im
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::RepositoryConnection { node, .. } if node == "tDBInput_1")));
    }

    #[test]
    fn an_unmapped_component_is_kept_as_a_placeholder_never_dropped() {
        let im = import_item(JOB, "j").unwrap();
        let exotic = im.nodes.iter().find(|n| n.id == "tExotic_1").expect("kept");
        assert_eq!(exotic.data.component_id, None);
        assert!(exotic.data.label.contains("unmapped"));
        assert!(im.warnings.iter().any(
            |w| matches!(w, Warning::UnmappedComponent { component, .. } if component == "tSomethingExotic")
        ));
    }

    #[test]
    fn column_refs_map_but_java_expressions_are_reported() {
        let im = import_item(JOB, "j").unwrap();
        let map = im.nodes.iter().find(|n| n.id == "tMap_1").unwrap();
        let exprs = &map.data.properties.as_ref().unwrap()["expressions"];
        assert_eq!(exprs["LocationID"], "LocationID");
        // The Java call must not be silently carried across as if it worked.
        assert!(exprs.get("DI_Created_Date").is_none());
        assert!(im.warnings.iter().any(
            |w| matches!(w, Warning::JavaExpression { column, .. } if column == "DI_Created_Date")
        ));
    }

    #[test]
    fn context_variables_survive_as_duckle_placeholders() {
        assert_eq!(rewrite_context("context.myVar").as_deref(), Some("${myVar}"));
        assert_eq!(
            rewrite_context("context.getProperty(\"vJobPID\")").as_deref(),
            Some("${vJobPID}")
        );
        assert_eq!(rewrite_context("\"literal\""), None);
    }

    /// Run the importer over a real Talend workspace and report coverage.
    ///
    /// Opt-in, because it needs a Studio workspace on disk:
    ///   DUCKLE_TALEND_CORPUS=C:/Talend/workspace cargo test -p duckle-duckdb-engine \
    ///     --lib talend -- --ignored --nocapture
    ///
    /// Synthetic fixtures prove the mapping compiles; only a real corpus shows
    /// what fraction of actual jobs survive it.
    #[test]
    #[ignore = "needs a Talend workspace; set DUCKLE_TALEND_CORPUS"]
    fn real_corpus_coverage() {
        let root = match std::env::var("DUCKLE_TALEND_CORPUS") {
            Ok(v) => std::path::PathBuf::from(v),
            Err(_) => return,
        };
        let mut items = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|x| x.to_str()) == Some("item")
                    && p.to_string_lossy().contains("process")
                {
                    items.push(p);
                }
            }
        }
        assert!(!items.is_empty(), "no .item job files under the corpus root");

        let (mut jobs, mut nodes, mut mapped, mut failed) = (0usize, 0usize, 0usize, 0usize);
        let mut unmapped: BTreeMap<String, usize> = BTreeMap::new();
        for path in &items {
            let Ok(xml) = std::fs::read_to_string(path) else { continue };
            let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            match import_item(&xml, &name) {
                Ok(im) => {
                    jobs += 1;
                    nodes += im.nodes.len();
                    mapped += im.nodes.iter().filter(|n| n.data.component_id.is_some()).count();
                    for w in &im.warnings {
                        if let Warning::UnmappedComponent { component, .. } = w {
                            *unmapped.entry(component.clone()).or_default() += 1;
                        }
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("  PARSE FAILED {}: {e}", path.display());
                }
            }
        }
        println!("\n  jobs parsed     : {jobs} of {} ({failed} failed)", items.len());
        println!("  nodes           : {nodes}");
        println!(
            "  mapped          : {mapped} ({:.1}%)",
            100.0 * mapped as f64 / nodes.max(1) as f64
        );
        println!("  unmapped kinds  : {unmapped:?}");
        assert_eq!(failed, 0, "every job in the corpus must at least parse");
    }

    #[test]
    fn plain_mapper_expressions_become_sql() {
        // Measured on a real corpus: 278 mapper expressions were reported as needing a
        // human, and the largest groups are a literal, a null, or a cast. Those have one
        // faithful SQL form each, so reporting them buries the ones that genuinely need
        // judgement.
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("null").as_deref(), Some("NULL"));
        assert_eq!(sql(r#""""#).as_deref(), Some("''"));
        assert_eq!(sql(r#""S""#).as_deref(), Some("'S'"));
        assert_eq!(sql("row1.AMOUNT").as_deref(), Some("AMOUNT"));
        assert_eq!(sql("row1.SPARE.toString()").as_deref(), Some("SPARE"));
        assert_eq!(sql("StringHandling.TRIM(row1.NAME)").as_deref(), Some("trim(NAME)"));
        // new BigDecimal(Double.valueOf(x)) goes through a double in Java, so DOUBLE is
        // the faithful intermediate rather than a guess at a decimal scale.
        assert_eq!(
            sql("new BigDecimal(Double.valueOf(Var.RATE))").as_deref(),
            Some("TRY_CAST(RATE AS DOUBLE)")
        );
        assert_eq!(
            sql("new BigDecimal(Double.valueOf((Var.RATE)))").as_deref(),
            Some("TRY_CAST(RATE AS DOUBLE)")
        );
    }

    #[test]
    fn the_string_helpers_become_their_sql_equivalents() {
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("StringHandling.LEFT(row1.NID,2)").as_deref(), Some("left(NID, 2)"));
        assert_eq!(sql("StringHandling.RIGHT(row1.NID,2)").as_deref(), Some("right(NID, 2)"));
        // SUBSTR takes a start and a length from 1, matching SQL, rather than Java's
        // begin/end. Confirmed against a reference migration that renders it verbatim
        // as SUBSTR and whose output matches the SQL reading on every row.
        assert_eq!(
            sql("StringHandling.SUBSTR(row1.CODE,1,4)").as_deref(),
            Some("substr(CODE, 1, 4)")
        );
        // and they compose with the cast, which is how they appear in practice
        assert_eq!(
            sql("new BigDecimal(Double.valueOf(StringHandling.LEFT(Var.D,4)))").as_deref(),
            Some("TRY_CAST(left(D, 4) AS DOUBLE)")
        );
        assert_eq!(
            sql("new BigDecimal(Double.valueOf(StringHandling.RIGHT(StringHandling.LEFT(Var.D,6),2)))").as_deref(),
            Some("TRY_CAST(right(left(D, 6), 2) AS DOUBLE)")
        );
    }

    #[test]
    fn a_string_helper_with_a_computed_length_is_still_reported() {
        // The count argument has to be a plain integer. Anything else could be a Java
        // expression whose value we would be guessing at.
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("StringHandling.LEFT(row1.NID,row1.N)"), None);
        assert_eq!(sql("StringHandling.LEFT(row1.NID)"), None, "wrong arity");
        assert_eq!(sql("StringHandling.SUBSTR(row1.CODE,1)"), None, "wrong arity");
    }

    #[test]
    fn a_java_body_that_only_prints_says_so() {
        // 73 bodies in one corpus is a long triage list, and 21 of them turned out to
        // carry no rules at all. Saying which is which costs nothing and does not make
        // any of them compile.
        let body = |code: &str| {
            let xml = format!(
                r#"<talendfile:ProcessType xmlns:talendfile="x">
                  <node componentName="tJava">
                    <elementParameter name="UNIQUE_NAME" value="j_1"/>
                    <elementParameter name="CODE" value="{code}"/>
                  </node></talendfile:ProcessType>"#
            );
            import_item(&xml, "j").unwrap().warnings
        };

        let prints = body("System.out.println(&quot;starting&quot;);");
        assert_eq!(prints.len(), 1);
        assert!(
            matches!(&prints[0], Warning::JavaBody { only_prints: true, .. }),
            "a body of prints carries no rules, got {:?}",
            prints[0]
        );

        let rules = body("output_row.total = input_row.a + input_row.b;");
        assert!(
            matches!(&rules[0], Warning::JavaBody { only_prints: false, .. }),
            "a body that assigns must not be called harmless, got {:?}",
            rules[0]
        );

        // a print AND an assignment is not a printing body
        let mixed = body("System.out.println(&quot;x&quot;); context.n = 1;");
        assert!(matches!(&mixed[0], Warning::JavaBody { only_prints: false, .. }));
    }

    #[test]
    fn a_printing_body_still_fails_to_compile() {
        // The whole point of the loud failure is that a body cannot quietly become a
        // pipeline that runs and omits the rules. Saying a body only prints must not
        // change that: it still arrives with no sql.
        let xml = r#"<talendfile:ProcessType xmlns:talendfile="x">
          <node componentName="tJava">
            <elementParameter name="UNIQUE_NAME" value="j_1"/>
            <elementParameter name="CODE" value="System.out.println(&quot;hi&quot;);"/>
          </node></talendfile:ProcessType>"#;
        let im = import_item(xml, "j").unwrap();
        assert_eq!(im.nodes[0].data.component_id.as_deref(), Some("code.sql"));
        let props = im.nodes[0].data.properties.as_ref().unwrap();
        assert!(props.get("sql").is_none(), "no sql, so it cannot run");
        assert!(props.get("untranslatedSource").is_some(), "the body is kept");
    }

    #[test]
    fn a_choice_becomes_a_case_expression() {
        let sql = |e: &str| java_expr_to_sql(e);
        // compareTo(x) == 0 is numeric equality ignoring scale, which is what SQL = does.
        assert_eq!(
            sql(r#"row6.PCT.compareTo(new BigDecimal("100")) == 0 ? row6.A : row6.B"#).as_deref(),
            Some("CASE WHEN PCT = 100 THEN A ELSE B END")
        );
        assert_eq!(
            sql(r#"row7.PCT.compareTo(BigDecimal.ZERO) == 0? new BigDecimal("0.00"): row7.A"#).as_deref(),
            Some("CASE WHEN PCT = 0 THEN 0.00 ELSE A END")
        );
        // equals on a string is the same comparison, and a chain nests
        assert_eq!(
            sql(r#"m.d.equals("1")?"I":m.d.equals("2")?"O":"P""#).as_deref(),
            Some("CASE WHEN d = '1' THEN 'I' ELSE CASE WHEN d = '2' THEN 'O' ELSE 'P' END END")
        );
        // subtract, and a choice nested inside one
        assert_eq!(sql("row6.A.subtract(row6.B)").as_deref(), Some("(A) - (B)"));
        assert_eq!(
            sql(r#"row6.T.subtract(row6.PCT.compareTo(new BigDecimal("100")) == 0 ? row6.A : row6.B)"#).as_deref(),
            Some("(T) - (CASE WHEN PCT = 100 THEN A ELSE B END)")
        );
        assert_eq!(
            sql("String.valueOf(row6.A)").as_deref(),
            Some("CAST(A AS VARCHAR)")
        );
    }

    #[test]
    fn a_choice_we_cannot_read_is_still_reported() {
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("a ? b : c"), None, "operands are not readable");
        assert_eq!(
            sql("row6.PCT.compareTo(row6.X) > 0 ? row6.A : row6.B"),
            None,
            "only equality is translated; an ordering needs its sign checked"
        );
        assert_eq!(sql("row6.A.compareTo(row6.B) == 1"), None, "not a boolean shape");
    }

    #[test]
    fn numeric_literals_and_exact_decimals_become_sql() {
        let sql = |e: &str| java_expr_to_sql(e);
        // A bare number is a number.
        assert_eq!(sql("0").as_deref(), Some("0"));
        assert_eq!(sql("-1").as_deref(), Some("-1"));
        assert_eq!(
            sql("new BigDecimal(Double.valueOf(0))").as_deref(),
            Some("TRY_CAST(0 AS DOUBLE)")
        );
        // new BigDecimal("0.00") is an exact decimal, and the literal already carries the
        // scale, so writing it through keeps that without inventing a cast.
        assert_eq!(sql(r#"new BigDecimal("0")"#).as_deref(), Some("0"));
        assert_eq!(sql(r#"new BigDecimal("-1")"#).as_deref(), Some("-1"));
        assert_eq!(sql(r#"new BigDecimal("0.00")"#).as_deref(), Some("0.00"));
    }

    #[test]
    fn sign_changing_arithmetic_becomes_sql() {
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("row6.AMT.negate()").as_deref(), Some("-(AMT)"));
        assert_eq!(
            sql(r#"row6.AMT.multiply(new BigDecimal("-1"))"#).as_deref(),
            Some("(AMT) * (-1)")
        );
        // an operand we cannot read keeps the whole expression reported
        assert_eq!(sql("row6.AMT.multiply(somethingOdd(1,2))"), None);
    }

    #[test]
    fn a_mapper_expression_needing_judgement_is_still_reported() {
        // The point of translating the easy ones is that what remains is worth reading.
        // Anything with branching, arithmetic or an unverified index must keep warning:
        // guessing one of these wrong is a silent wrong number, not a failure.
        let sql = |e: &str| java_expr_to_sql(e);
        assert_eq!(sql("jobName"), None, "a bare identifier is not a column");
        assert_eq!(sql("new BigDecimal(Var.ID)"), None, "exact decimal, not a double");
        assert_eq!(sql("new BigDecimal(row1.AMT)"), None, "exact decimal or double, unrecorded");
        assert_eq!(
            sql(r#"a.equals("1")?"I":"O""#),
            None,
            "the choice reads, but a bare `a` is not a column"
        );
        assert_eq!(sql(r#"TalendDate.parseDate("ddMMyyyy",Var.D)"#), None);
        assert_eq!(sql("f(a) + g(b)"), None, "not a single call");
    }

    #[test]
    fn a_joblets_boundary_port_is_kept() {
        // A joblet writes its ports as <jobletNodes>, not <node>. Reading only <node>
        // dropped the port, and with it the link into the first component, which then
        // failed as "missing main input" and named the wrong node.
        let xml = r#"<xmi:XMI xmlns:xmi="x" xmlns:model="y">
          <model:JobletProcess>
            <jobletNodes componentName="INPUT" posX="10" posY="10">
              <elementParameter name="UNIQUE_NAME" value="INPUT_1"/>
            </jobletNodes>
            <node componentName="tFileOutputDelimited" posX="100" posY="10">
              <elementParameter name="UNIQUE_NAME" value="out_1"/>
              <elementParameter name="FILENAME" value="&quot;/data/out.csv&quot;"/>
            </node>
            <connection connectorName="FLOW" source="INPUT_1" target="out_1"/>
          </model:JobletProcess>
        </xmi:XMI>"#;
        let im = import_item(xml, "body").unwrap();

        assert!(
            im.nodes.iter().any(|n| n.id == "INPUT_1"),
            "the port must survive, got {:?}",
            im.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
        assert_eq!(im.edges.len(), 1, "and so must the link it carries");
        assert!(
            im.warnings.iter().any(|w| matches!(
                w,
                Warning::UnmappedComponent { component, .. } if component == "INPUT"
            )),
            "a port Duckle cannot yet drive has to be reported, not dropped"
        );
    }

    #[test]
    fn a_child_job_reference_names_the_file_the_child_became() {
        // PROCESS holds the child's bare name, but pipelineRef is a path to the child
        // pipeline. Copying it verbatim left the reference dangling: measured on a real
        // corpus, 17 of 28 references resolved only once the extension was added.
        let xml = r#"<talendfile:ProcessType xmlns:talendfile="x">
          <node componentName="tRunJob">
            <elementParameter name="UNIQUE_NAME" value="call_1"/>
            <elementParameter name="PROCESS" value="CHILD_JOB"/>
          </node></talendfile:ProcessType>"#;
        let im = import_item(xml, "parent").unwrap();
        let r = im.nodes[0].data.properties.as_ref().unwrap()["pipelineRef"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(r, "CHILD_JOB.json", "the child is written under that name");
    }

    #[test]
    fn the_generic_db_node_resolves_through_its_type_parameter() {
        let xml = r#"<talendfile:ProcessType xmlns:talendfile="x">
          <node componentName="tDBOutput">
            <elementParameter name="UNIQUE_NAME" value="out_1"/>
            <elementParameter name="TYPE" value="MYSQL"/>
            <elementParameter name="TABLE" value="&quot;dim&quot;"/>
          </node></talendfile:ProcessType>"#;
        let im = import_item(xml, "j").unwrap();
        assert_eq!(im.nodes[0].data.component_id.as_deref(), Some("snk.mysql"));
    }
}

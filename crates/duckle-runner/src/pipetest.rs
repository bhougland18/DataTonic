//! `duckle test` - run a pipeline against a fixed input and assert what comes out.
//!
//! `validate` compiles a pipeline without running it, which catches wiring and SQL that
//! will not bind. It cannot catch a transform that binds and computes the wrong thing.
//! The fastest way to catch THAT is the oldest one: a tiny known input, and the exact
//! rows expected out of one node.
//!
//! A case names the node it asserts on, so the run stops there - nothing downstream
//! executes and no sink writes. That is the same partial execution the desktop preview
//! uses, which is why this is small: the engine already knew how to stop at a node.
//!
//! A test file is JSON, because pipelines are:
//!
//! ```json
//! {
//!   "pipeline": "pipelines/orders.json",
//!   "cases": [
//!     {
//!       "name": "a row with no amount is dropped",
//!       "given": { "src_1": "id,amt\n1,5\n2,\n" },
//!       "expect": { "node": "filter_1", "rows": [{ "id": "1", "amt": "5" }] }
//!     }
//!   ]
//! }
//! ```
//!
//! `given` maps a source node id to the text it should read; the text is written to a
//! temp file and that node's `path` is pointed at it, so the pipeline under test is the
//! real one rather than a copy that has drifted from it.

use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use duckle_duckdb_engine::{DuckdbEngine, PipelineDoc};

#[derive(Debug)]
pub struct Case {
    pub name: String,
    pub given: Vec<(String, String)>,
    pub node: String,
    pub rows: Vec<JsonValue>,
}

/// One failure, said in terms of the case rather than of the engine.
#[derive(Debug)]
pub struct Failure {
    pub case: String,
    pub why: String,
}

/// Read a test file into cases. The error names the file, since a suite usually has
/// several and "expected an object" on its own says nothing about which.
pub fn parse(path: &Path, text: &str) -> Result<(PathBuf, Vec<Case>), String> {
    let name = path.display();
    let doc: JsonValue =
        serde_json::from_str(text).map_err(|e| format!("{name}: not valid JSON: {e}"))?;
    let pipeline = doc
        .get("pipeline")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| format!("{name}: needs a \"pipeline\" naming the file under test"))?;
    // Relative to the TEST file, so a suite can sit beside the pipelines it covers and
    // still be run from anywhere.
    let base = path.parent().unwrap_or(Path::new("."));
    let pipeline_path = base.join(pipeline);

    let raw = doc
        .get("cases")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| format!("{name}: needs a \"cases\" array"))?;
    let mut cases = Vec::new();
    for (i, c) in raw.iter().enumerate() {
        let label = c
            .get("name")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("case {}", i + 1));
        let expect = c
            .get("expect")
            .ok_or_else(|| format!("{name}: {label}: needs an \"expect\""))?;
        let node = expect
            .get("node")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| format!("{name}: {label}: \"expect\" needs a \"node\""))?
            .to_string();
        let rows = expect
            .get("rows")
            .and_then(JsonValue::as_array)
            .cloned()
            .ok_or_else(|| format!("{name}: {label}: \"expect\" needs a \"rows\" array"))?;
        let given = c
            .get("given")
            .and_then(JsonValue::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        cases.push(Case { name: label, given, node, rows });
    }
    Ok((pipeline_path, cases))
}

/// Point a source node at a file holding the case's text.
///
/// The node keeps every other property it has, so the fixture exercises the real
/// reader - its delimiter, its header setting, its declared columns - rather than a
/// simplified stand-in that would pass while the pipeline fails.
pub fn apply_given(doc: &mut JsonValue, node_id: &str, path: &str) -> Result<(), String> {
    let nodes = doc
        .get_mut("nodes")
        .and_then(JsonValue::as_array_mut)
        .ok_or("pipeline has no nodes")?;
    for n in nodes.iter_mut() {
        if n.get("id").and_then(JsonValue::as_str) != Some(node_id) {
            continue;
        }
        let data = n
            .get_mut("data")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| format!("node {node_id} has no data"))?;
        let props = data
            .entry("properties")
            .or_insert_with(|| JsonValue::Object(Default::default()));
        let props = props
            .as_object_mut()
            .ok_or_else(|| format!("node {node_id} properties are not an object"))?;
        props.insert("path".into(), JsonValue::String(path.to_string()));
        return Ok(());
    }
    Err(format!("no node called {node_id} to give input to"))
}

/// Compare what came out against what the case asked for.
///
/// Only the columns the case NAMES are compared, so a case stays readable and does not
/// break every time an unrelated column is added upstream. Everything is compared as
/// text: the rows come back as JSON and a case is written by hand, so 5 and "5" are the
/// same assertion and treating them differently only produces confusing failures.
pub fn compare(expected: &[JsonValue], actual: &[JsonValue]) -> Option<String> {
    if expected.len() != actual.len() {
        return Some(format!(
            "expected {} row(s), got {}",
            expected.len(),
            actual.len()
        ));
    }
    let cell = |v: Option<&JsonValue>| match v {
        Some(JsonValue::String(s)) => s.clone(),
        Some(JsonValue::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    for (i, want) in expected.iter().enumerate() {
        let got = &actual[i];
        let obj = match want.as_object() {
            Some(o) => o,
            None => return Some(format!("row {}: expected an object", i + 1)),
        };
        for (k, wv) in obj {
            let a = cell(got.get(k));
            let w = cell(Some(wv));
            if a != w {
                return Some(format!("row {}, {k}: expected [{w}], got [{a}]", i + 1));
            }
        }
    }
    None
}

/// Run one case and say what went wrong, or nothing.
fn run_case(engine: &DuckdbEngine, pipeline: &Path, case: &Case, tmp: &Path) -> Option<String> {
    let text = match std::fs::read_to_string(pipeline) {
        Ok(t) => t,
        Err(e) => return Some(format!("cannot read {}: {e}", pipeline.display())),
    };
    let mut doc: JsonValue = match serde_json::from_str(&text) {
        Ok(d) => d,
        Err(e) => return Some(format!("{} is not valid JSON: {e}", pipeline.display())),
    };
    for (node, body) in &case.given {
        let f = tmp.join(format!("given_{node}"));
        if let Err(e) = std::fs::write(&f, body) {
            return Some(format!("cannot write the input for {node}: {e}"));
        }
        let as_str = f.to_string_lossy().replace('\\', "/");
        if let Err(e) = apply_given(&mut doc, node, &as_str) {
            return Some(e);
        }
    }
    let parsed: PipelineDoc = match serde_json::from_value(doc) {
        Ok(d) => d,
        Err(e) => return Some(format!("pipeline did not load: {e}")),
    };
    let result =
        engine.execute_pipeline_with_events(&parsed, Some(&case.node), Some("test"), |_| {});
    if result.status != "ok" {
        return Some(result.error.unwrap_or_else(|| "the run failed".into()));
    }
    match result.preview.iter().find(|p| p.node_id == case.node) {
        Some(p) => compare(&case.rows, &p.rows),
        None => Some(format!("{} produced no rows to compare", case.node)),
    }
}

/// `duckle test [<file.test.json> ...]`
pub fn run(duckdb: PathBuf) -> ExitCode {
    let mut paths: Vec<PathBuf> = Vec::new();
    for arg in std::env::args().skip(2) {
        if arg.starts_with('-') {
            eprintln!("duckle-runner test: unknown flag {arg}");
            return ExitCode::from(2);
        }
        paths.push(PathBuf::from(arg));
    }
    // Nothing named: every suite under ./tests, which is where a workspace keeps them.
    if paths.is_empty() {
        if let Ok(entries) = std::fs::read_dir("tests") {
            for e in entries.flatten() {
                let p = e.path();
                if p.to_string_lossy().ends_with(".test.json") {
                    paths.push(p);
                }
            }
            paths.sort();
        }
        if paths.is_empty() {
            eprintln!("duckle-runner test: nothing given and no *.test.json under ./tests");
            return ExitCode::from(2);
        }
    }

    let tmp = std::env::temp_dir().join(format!("duckle-test-{}", std::process::id()));
    if let Err(e) = std::fs::create_dir_all(&tmp) {
        eprintln!("duckle-runner test: cannot make a scratch folder: {e}");
        return ExitCode::from(2);
    }
    let engine = DuckdbEngine::new(duckdb);

    let (mut passed, mut failures) = (0usize, Vec::<Failure>::new());
    for path in &paths {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("duckle-runner test: cannot read {}: {e}", path.display());
                return ExitCode::from(2);
            }
        };
        let (pipeline, cases) = match parse(path, &text) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("duckle-runner test: {e}");
                return ExitCode::from(2);
            }
        };
        for case in &cases {
            match run_case(&engine, &pipeline, case, &tmp) {
                None => {
                    passed += 1;
                    println!("  ok    {}", case.name);
                }
                Some(why) => {
                    println!("  FAIL  {}", case.name);
                    println!("        {why}");
                    failures.push(Failure { case: case.name.clone(), why });
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);

    println!();
    println!("{passed} passed, {} failed", failures.len());
    // A failing assertion is a real finding about the pipeline, which is exit 1 - the
    // same code a failed run uses, so CI gates on it without special-casing.
    if failures.is_empty() { ExitCode::from(0) } else { ExitCode::from(1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_case_compares_only_the_columns_it_names() {
        // A case that had to name every column would break the moment an unrelated one
        // was added upstream, so people would stop writing them.
        let want = vec![serde_json::json!({ "id": "1" })];
        let got = vec![serde_json::json!({ "id": "1", "extra": "ignored" })];
        assert_eq!(compare(&want, &got), None);
    }

    #[test]
    fn a_number_and_its_text_are_the_same_assertion() {
        // Rows come back as JSON and cases are written by hand. Treating 5 and "5" as
        // different only produces failures nobody can act on.
        let want = vec![serde_json::json!({ "n": "5" })];
        let got = vec![serde_json::json!({ "n": 5 })];
        assert_eq!(compare(&want, &got), None);
    }

    #[test]
    fn a_wrong_value_says_which_row_and_column() {
        let want = vec![serde_json::json!({ "id": "1", "amt": "5" })];
        let got = vec![serde_json::json!({ "id": "1", "amt": "6" })];
        let why = compare(&want, &got).expect("must fail");
        assert!(why.contains("row 1"), "{why}");
        assert!(why.contains("amt"), "{why}");
        assert!(why.contains("[5]") && why.contains("[6]"), "{why}");
    }

    #[test]
    fn a_different_number_of_rows_is_a_failure_on_its_own() {
        let want = vec![serde_json::json!({ "id": "1" })];
        assert!(compare(&want, &[]).unwrap().contains("expected 1 row(s), got 0"));
    }

    #[test]
    fn giving_a_node_input_keeps_its_other_settings() {
        // The fixture has to exercise the REAL reader - its delimiter, its header
        // setting - or a case passes while the pipeline it stands for fails.
        let mut doc = serde_json::json!({
            "nodes": [{ "id": "s", "data": { "properties": {
                "path": "/old.csv", "delimiter": ";", "hasHeader": true } } }]
        });
        apply_given(&mut doc, "s", "/tmp/given").unwrap();
        let p = &doc["nodes"][0]["data"]["properties"];
        assert_eq!(p["path"], "/tmp/given");
        assert_eq!(p["delimiter"], ";", "the reader's own settings survive");
        assert_eq!(p["hasHeader"], true);
    }

    #[test]
    fn a_node_that_is_not_there_is_said_plainly() {
        let mut doc = serde_json::json!({ "nodes": [] });
        let e = apply_given(&mut doc, "nope", "/tmp/x").unwrap_err();
        assert!(e.contains("nope"), "{e}");
    }

    #[test]
    fn a_test_file_resolves_its_pipeline_beside_itself() {
        // So a suite can sit next to what it covers and still be run from anywhere.
        let text = r#"{"pipeline":"p.json","cases":[
            {"name":"c","expect":{"node":"n","rows":[]}}]}"#;
        let (p, cases) = parse(Path::new("suites/orders.test.json"), text).unwrap();
        assert_eq!(p, Path::new("suites").join("p.json"));
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].node, "n");
    }

    #[test]
    fn a_missing_piece_names_the_file_and_the_case() {
        let e = parse(Path::new("s/x.test.json"), r#"{"cases":[]}"#).unwrap_err();
        assert!(e.contains("x.test.json") && e.contains("pipeline"), "{e}");
        let e = parse(
            Path::new("s/x.test.json"),
            r#"{"pipeline":"p.json","cases":[{"name":"c","expect":{"rows":[]}}]}"#,
        )
        .unwrap_err();
        assert!(e.contains("c") && e.contains("node"), "{e}");
    }
}

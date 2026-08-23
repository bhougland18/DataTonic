//! `duckle-runner import ...` - convert a directory of legacy job files.
//!
//! The desktop app already reads one job file at a time, which is the right shape for
//! trying Duckle and the wrong shape for leaving another tool: nobody has one job, they
//! have several hundred in a repository, and converting them through a file dialog is not
//! a migration plan. This walks the tree instead and reports the whole corpus at once.
//!
//! The report matters more than the conversion. Anyone deciding whether to move needs two
//! numbers before they start - how many jobs come across clean, and which handful of
//! components account for everything that does not - and those numbers are also the
//! roadmap: the unmapped tally, sorted, is exactly the list of components worth adding
//! next. Coverage is the head of the distribution, so a corpus usually converts far better
//! than the raw component count suggests.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use duckle_duckdb_engine::talend::{self, Warning};

/// What became of one job file.
#[derive(Debug)]
pub struct JobOutcome {
    pub source: PathBuf,
    pub name: String,
    /// Where the pipeline was written. `None` when the file could not be read at all.
    pub written: Option<PathBuf>,
    pub error: Option<String>,
    /// Why this file was not a job, when it was not one. The extension is shared by
    /// routines, contexts and metadata; those parse cleanly and contain no pipeline.
    pub skipped: Option<String>,
    /// Everything a human still has to resolve, already rendered for display.
    pub warnings: Vec<String>,
    /// Components with no Duckle equivalent, and how many of each this job used.
    pub unmapped: BTreeMap<String, usize>,
}

impl JobOutcome {
    /// A job converted with nothing left to resolve. A skipped file is not a clean
    /// conversion: counting empty pipelines as successes is how a migration report ends
    /// up flattering itself.
    pub fn is_clean(&self) -> bool {
        self.error.is_none() && self.skipped.is_none() && self.warnings.is_empty()
    }
}

/// What became of the corpus.
#[derive(Debug, Default)]
pub struct BulkReport {
    pub jobs: Vec<JobOutcome>,
}

impl BulkReport {
    pub fn clean(&self) -> usize {
        self.jobs.iter().filter(|j| j.is_clean()).count()
    }

    pub fn needs_attention(&self) -> usize {
        self.jobs
            .iter()
            .filter(|j| j.error.is_none() && j.skipped.is_none() && !j.warnings.is_empty())
            .count()
    }

    pub fn failed(&self) -> usize {
        self.jobs.iter().filter(|j| j.error.is_some()).count()
    }

    /// Files that parsed but hold no pipeline. Reported so the total still adds up.
    pub fn skipped(&self) -> usize {
        self.jobs
            .iter()
            .filter(|j| j.error.is_none() && j.skipped.is_some())
            .count()
    }

    /// The machine-readable form, for a migration script or a CI job.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "jobs": self.jobs.iter().map(|j| serde_json::json!({
                "source": j.source.to_string_lossy(),
                "name": j.name,
                "written": j.written.as_ref().map(|p| p.to_string_lossy()),
                "error": j.error,
                "skipped": j.skipped,
                "warnings": j.warnings,
                "unmapped": j.unmapped,
            })).collect::<Vec<_>>(),
            "summary": {
                "total": self.jobs.len(),
                "clean": self.clean(),
                "needsAttention": self.needs_attention(),
                "failed": self.failed(),
                "skipped": self.skipped(),
                "unmapped": self.unmapped_totals(),
            }
        })
    }

    /// Every unmapped component across the corpus, with a total count.
    ///
    /// This is the whole point of converting in bulk: one job tells you nothing about
    /// whether a migration is viable, and a hundred tell you exactly which components to
    /// build next.
    pub fn unmapped_totals(&self) -> BTreeMap<String, usize> {
        let mut totals = BTreeMap::new();
        for job in &self.jobs {
            for (component, n) in &job.unmapped {
                *totals.entry(component.clone()).or_insert(0) += n;
            }
        }
        totals
    }
}

pub fn run() -> Result<i32, String> {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let first = args.first().map(String::as_str).unwrap_or("");
    if first.is_empty() || first == "-h" || first == "--help" {
        println!(
            "duckle-runner import - convert a folder of legacy job files\n\n\
             USAGE:\n    \
             duckle-runner import <dir> [--out <dir>] [--json] [--strict]\n\n\
             Walks <dir> for job files, converts each one, and mirrors the folder\n\
             layout under --out (default ./imported). The layout is kept rather than\n\
             flattened so two jobs that share a name cannot overwrite each other.\n\n\
             Nothing is ever dropped in silence. A component with no equivalent is\n\
             imported as a placeholder and reported, an encrypted password becomes an\n\
             ${{ENV:...}} placeholder, and a file that will not parse is listed rather\n\
             than ending the run.\n\n\
             The tally at the end is the number to decide on: it says how many jobs\n\
             came across clean and which components account for everything that did\n\
             not. Sorted by count, that list is also the shortest path to a complete\n\
             migration.\n\n\
             --strict exits 1 when any job needs attention, for a CI gate.\n"
        );
        return Ok(0);
    }

    let src = PathBuf::from(first);
    let mut out = PathBuf::from("imported");
    let mut json = false;
    let mut strict = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                i += 1;
                out = PathBuf::from(args.get(i).ok_or("--out needs a directory")?);
            }
            "--json" => json = true,
            "--strict" => strict = true,
            other => return Err(format!("unknown option {other}")),
        }
        i += 1;
    }
    if !src.is_dir() {
        return Err(format!("{} is not a directory", src.display()));
    }

    let report = import_tree(&src, &out)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report.to_json()).unwrap());
    } else {
        print_report(&report, &out);
    }
    Ok(if strict && (report.needs_attention() > 0 || report.failed() > 0) { 1 } else { 0 })
}

fn print_report(report: &BulkReport, out: &Path) {
    for job in &report.jobs {
        match (&job.error, &job.skipped) {
            (Some(e), _) => println!("  FAILED  {}  {}", job.name, e),
            (None, Some(why)) => println!("  skip    {}  {}", job.name, why),
            (None, None) if job.warnings.is_empty() => println!("  ok      {}", job.name),
            (None, None) => {
                println!("  review  {}  ({} to resolve)", job.name, job.warnings.len())
            }
        }
        for w in &job.warnings {
            println!("            {w}");
        }
    }
    let jobs = report.clean() + report.needs_attention() + report.failed();
    println!(
        "\n{} file(s): {} held a job, {} were not jobs\n\
         {} job(s): {} clean, {} need review, {} failed -> {}",
        report.jobs.len(),
        jobs,
        report.skipped(),
        jobs,
        report.clean(),
        report.needs_attention(),
        report.failed(),
        out.display()
    );

    let totals = report.unmapped_totals();
    if !totals.is_empty() {
        // Sorted by count: the shortest path to converting the rest of the corpus.
        let mut ranked: Vec<_> = totals.iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        println!("\nno equivalent yet, most used first:");
        for (component, n) in ranked {
            println!("  {n:>4}  {component}");
        }
    }
}

/// Convert every job file under `src`, mirroring the tree under `out`.
///
/// The source layout is preserved rather than flattened, because two jobs in different
/// folders routinely share a name and flattening would have one silently overwrite the
/// other - a migration tool that loses a job is worse than one that refuses it.
pub fn import_tree(src: &Path, out: &Path) -> Result<BulkReport, String> {
    let mut files = Vec::new();
    collect_jobs(src, &mut files)?;
    files.sort();

    let mut report = BulkReport::default();
    let mut taken: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    // Parse everything before writing anything: a body has to be in hand before the job
    // that calls it can be written with the body spliced in, and the file order says
    // nothing about which comes first.
    let mut parsed: Vec<(PathBuf, JobOutcome, Option<talend::Import>)> = Vec::new();
    for file in files {
        let rel = file.strip_prefix(src).unwrap_or(&file).to_path_buf();
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "job".to_string());
        // Studio names the file <Job>_0.1.item but a caller references <Job>, so keeping
        // the version leaves every reference dangling. Two exported versions of one job
        // would then collide, so the first to claim the bare name keeps it and the rest
        // stay versioned rather than overwriting it.
        let bare = strip_version(&stem);
        let (name, rel) = match rel.with_file_name(&bare) {
            bare_rel if bare != stem && taken.insert(bare_rel.clone()) => (bare, bare_rel),
            _ => {
                taken.insert(rel.clone());
                (stem, rel)
            }
        };
        let (outcome, import) = parse_one(&file, &name);
        parsed.push((rel, outcome, import));
    }

    // A reusable body takes its rows from whoever calls it, and a child pipeline is handed
    // none, so a call by reference could never work. Splice each body into its callers
    // instead, which is what the source tool does when it generates the job.
    let bodies: BTreeMap<String, talend::Import> = parsed
        .iter()
        .filter_map(|(_, _, im)| im.as_ref())
        .filter(|im| im.is_subflow_body())
        .map(|im| (format!("{}.json", im.name), (*im).clone()))
        .collect();
    let mut spliced: std::collections::HashSet<String> = Default::default();
    for (_, _, import) in parsed.iter_mut() {
        let Some(import) = import.as_mut() else { continue };
        loop {
            let call = import.nodes.iter().find_map(|n| {
                let props = n.data.properties.as_ref()?;
                let r = props.get("pipelineRef")?.as_str()?;
                bodies.contains_key(r).then(|| (n.id.clone(), r.to_string()))
            });
            let Some((call_id, reference)) = call else { break };
            let body = &bodies[&reference];
            if talend::inline_subflow(import, &call_id, body).is_err() {
                break;
            }
            spliced.insert(reference);
        }
    }

    // A caller that wants its child's rows and a child that never writes any is a pair
    // that only reads together: the caller would read a file nobody wrote. Neither file
    // can see the problem on its own.
    let converted: std::collections::HashSet<String> = parsed
        .iter()
        .filter_map(|(_, _, im)| im.as_ref())
        .map(|im| format!("{}.json", im.name))
        .collect();
    let returning: std::collections::HashSet<String> = parsed
        .iter()
        .filter_map(|(_, _, im)| im.as_ref())
        .filter(|im| im.returns_rows())
        .map(|im| format!("{}.json", im.name))
        .collect();
    for (_, _, import) in parsed.iter_mut() {
        let Some(import) = import.as_mut() else { continue };
        let mismatched: Vec<String> = import
            .all_nodes()
            .into_iter()
            .filter(|n| {
                let Some(props) = n.data.properties.as_ref() else { return false };
                if props.get("returnsRows").and_then(|v| v.as_bool()) != Some(true) {
                    return false;
                }
                match props.get("pipelineRef").and_then(|v| v.as_str()) {
                    // An unresolved reference is already reported as its own problem.
                    Some(r) => converted.contains(r) && !returning.contains(r),
                    None => false,
                }
            })
            .map(|n| n.id.clone())
            .collect();
        for node in mismatched {
            import.warnings.push(talend::Warning::ChildReturnsRows { node });
        }
    }

    // With every job in hand, the tables the project produces for its own use can be
    // told from the ones it produces for someone else, and the reads of the first kind
    // no longer have to leave the machine.
    {
        let mut all: Vec<&mut talend::Import> =
            parsed.iter_mut().filter_map(|(_, _, im)| im.as_mut()).collect();
        talend::route_reads_to_local_mirror(&mut all);
    }

    for (rel, outcome, import) in parsed {
        match import {
            // A body that was spliced into its callers is not a pipeline of its own.
            Some(im) if spliced.contains(&format!("{}.json", im.name)) => {}
            Some(im) => report.jobs.push(write_one(outcome, &im, &rel, out)),
            None => report.jobs.push(outcome),
        }
    }
    Ok(report)
}

/// `"<Job>_0.1"` -> `"<Job>"`. Only a trailing `_<digits>.<digits>` is a version.
fn strip_version(stem: &str) -> String {
    if let Some((head, tail)) = stem.rsplit_once('_') {
        if let Some((major, minor)) = tail.split_once('.') {
            let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
            if numeric(major) && numeric(minor) {
                return head.to_string();
            }
        }
    }
    stem.to_string()
}

/// Convert one file. A failure here is recorded, never propagated: one unreadable file in
/// a corpus of hundreds must not end the migration.
fn parse_one(file: &Path, name: &str) -> (JobOutcome, Option<talend::Import>) {
    let mut outcome = JobOutcome {
        source: file.to_path_buf(),
        name: name.to_string(),
        written: None,
        error: None,
        skipped: None,
        warnings: Vec::new(),
        unmapped: BTreeMap::new(),
    };

    let xml = match std::fs::read_to_string(file) {
        Ok(x) => x,
        Err(e) => {
            outcome.error = Some(format!("read: {e}"));
            return (outcome, None);
        }
    };
    // A job declares itself a process. Routines are Java source that merely shares the
    // extension, and their javadoc HTML makes the XML reader fail; reporting those as
    // failed jobs makes a migration look worse than it is and sends someone chasing
    // files that were never jobs. Checking first keeps the other half of the rule intact:
    // a file that says it is a job and then will not parse is still a failure.
    // A joblet declares JobletProcess instead. It is the body a job calls into, so
    // skipping it leaves every caller pointing at nothing.
    if !xml.contains("ProcessType") && !xml.contains("JobletProcess") {
        outcome.skipped = Some("not a job (no process declaration)".into());
        return (outcome, None);
    }

    let import = match talend::import_item(&xml, name) {
        Ok(i) => i,
        Err(e) => {
            outcome.error = Some(e);
            return (outcome, None);
        }
    };

    // A routine, a context or a metadata item parses perfectly and yields no nodes.
    // Writing an empty pipeline for it would put a file in the output that runs and does
    // nothing, and counting it as converted would inflate the only number anyone reads.
    if import.nodes.is_empty() {
        outcome.skipped = Some("holds no job (routine, context or metadata)".into());
        return (outcome, None);
    }

    (outcome, Some(import))
}

/// Record what still needs a person, then write the pipeline out.
///
/// Warnings are read here rather than at parse time because a body's warnings become its
/// caller's once it is spliced in.
fn write_one(
    mut outcome: JobOutcome,
    import: &talend::Import,
    rel: &Path,
    out: &Path,
) -> JobOutcome {
    for w in &import.warnings {
        outcome.warnings.push(w.to_string());
        if let Warning::UnmappedComponent { component, .. } = w {
            *outcome.unmapped.entry(component.clone()).or_insert(0) += 1;
        }
    }

    let target = out.join(rel).with_extension("json");
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            outcome.error = Some(format!("create {}: {e}", parent.display()));
            return outcome;
        }
    }
    let body = match serde_json::to_string_pretty(&import.to_pipeline_json()) {
        Ok(b) => b,
        Err(e) => {
            outcome.error = Some(format!("serialise: {e}"));
            return outcome;
        }
    };
    match std::fs::write(&target, body) {
        Ok(()) => outcome.written = Some(target.clone()),
        Err(e) => outcome.error = Some(format!("write {}: {e}", target.display())),
    }
    // A loop's body was lifted into a pipeline of its own, and the loop names it
    // by file. Write it beside the parent so the reference resolves; a loop
    // pointing at a file that was never written is worse than no extraction.
    if outcome.error.is_none() {
        for child in &import.children {
            let child_path = target.with_file_name(format!("{}.json", child.name));
            let child_body = match serde_json::to_string_pretty(&child.to_pipeline_json()) {
                Ok(b) => b,
                Err(e) => {
                    outcome.error = Some(format!("serialise {}: {e}", child.name));
                    break;
                }
            };
            if let Err(e) = std::fs::write(&child_path, child_body) {
                outcome.error = Some(format!("write {}: {e}", child_path.display()));
                break;
            }
        }
    }
    outcome
}

/// Walk for job files. Anything that is not one is left alone, so pointing this at a
/// checkout rather than a curated folder is safe.
fn collect_jobs(dir: &Path, into: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {}: {e}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_jobs(&path, into)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("item") {
            into.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A job using one component that maps and one that does not, so a single fixture
    /// exercises both halves of the report.
    fn job_xml(unmapped_component: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="100" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="in_1"/>
    <elementParameter field="TEXT" name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  <node componentName="{unmapped_component}" posX="300" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="odd_1"/>
  </node>
  <connection connectorName="FLOW" source="in_1" target="odd_1"/>
</talendfile:ProcessType>
"#
        )
    }

    fn write(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn every_job_in_the_tree_is_converted() {
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "a.item", &job_xml("tSomethingOdd"));
        write(src.path(), "nested/b.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 2, "both jobs should be found");
        assert!(out.path().join("a.json").exists(), "top-level job written");
        assert!(
            out.path().join("nested/b.json").exists(),
            "nested job keeps its folder"
        );
    }

    #[test]
    fn two_jobs_with_the_same_name_do_not_overwrite_each_other() {
        // The reason the tree is mirrored rather than flattened. Losing a job silently is
        // the worst thing a migration tool can do.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "sales/load.item", &job_xml("tSomethingOdd"));
        write(src.path(), "finance/load.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 2);
        assert!(out.path().join("sales/load.json").exists());
        assert!(out.path().join("finance/load.json").exists());
    }

    #[test]
    fn the_unmapped_tally_adds_up_across_the_corpus() {
        // The number someone actually decides on: not "does this job convert" but "which
        // handful of components stand between me and moving".
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "a.item", &job_xml("tSomethingOdd"));
        write(src.path(), "b.item", &job_xml("tSomethingOdd"));
        write(src.path(), "c.item", &job_xml("tOtherOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();
        let totals = report.unmapped_totals();

        assert_eq!(
            totals.get("tSomethingOdd"),
            Some(&2),
            "seen once in each of two jobs"
        );
        assert_eq!(totals.get("tOtherOdd"), Some(&1));
    }

    #[test]
    fn a_job_that_needs_attention_is_counted_separately_from_a_clean_one() {
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        // Only a component that maps: nothing left to resolve.
        write(
            src.path(),
            "clean.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="100" posY="50">
    <elementParameter field="TEXT" name="UNIQUE_NAME" value="in_1"/>
    <elementParameter field="TEXT" name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
</talendfile:ProcessType>
"#,
        );
        write(src.path(), "messy.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.clean(), 1, "the mapped-only job is clean");
        assert_eq!(report.needs_attention(), 1, "the other has a warning");
        assert_eq!(report.failed(), 0, "neither failed to parse");
    }

    #[test]
    fn a_java_routine_is_skipped_rather_than_reported_as_a_failure() {
        // Routines share the extension but are Java source, not XML, so parsing one fails
        // on the HTML in its javadoc. Measured against a real corpus that produced four
        // alarming "FAILED" lines for files that were never jobs - which makes a
        // migration look worse than it is and sends someone chasing nothing.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        // The javadoc closes a tag it never opened, which is what actually breaks the XML
        // reader on a real routine ("expected `</String>`, but `</br>` was found"). A
        // balanced fragment parses fine and would make this test pass without the
        // discriminator existing at all.
        write(
            src.path(),
            "StringHelper.item",
            "package routines;\n\n\
             /**\n \
             * @return <String> the formatted value </br>\n \
             */\n\
             public class StringHelper {\n    \
             public static String get() { return \"x\"; }\n\
             }\n",
        );

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.failed(), 0, "a routine is not a failed job");
        assert_eq!(report.skipped(), 1);
    }

    #[test]
    fn a_corrupt_job_is_still_a_failure() {
        // The other half of the same rule: a file that says it is a job and then will not
        // parse must be reported, or a migration silently loses it.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(
            src.path(),
            "truncated.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="1" posY="1"><elementParameter
"#,
        );

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.failed(), 1, "a broken job file must be reported");
        assert_eq!(report.skipped(), 0);
    }

    #[test]
    fn one_unreadable_file_does_not_end_the_migration() {
        // A corpus of three hundred always contains something odd. Whatever it is, every
        // other job still has to come across, and the odd one still has to be accounted
        // for in the totals rather than vanishing.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "good.item", &job_xml("tSomethingOdd"));
        write(src.path(), "odd.item", "this is not xml at all <<<");

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 2, "the odd file is still accounted for");
        assert_eq!(
            report.skipped(),
            1,
            "it never claimed to be a job, so it is not a failure"
        );
        assert!(
            out.path().join("good.json").exists(),
            "the good job still converted"
        );
    }

    #[test]
    fn an_item_file_that_holds_no_job_is_skipped_not_counted_as_clean() {
        // The extension is shared by routines, contexts and metadata, none of which are
        // jobs. They parse fine and yield nothing, so counting them as converted inflates
        // the headline with empty pipelines - measured against a real corpus, 79 of 125
        // "clean" conversions were empty. A migration number that flatters itself is
        // worse than no number.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "real.item", &job_xml("tSomethingOdd"));
        write(
            src.path(),
            "routine.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
</talendfile:ProcessType>
"#,
        );

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.skipped(), 1, "the routine is not a job");
        assert_eq!(report.clean(), 0, "the only real job has a warning");
        assert_eq!(report.needs_attention(), 1);
        assert!(
            !out.path().join("routine.json").exists(),
            "an empty pipeline must not be written at all"
        );
    }

    #[test]
    fn the_version_suffix_is_dropped_so_callers_resolve() {
        // Studio names the file <Job>_0.1.item but a caller references <Job>, so keeping
        // the suffix leaves every reference dangling. Measured on a real corpus: 20 of 28
        // references resolved only once the suffix was dropped.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "BODY_0.1.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 1);
        assert!(
            out.path().join("BODY.json").exists(),
            "the caller references BODY, so that is the name to write"
        );
        assert!(
            !out.path().join("BODY_0.1.json").exists(),
            "the versioned name is what left references dangling"
        );
    }

    #[test]
    fn two_versions_of_one_job_do_not_overwrite_each_other() {
        // Dropping the suffix makes two exported versions collide. Losing one silently
        // would be worse than an ugly name, so the later one keeps its version.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "BODY_0.1.item", &job_xml("tSomethingOdd"));
        write(src.path(), "BODY_0.2.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 2, "both versions are converted");
        assert!(out.path().join("BODY.json").exists());
        assert!(
            out.path().join("BODY_0.2.json").exists(),
            "the second version must not overwrite the first"
        );
    }

    #[test]
    fn a_call_wanting_rows_from_a_child_that_returns_none_is_reported() {
        // The pair is the only place this can be decided: the caller wants rows and the
        // child never writes any, so the caller would read a file nobody wrote.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(
            src.path(),
            "PARENT_0.1.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tRunJob" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="call_1"/>
    <elementParameter name="PROCESS" value="CHILD"/>
  </node>
  <node componentName="tFileOutputDelimited" posX="200" posY="10">
    <elementParameter name="UNIQUE_NAME" value="out_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/a.csv&quot;"/>
  </node>
  <connection connectorName="FLOW" source="call_1" target="out_1"/>
</talendfile:ProcessType>
"#,
        );
        write(src.path(), "CHILD_0.1.item", &job_xml("tSomethingOdd"));

        let report = import_tree(src.path(), out.path()).unwrap();
        let parent = report.jobs.iter().find(|j| j.name == "PARENT").unwrap();
        assert!(
            parent.warnings.iter().any(|w| w.contains("hands rows back")),
            "got {:?}",
            parent.warnings
        );
    }

    #[test]
    fn a_warehouse_table_the_project_reads_back_is_read_locally_instead() {
        // The point of the move is that intermediate work stops costing warehouse time.
        // A table this project writes and then reads again is intermediate: the write
        // still lands, so nothing downstream can tell the difference, but the read is
        // served from a local mirror instead of going back out.
        //
        // The exception is a read that also needs a table the project does not write.
        // That one still has to run where that table lives, so it stays - and so does
        // the staging table it reads, since a mirror would then be serving only half of
        // what the project asks for.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let attr = |v: serde_json::Value| {
            v.to_string().replace('&', "&amp;").replace('"', "&quot;")
        };
        let sink = |name: &str, table: &str, x: i32| {
            let blob = attr(serde_json::json!({
                "outputAction": {"storedValue": "INSERT"},
                "table": {"tableName": {"storedValue": table}},
            }));
            format!(
                r#"<node componentName="tSnowflakeOutput" posX="{x}" posY="10">
    <elementParameter name="UNIQUE_NAME" value="{name}"/>
    <elementParameter name="PROPERTIES" value="{blob}"/>
  </node>"#
            )
        };
        let source = |name: &str, query: &str, x: i32| {
            let blob = attr(serde_json::json!({"query": {"storedValue": query}}));
            format!(
                r#"<node componentName="tSnowflakeInput" posX="{x}" posY="10">
    <elementParameter name="UNIQUE_NAME" value="{name}"/>
    <elementParameter name="PROPERTIES" value="{blob}"/>
  </node>"#
            )
        };
        write(
            src.path(),
            "J_0.1.item",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="in_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  {w1}
  {r1}
  {w2}
  {r2}
  {wfinal}
  <connection connectorName="FLOW" source="in_1" target="w_1"/>
  <connection connectorName="FLOW" source="in_1" target="w_2"/>
  <connection connectorName="FLOW" source="r_1" target="final_1"/>
  <connection connectorName="SUBJOB_OK" source="w_1" target="r_1"/>
  <connection connectorName="SUBJOB_OK" source="w_2" target="r_2"/>
</talendfile:ProcessType>
"#,
                w1 = sink("w_1", "STAGE_T", 120),
                r1 = source("r_1", "SELECT * FROM STAGE_T WHERE X = 1", 240),
                w2 = sink("w_2", "SHARED_T", 120),
                r2 = source("r_2", "SELECT * FROM SHARED_T JOIN VENDOR_T ON a = b", 240),
                wfinal = sink("final_1", "RESULT_T", 360),
            ),
        );

        let report = import_tree(src.path(), out.path()).unwrap();
        assert_eq!(report.failed(), 0);
        let j: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out.path().join("J.json")).unwrap())
                .unwrap();
        let nodes = j["nodes"].as_array().unwrap().clone();
        let node = |id: &str| {
            nodes
                .iter()
                .find(|n| n["id"] == id)
                .unwrap_or_else(|| panic!("no node {id}"))
                .clone()
        };
        let component = |id: &str| node(id)["data"]["componentId"].as_str().unwrap().to_string();

        // The staging table nothing else complicates: read locally, written to both.
        assert_eq!(component("r_1"), "src.duckdb", "the read no longer leaves the machine");
        assert_eq!(
            node("r_1")["data"]["properties"]["sql"].as_str().unwrap(),
            r#"SELECT * FROM duckle_src."STAGE_T" WHERE X = 1"#,
            "and it reads the mirror rather than a table of the same name"
        );
        assert_eq!(
            component("w_1"),
            "snk.snowflake",
            "the write still lands where it landed before, so nothing downstream changes"
        );
        assert_eq!(component("w_1__local"), "snk.duckdb", "and it also fills the mirror");
        assert_eq!(
            node("w_1__local")["data"]["properties"]["mode"].as_str().unwrap(),
            "append",
            "the mirror is written the same way the original is"
        );
        assert!(
            j["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["source"] == "in_1" && e["target"] == "w_1__local"),
            "fed from whatever fed the write it mirrors"
        );

        // The read that reaches outside the project, and the table it strands.
        assert_eq!(
            component("r_2"),
            "src.snowflake",
            "a read that also needs a table from outside cannot be served locally"
        );
        assert_eq!(
            component("w_2"),
            "snk.snowflake",
            "so the table it reads stays remote, with no mirror to fall out of step"
        );
        assert!(
            !nodes.iter().any(|n| n["id"] == "w_2__local"),
            "a mirror nothing reads is pure cost"
        );

        // The output the project exists to produce.
        assert_eq!(
            component("final_1"),
            "snk.snowflake",
            "a table nobody reads back is a real output and is left alone"
        );
        assert!(!nodes.iter().any(|n| n["id"] == "final_1__local"));
    }

    #[test]
    fn a_read_that_could_run_before_the_write_it_depends_on_is_left_alone() {
        // Reading the mirror is only the same as reading the warehouse if the mirror has
        // been filled by then. Where a job writes a table and reads it back with nothing
        // ordering the two, that is not established, and a local read would turn a table
        // that merely held stale rows into one that is not there at all. So the read is
        // mapped as it was and keeps going to the warehouse.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let attr =
            |v: serde_json::Value| v.to_string().replace('&', "&amp;").replace('"', "&quot;");
        let blob_sink = attr(serde_json::json!({
            "outputAction": {"storedValue": "INSERT"},
            "table": {"tableName": {"storedValue": "STAGE_T"}},
        }));
        let blob_read =
            attr(serde_json::json!({"query": {"storedValue": "SELECT * FROM STAGE_T"}}));
        write(
            src.path(),
            "J_0.1.item",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="in_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  <node componentName="tSnowflakeOutput" posX="120" posY="10">
    <elementParameter name="UNIQUE_NAME" value="w_1"/>
    <elementParameter name="PROPERTIES" value="{blob_sink}"/>
  </node>
  <node componentName="tSnowflakeInput" posX="240" posY="10">
    <elementParameter name="UNIQUE_NAME" value="r_1"/>
    <elementParameter name="PROPERTIES" value="{blob_read}"/>
  </node>
  <node componentName="tFileOutputDelimited" posX="360" posY="10">
    <elementParameter name="UNIQUE_NAME" value="out_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/out.csv&quot;"/>
  </node>
  <connection connectorName="FLOW" source="in_1" target="w_1"/>
  <connection connectorName="FLOW" source="r_1" target="out_1"/>
</talendfile:ProcessType>
"#
            ),
        );

        let report = import_tree(src.path(), out.path()).unwrap();
        assert_eq!(report.failed(), 0);
        let j: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out.path().join("J.json")).unwrap())
                .unwrap();
        let nodes = j["nodes"].as_array().unwrap();
        let component = |id: &str| {
            nodes.iter().find(|n| n["id"] == id).unwrap()["data"]["componentId"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(
            component("r_1"),
            "src.snowflake",
            "nothing says the write happens first, so the read is not moved"
        );
        assert!(
            !nodes.iter().any(|n| n["id"] == "w_1__local"),
            "and no mirror is written for a table nothing reads locally"
        );
    }

    /// A job whose mapper takes a second input from the warehouse.
    ///
    /// `write_after` puts the mapper downstream of the write, which is the ordinary case;
    /// `false` instead has the mapper produce the write, which is a read-modify-write.
    #[cfg(test)]
    fn lookup_job(write_after: bool) -> String {
        let attr = |v: serde_json::Value| {
            v.to_string().replace('&', "&amp;").replace('"', "&quot;")
        };
        let sink = attr(serde_json::json!({
            "outputAction": {"storedValue": "INSERT"},
            "table": {"tableName": {"storedValue": "STAGE_T"}},
        }));
        let read = attr(serde_json::json!({
            "query": {"storedValue": "SELECT * FROM STAGE_T"}
        }));
        // Either the write happens first and the mapper reads afterwards, or the mapper
        // is what produces the write.
        let wiring = if write_after {
            r#"<connection connectorName="FLOW" source="src_1" target="w_1"/>
  <connection connectorName="SUBJOB_OK" source="w_1" target="feed_1"/>
  <connection connectorName="FLOW" source="feed_1" target="map_1"/>
  <connection connectorName="FLOW" source="look_1" target="map_1"/>
  <connection connectorName="FLOW" source="map_1" target="out_1"/>"#
        } else {
            r#"<connection connectorName="FLOW" source="src_1" target="feed_1"/>
  <connection connectorName="FLOW" source="feed_1" target="map_1"/>
  <connection connectorName="FLOW" source="look_1" target="map_1"/>
  <connection connectorName="FLOW" source="map_1" target="w_1"/>"#
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="src_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  <node componentName="tSnowflakeOutput" posX="120" posY="10">
    <elementParameter name="UNIQUE_NAME" value="w_1"/>
    <elementParameter name="PROPERTIES" value="{sink}"/>
  </node>
  <node componentName="tFileInputDelimited" posX="10" posY="120">
    <elementParameter name="UNIQUE_NAME" value="feed_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/feed.csv&quot;"/>
  </node>
  <node componentName="tSnowflakeInput" posX="10" posY="200">
    <elementParameter name="UNIQUE_NAME" value="look_1"/>
    <elementParameter name="PROPERTIES" value="{read}"/>
  </node>
  <node componentName="tMap" posX="240" posY="120">
    <elementParameter name="UNIQUE_NAME" value="map_1"/>
  </node>
  <node componentName="tFileOutputDelimited" posX="360" posY="120">
    <elementParameter name="UNIQUE_NAME" value="out_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/out.csv&quot;"/>
  </node>
  {wiring}
</talendfile:ProcessType>
"#
        )
    }

    #[cfg(test)]
    fn imported_lookup_job(write_after: bool) -> serde_json::Value {
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "J_0.1.item", &lookup_job(write_after));
        let report = import_tree(src.path(), out.path()).unwrap();
        assert_eq!(report.failed(), 0);
        serde_json::from_str(&std::fs::read_to_string(out.path().join("J.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_lookup_takes_its_place_in_the_order_from_what_it_feeds() {
        // A mapper's second input has nothing feeding it, so nothing can be shown to run
        // before it and a rule that asks what precedes it always answers "nothing". Its
        // real place in the order is its mapper's: the lookup is loaded when the mapper
        // runs. Read that way, a write that happens before the mapper happens before the
        // lookup too, and the lookup can be served locally.
        let j = imported_lookup_job(true);
        let nodes = j["nodes"].as_array().unwrap();
        let component = |id: &str| {
            nodes.iter().find(|n| n["id"] == id).unwrap()["data"]["componentId"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(component("look_1"), "src.duckdb");
        assert_eq!(component("w_1__local"), "snk.duckdb");
        assert!(
            j["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["source"] == "w_1__local" && e["target"] == "look_1"),
            "and the lookup is held until the mirror it now reads has been filled"
        );
    }

    #[test]
    fn a_lookup_the_mapper_writes_back_to_is_left_alone() {
        // The same mapper reads the table and produces the write to it. The lookup has to
        // see the table as it was before this run, because what it feeds is what changes
        // it - so it is not the mapper's position that applies here, and holding the
        // lookup until the write landed would feed the mapper its own output.
        let j = imported_lookup_job(false);
        let nodes = j["nodes"].as_array().unwrap();
        assert_eq!(
            nodes.iter().find(|n| n["id"] == "look_1").unwrap()["data"]["componentId"],
            "src.snowflake",
            "a read whose own output becomes the write cannot be served from the write"
        );
        assert!(!nodes.iter().any(|n| n["id"] == "w_1__local"));
    }

    #[test]
    fn a_table_several_steps_write_is_not_mirrored() {
        // The mirror is created by whichever write reaches it first and takes its shape
        // from that one. Where several steps write the same table they rarely carry the
        // same columns - one adds a field the others do not - and the next write then has
        // nowhere to put it. The warehouse table was made once, with room for all of
        // them; a mirror made from one write is not the same table, so it is not made.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let attr =
            |v: serde_json::Value| v.to_string().replace('&', "&amp;").replace('"', "&quot;");
        let sink = |name: &str, table: &str| {
            let blob = attr(serde_json::json!({
                "outputAction": {"storedValue": "INSERT"},
                "table": {"tableName": {"storedValue": table}},
            }));
            format!(
                r#"<node componentName="tSnowflakeOutput" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="{name}"/>
    <elementParameter name="PROPERTIES" value="{blob}"/>
  </node>"#
            )
        };
        let read = attr(serde_json::json!({
            "query": {"storedValue": "SELECT * FROM STAGE_T"}
        }));
        write(
            src.path(),
            "J_0.1.item",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="src_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  {w1}
  {w2}
  <node componentName="tSnowflakeInput" posX="300" posY="10">
    <elementParameter name="UNIQUE_NAME" value="r_1"/>
    <elementParameter name="PROPERTIES" value="{read}"/>
  </node>
  <connection connectorName="FLOW" source="src_1" target="w_1"/>
  <connection connectorName="FLOW" source="src_1" target="w_2"/>
  <connection connectorName="SUBJOB_OK" source="w_1" target="r_1"/>
  <connection connectorName="SUBJOB_OK" source="w_2" target="r_1"/>
</talendfile:ProcessType>
"#,
                w1 = sink("w_1", "STAGE_T"),
                w2 = sink("w_2", "STAGE_T"),
                read = read,
            ),
        );

        let report = import_tree(src.path(), out.path()).unwrap();
        assert_eq!(report.failed(), 0);
        let j: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out.path().join("J.json")).unwrap())
                .unwrap();
        let nodes = j["nodes"].as_array().unwrap();
        assert!(
            !nodes.iter().any(|n| n["id"].as_str().unwrap_or("").ends_with("__local")),
            "no mirror is made for a table more than one step writes"
        );
        assert_eq!(
            nodes.iter().find(|n| n["id"] == "r_1").unwrap()["data"]["componentId"],
            "src.snowflake",
            "so the read stays where the table really is"
        );
    }

    #[test]
    fn a_called_body_is_spliced_into_its_caller() {
        // A body is not runnable on its own: it takes its rows from whoever calls it, and
        // a child pipeline is handed none. Converting the call by reference would leave a
        // job that cannot work, so the body is inlined and not written beside it.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(
            src.path(),
            "CALLER_0.1.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<talendfile:ProcessType xmlns:talendfile="platform:/resource/org.talend.model/model/TalendFile.xsd">
  <node componentName="tFileInputDelimited" posX="10" posY="10">
    <elementParameter name="UNIQUE_NAME" value="in_1"/>
    <elementParameter name="FILENAME" value="&quot;/data/in.csv&quot;"/>
  </node>
  <node componentName="MY_BODY" posX="120" posY="10">
    <elementParameter name="UNIQUE_NAME" value="MY_BODY_1"/>
  </node>
  <node componentName="tFileOutputDelimited" posX="240" posY="10">
    <elementParameter name="UNIQUE_NAME" value="sink_a"/>
    <elementParameter name="FILENAME" value="&quot;/data/a.csv&quot;"/>
  </node>
  <connection connectorName="FLOW" source="in_1" target="MY_BODY_1"/>
  <connection connectorName="OUTPUT_1" source="MY_BODY_1" target="sink_a"/>
</talendfile:ProcessType>
"#,
        );
        write(
            src.path(),
            "MY_BODY_0.1.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:model="platform:/resource/org.talend.model/model/Joblet.xsd">
  <model:JobletProcess>
    <jobletNodes componentName="INPUT" posX="10" posY="10">
      <elementParameter name="UNIQUE_NAME" value="INPUT_1"/>
    </jobletNodes>
    <node componentName="tSortRow" posX="100" posY="10">
      <elementParameter name="UNIQUE_NAME" value="mid_1"/>
    </node>
    <jobletNodes componentName="OUTPUT" posX="200" posY="10">
      <elementParameter name="UNIQUE_NAME" value="OUTPUT_1"/>
    </jobletNodes>
    <connection connectorName="FLOW" source="INPUT_1" target="mid_1"/>
    <connection connectorName="OUTPUT_1" source="mid_1" target="OUTPUT_1"/>
  </model:JobletProcess>
</xmi:XMI>
"#,
        );

        let report = import_tree(src.path(), out.path()).unwrap();

        let caller = std::fs::read_to_string(out.path().join("CALLER.json")).unwrap();
        assert!(caller.contains("MY_BODY_1__mid_1"), "the body's work is in the caller");
        assert!(!caller.contains("ctl.runjob"), "and the call by reference is gone");
        assert!(
            !out.path().join("MY_BODY.json").exists(),
            "a spliced body is not a pipeline of its own"
        );
        assert_eq!(report.failed(), 0);
    }

    #[test]
    fn a_joblet_is_imported_not_skipped() {
        // A joblet holds the reusable body a job calls into, so skipping it leaves every
        // caller pointing at nothing. It declares itself with JobletProcess rather than
        // ProcessType, which is the only thing that distinguished it from a job here.
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(
            src.path(),
            "body.item",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:model="platform:/resource/org.talend.model/model/Joblet.xsd">
  <model:JobletProcess>
    <node componentName="tFileInputDelimited" posX="100" posY="50">
      <elementParameter field="TEXT" name="UNIQUE_NAME" value="in_1"/>
      <elementParameter field="TEXT" name="FILENAME" value="&quot;/data/in.csv&quot;"/>
    </node>
    <node componentName="tFileOutputDelimited" posX="300" posY="50">
      <elementParameter field="TEXT" name="UNIQUE_NAME" value="out_1"/>
      <elementParameter field="TEXT" name="FILENAME" value="&quot;/data/out.csv&quot;"/>
    </node>
    <connection connectorName="FLOW" source="in_1" target="out_1"/>
  </model:JobletProcess>
</xmi:XMI>
"#,
        );

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.skipped(), 0, "a joblet is a job body, not a non-job");
        assert_eq!(report.jobs.len(), 1, "the joblet must be converted");
        assert!(
            out.path().join("body.json").exists(),
            "a caller can only resolve the joblet if it was written"
        );
    }

    #[test]
    fn files_that_are_not_jobs_are_left_alone() {
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        write(src.path(), "a.item", &job_xml("tSomethingOdd"));
        write(src.path(), "notes.txt", "ignore me");
        write(src.path(), "job.properties", "also ignore me");

        let report = import_tree(src.path(), out.path()).unwrap();

        assert_eq!(report.jobs.len(), 1, "only the .item file is a job");
    }
}

//! Running tests: pytest (or unittest when pytest isn't installed) for Python, and JUnit
//! through Maven or Gradle for Java. Output streams to the Output pane like any run; the
//! results come back as one `test-results` event read from the JUnit XML report.
use crate::{
    process::{command, python, Jobs},
    tools::find,
    workspace::{err, relative, root, Result},
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone, Default)]
pub struct TestResult {
    pub name: String,
    pub group: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub status: String,
    pub message: String,
    pub seconds: f64,
}

#[derive(Serialize, Clone, Default)]
pub struct Coverage {
    covered: Vec<u32>,
    missed: Vec<u32>,
}

#[derive(Serialize, Clone)]
struct TestReport {
    id: String,
    tool: String,
    results: Vec<TestResult>,
    /// Lines run and not run by the tests, per file (pytest-cov for Python, JaCoCo for Java).
    coverage: Option<std::collections::HashMap<String, Coverage>>,
}

/// Sends the results (and coverage) of a test run to the window (also for runs on a server or in a container).
pub(crate) fn emit_report(app: &AppHandle, id: String, tool: String, results: Vec<TestResult>, coverage: Option<std::collections::HashMap<String, Coverage>>) {
    let _ = app.emit("test-results", TestReport { id, tool, results, coverage });
}

/// Reads coverage.py's JSON report: { files: { path: { executed_lines, missing_lines } } }.
pub(crate) fn parse_coverage(json: &str, cwd: &Path) -> std::collections::HashMap<String, Coverage> {
    let mut found = std::collections::HashMap::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return found };
    let lines = |item: &serde_json::Value, key: &str| item[key].as_array().map(|list| list.iter().filter_map(|line| line.as_u64().map(|line| line as u32)).collect()).unwrap_or_default();
    for (path, item) in value["files"].as_object().into_iter().flatten() {
        let full = cwd.join(path);
        let relative = full.strip_prefix(cwd).map(|path| path.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.replace('\\', "/"));
        found.insert(relative, Coverage { covered: lines(item, "executed_lines"), missed: lines(item, "missing_lines") });
    }
    found
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#10;", "\n").replace("&amp;", "&")
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(unescape(&tag[start..end]))
}

/// Reads <testcase> entries from a JUnit XML report (pytest, Maven Surefire and Gradle all write it).
pub fn parse_junit(xml: &str, results: &mut Vec<TestResult>) {
    let mut rest = xml;
    while let Some(start) = rest.find("<testcase") {
        rest = &rest[start..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        let self_closing = tag.ends_with('/');
        let body_end = if self_closing { tag_end + 1 } else { rest.find("</testcase>").map(|at| at + "</testcase>".len()).unwrap_or(tag_end + 1) };
        let body = &rest[tag_end + 1..body_end.max(tag_end + 1)];
        let mut result = TestResult {
            name: attribute(tag, "name").unwrap_or_default(),
            group: attribute(tag, "classname").unwrap_or_default(),
            file: attribute(tag, "file"),
            line: attribute(tag, "line").and_then(|line| line.parse::<u32>().ok()).map(|line| line + 1),
            status: "passed".into(),
            message: String::new(),
            seconds: attribute(tag, "time").and_then(|time| time.parse().ok()).unwrap_or(0.0),
        };
        for (marker, status) in [("<failure", "failed"), ("<error", "error"), ("<skipped", "skipped")] {
            if let Some(at) = body.find(marker) {
                result.status = status.into();
                let inner = &body[at..];
                let close = inner.find('>').unwrap_or(0);
                let mut message = attribute(&inner[..close], "message").unwrap_or_default();
                if !inner[..close].ends_with('/') {
                    if let Some(end) = inner.find(&format!("</{}", &marker[1..])) {
                        let text = unescape(inner[close + 1..end].trim());
                        if !text.is_empty() { message = if message.is_empty() { text } else { format!("{message}\n\n{text}") } }
                    }
                }
                result.message = message.chars().take(6000).collect();
                break;
            }
        }
        results.push(result);
        rest = &rest[body_end.max(tag_end + 1)..];
    }
}


fn report_dir() -> PathBuf {
    std::env::temp_dir().join(format!("still-tests-{}", std::process::id()))
}

/// Runs tests. `target` is empty for all tests, a file path, or a test id (`path::name`,
/// `path::Class::name` for Python, `Class#method` for Java).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn tests_run(app: AppHandle, jobs: State<Jobs>, root_path: String, id: String, target: Option<String>, language: String, dotenv: Option<bool>, coverage: Option<bool>) -> Result<()> {
    let cwd = root(&root_path)?;
    let vars = crate::process::project_env(&cwd, dotenv.unwrap_or(true), None);
    let want_coverage = coverage.unwrap_or(false);
    let target = target.filter(|value| !value.trim().is_empty());
    if let Some(value) = &target {
        let path_part = value.split("::").next().unwrap_or("");
        if language == "python" && path_part.contains('/') || path_part.ends_with(".py") { relative(path_part)?; }
        if value.starts_with('-') { return Err("Unknown test.".into()); }
    }
    let events = app.clone();
    let report_id = id.clone();
    jobs.start(app, id, true, move |job| {
        job.use_env(vars);
        let reports = report_dir();
        let _ = std::fs::remove_dir_all(&reports);
        std::fs::create_dir_all(&reports).map_err(err)?;
        let mut results = Vec::new();
        let mut java_coverage = None;
        let (code, tool) = if language == "java" {
            run_java(job, &cwd, target.as_deref(), &reports, &mut results, want_coverage.then_some(&mut java_coverage))?
        } else {
            run_python(job, &cwd, target.as_deref(), &reports, &mut results, want_coverage)?
        };
        let coverage = java_coverage.or_else(|| std::fs::read_to_string(reports.join("coverage.json")).ok().map(|json| parse_coverage(&json, &cwd)));
        let _ = events.emit("test-results", TestReport { id: report_id, tool, results, coverage });
        let _ = std::fs::remove_dir_all(&reports);
        Ok((code, Vec::new()))
    })
}

fn run_python(job: &crate::process::Job, cwd: &Path, target: Option<&str>, reports: &Path, results: &mut Vec<TestResult>, coverage: bool) -> Result<(i32, String)> {
    let (interpreter, _, _) = python(cwd).ok_or("Python 3 was not found on PATH or in .venv.")?;
    let has_pytest = command(&interpreter, cwd).args(["-c", "import pytest"]).output().is_ok_and(|out| out.status.success());
    if has_pytest {
        let report = reports.join("pytest.xml");
        let mut cmd = command(&interpreter, cwd);
        cmd.env("PYTHONIOENCODING", "utf-8").args(["-m", "pytest", "-q", "--tb=short", "-o", "junit_family=xunit1", "-p", "no:cacheprovider"]).arg(format!("--junitxml={}", report.to_string_lossy()));
        if coverage {
            if command(&interpreter, cwd).args(["-c", "import pytest_cov"]).output().is_ok_and(|out| out.status.success()) {
                cmd.arg("--cov=.").arg(format!("--cov-report=json:{}", reports.join("coverage.json").to_string_lossy())).arg("--cov-report=");
            } else {
                job.emit("stderr", "Coverage needs pytest-cov: pip install pytest-cov\n".into());
            }
        }
        if let Some(value) = target { cmd.arg(value); }
        job.emit("command", format!("$ python -m pytest -q{}\n", target.map(|value| format!(" {value}")).unwrap_or_default()));
        let (code, _) = job.run(&mut cmd, false)?;
        if let Ok(xml) = std::fs::read_to_string(&report) { parse_junit(&xml, results); }
        return Ok((code, "pytest".into()));
    }
    // unittest: no XML report, so read its verbose output.
    let mut cmd = command(&interpreter, cwd);
    cmd.env("PYTHONIOENCODING", "utf-8").args(["-m", "unittest"]);
    match target {
        Some(value) => {
            let mut parts = value.split("::");
            let module = parts.next().unwrap_or("").trim_end_matches(".py").replace('/', ".");
            let rest: Vec<&str> = parts.collect();
            cmd.arg("-v").arg(if rest.is_empty() { module } else { format!("{module}.{}", rest.join(".")) });
        }
        None => { cmd.args(["discover", "-v"]); }
    }
    job.emit("command", "$ python -m unittest -v (install pytest for richer results)\n".into());
    let (code, output) = job.run(&mut cmd, true)?;
    for line in output.lines() {
        // test_name (module.Class.test_name) ... ok | FAIL | ERROR | skipped
        let Some((head, outcome)) = line.rsplit_once(" ... ") else { continue };
        let name = head.split(' ').next().unwrap_or("").to_owned();
        let group = head.split_once('(').map(|(_, group)| group.trim_end_matches(')').to_owned()).unwrap_or_default();
        let status = match outcome.trim() { "ok" => "passed", "FAIL" => "failed", "ERROR" => "error", other if other.starts_with("skipped") => "skipped", _ => continue };
        results.push(TestResult { name, group, status: status.into(), ..Default::default() });
    }
    Ok((code, "unittest".into()))
}

/// JaCoCo through the build without changing it: Maven runs the plugin's goals by name; Gradle
/// gets an init script that applies the jacoco plugin and asks for the XML report.
pub(crate) const JACOCO: &str = "org.jacoco:jacoco-maven-plugin:0.8.12";
pub(crate) const GRADLE_JACOCO: &str = r#"
allprojects { project ->
    project.pluginManager.withPlugin('java') {
        project.pluginManager.apply('jacoco')
        project.tasks.named('test').configure { finalizedBy project.tasks.named('jacocoTestReport') }
        project.tasks.named('jacocoTestReport').configure {
            reports {
                try { xml.required = true } catch (ignored) { xml.enabled = true }
            }
        }
    }
}
"#;

fn run_java(job: &crate::process::Job, cwd: &Path, target: Option<&str>, reports: &Path, results: &mut Vec<TestResult>, coverage: Option<&mut Option<std::collections::HashMap<String, Coverage>>>) -> Result<(i32, String)> {
    let gradle_wrapper = cwd.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
    let want = coverage.is_some();
    let (mut cmd, tool, report_dirs) = if cwd.join("pom.xml").is_file() {
        let maven = find(cwd, "mvn").ok_or("Maven (mvn) was not found on PATH.")?;
        let mut cmd = command(maven, cwd);
        cmd.args(["-q", "-B"]);
        if want { cmd.arg(format!("{JACOCO}:prepare-agent")); }
        cmd.arg("test");
        // The report even when a test fails, so you see what ran.
        if want { cmd.arg(format!("{JACOCO}:report")).arg("-Dmaven.test.failure.ignore=true"); }
        if let Some(value) = target { cmd.arg(format!("-Dtest={value}")).arg("-Dsurefire.failIfNoSpecifiedTests=false"); }
        (cmd, "maven", vec![cwd.join("target/surefire-reports")])
    } else if cwd.join("build.gradle").is_file() || cwd.join("build.gradle.kts").is_file() {
        let gradle = if gradle_wrapper.is_file() { gradle_wrapper } else { find(cwd, "gradle").ok_or("Gradle was not found. Add the Gradle wrapper (gradlew) to the project.")? };
        let mut cmd = command(gradle, cwd);
        cmd.args(["test", "--console=plain"]);
        if want {
            let script = reports.join("still-jacoco.gradle");
            std::fs::write(&script, GRADLE_JACOCO).map_err(err)?;
            cmd.arg("--init-script").arg(&script).arg("--continue");
        }
        if let Some(value) = target { cmd.arg("--tests").arg(value.replace('#', ".")); }
        (cmd, "gradle", vec![cwd.join("build/test-results/test")])
    } else {
        return Err("Java tests run through Maven (pom.xml) or Gradle (build.gradle). Add one to this project to run JUnit tests.".into());
    };
    for dir in &report_dirs { let _ = std::fs::remove_dir_all(dir); }
    let xml_reports = jacoco_reports(cwd);
    for report in &xml_reports { let _ = std::fs::remove_file(report); }
    job.emit("command", format!("$ {tool} test{}{}\n", target.map(|value| format!(" {value}")).unwrap_or_default(), if want { " (with JaCoCo coverage)" } else { "" }));
    let (code, _) = job.run(&mut cmd, false)?;
    if let Some(slot) = coverage {
        let mut found = std::collections::HashMap::new();
        let sources = java_sources(cwd);
        for report in jacoco_reports(cwd) {
            if let Ok(xml) = std::fs::read_to_string(&report) { parse_jacoco(&xml, &sources, &mut found); }
        }
        if found.is_empty() { job.emit("stderr", "No JaCoCo report was made, so there's no coverage this time.\n".into()); }
        *slot = Some(found);
    }
    for dir in report_dirs {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry.path().extension().is_some_and(|ext| ext == "xml") {
                if let Ok(xml) = std::fs::read_to_string(entry.path()) { parse_junit(&xml, results); }
            }
        }
    }
    Ok((code, tool.into()))
}

/// Where Maven and Gradle put JaCoCo's XML report, for this project and its modules.
pub(crate) fn jacoco_reports(cwd: &Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![cwd.to_path_buf()];
    for entry in std::fs::read_dir(cwd).into_iter().flatten().flatten() {
        if entry.path().is_dir() && (entry.path().join("pom.xml").is_file() || entry.path().join("build.gradle").is_file() || entry.path().join("build.gradle.kts").is_file()) { folders.push(entry.path()); }
    }
    for folder in folders {
        for report in ["target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml"] { found.push(folder.join(report)); }
    }
    found
}

/// Java files in the project by their package path ("com/shop/Cart.java" → "src/main/java/com/shop/Cart.java").
pub(crate) fn java_sources(cwd: &Path) -> std::collections::HashMap<String, String> {
    let mut found = std::collections::HashMap::new();
    let mut pending = vec![cwd.to_path_buf()];
    let mut seen = 0;
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !name.starts_with('.') && !matches!(name.as_str(), "target" | "build" | "node_modules" | "out" | "bin") { pending.push(path); }
            } else if name.ends_with(".java") {
                seen += 1;
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                let package = text.lines().find_map(|line| line.trim().strip_prefix("package ").map(|rest| rest.trim_end_matches(';').trim().replace('.', "/"))).unwrap_or_default();
                let key = if package.is_empty() { name.clone() } else { format!("{package}/{name}") };
                let relative = path.strip_prefix(cwd).map(|item| item.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                found.entry(key).or_insert(relative);
            }
            if seen > 5000 { return found; }
        }
    }
    found
}

/// JaCoCo's XML: <package name="com/shop"><sourcefile name="Cart.java"><line nr="5" mi="0" ci="3" …/>.
pub(crate) fn parse_jacoco(xml: &str, sources: &std::collections::HashMap<String, String>, found: &mut std::collections::HashMap<String, Coverage>) {
    let mut package = String::new();
    let mut file: Option<String> = None;
    for tag in xml.split('<').skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        if tag.starts_with("package ") { package = attribute(tag, "name").unwrap_or_default(); }
        else if tag.starts_with("sourcefile ") {
            let name = attribute(tag, "name").unwrap_or_default();
            let key = if package.is_empty() { name } else { format!("{package}/{name}") };
            file = sources.get(&key).cloned();
        } else if tag.starts_with("/sourcefile") { file = None; }
        else if tag.starts_with("line ") {
            let Some(path) = &file else { continue };
            let number = attribute(tag, "nr").and_then(|value| value.parse::<u32>().ok());
            let covered = attribute(tag, "ci").and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
            let missed = attribute(tag, "mi").and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
            let Some(number) = number else { continue };
            let entry = found.entry(path.clone()).or_default();
            if covered > 0 { entry.covered.push(number) } else if missed > 0 { entry.missed.push(number) }
        }
    }
}

#[cfg(test)]
mod check {
    #[test]
    fn reads_junit() {
        let xml = r#"<testsuite><testcase classname="tests.test_a" file="tests/test_a.py" line="3" name="test_ok" time="0.01"/><testcase classname="tests.test_a" file="tests/test_a.py" line="6" name="test_bad" time="0.02"><failure message="assert 1 == 2">tests/test_a.py:8: AssertionError</failure></testcase></testsuite>"#;
        let mut results = Vec::new();
        super::parse_junit(xml, &mut results);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].status, "passed");
        assert_eq!(results[1].status, "failed");
        assert_eq!(results[1].line, Some(7));
        assert!(results[1].message.contains("AssertionError"));
    }

    #[test]
    fn reads_jacoco() {
        let xml = r#"<report name="cart"><package name="com/shop"><class name="com/shop/Cart"/><sourcefile name="Cart.java"><line nr="3" mi="0" ci="3" mb="0" cb="0"/><line nr="5" mi="0" ci="4" mb="0" cb="0"/><line nr="9" mi="2" ci="0" mb="2" cb="0"/></sourcefile></package></report>"#;
        let sources = std::collections::HashMap::from([("com/shop/Cart.java".to_owned(), "src/main/java/com/shop/Cart.java".to_owned())]);
        let mut found = std::collections::HashMap::new();
        super::parse_jacoco(xml, &sources, &mut found);
        let cart = &found["src/main/java/com/shop/Cart.java"];
        assert_eq!(cart.covered, vec![3, 5]);
        assert_eq!(cart.missed, vec![9]);
    }
}

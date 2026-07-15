use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

fn recipe_check() -> Command {
    Command::new(env!("CARGO_BIN_EXE_recipe-check"))
}

fn run_snapshot(input: &str) -> std::process::Output {
    let mut child = recipe_check()
        .args(["--snapshot", "-", "--profile", "ci", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn recipe-check");
    child
        .stdin
        .take()
        .expect("snapshot stdin")
        .write_all(input.as_bytes())
        .expect("write snapshot");
    child.wait_with_output().expect("wait for recipe-check")
}

#[test]
fn snapshot_stdin_matches_directory_diagnostics() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let recipe_dir = std::env::temp_dir().join(format!(
        "pi-recipe-check-cli-snapshot-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&recipe_dir).expect("create recipe directory");

    let directory_output = recipe_check()
        .arg(&recipe_dir)
        .args(["--profile", "ci", "--json"])
        .output()
        .expect("check directory");
    let snapshot_output = run_snapshot(r#"{"files":[],"directories":[]}"#);
    fs::remove_dir_all(&recipe_dir).expect("remove recipe directory");

    assert_eq!(directory_output.status.code(), Some(1));
    assert_eq!(snapshot_output.status.code(), Some(1));
    let directory: Value =
        serde_json::from_slice(&directory_output.stdout).expect("directory report");
    let snapshot: Value = serde_json::from_slice(&snapshot_output.stdout).expect("snapshot report");
    assert_eq!(snapshot["profile"], directory["profile"]);
    assert_eq!(snapshot["diagnostics"], directory["diagnostics"]);
    assert_eq!(snapshot["resources"], directory["resources"]);
}

#[test]
fn snapshot_can_be_read_from_a_file() {
    let path = std::env::temp_dir().join(format!(
        "pi-recipe-check-snapshot-{}.json",
        std::process::id()
    ));
    fs::write(&path, serde_json::to_vec(&json!({ "files": [] })).unwrap()).expect("write snapshot");
    let output = recipe_check()
        .arg("--snapshot")
        .arg(&path)
        .arg("--json")
        .output()
        .expect("check snapshot");
    fs::remove_file(path).expect("remove snapshot");

    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).expect("snapshot report");
    assert_eq!(report["diagnostics"][0]["code"], "package.manifest_missing");
}

#[test]
fn malformed_snapshot_is_an_operational_error() {
    let output = run_snapshot("not json");

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("failed to parse recipe snapshot from stdin"));
}

#[test]
fn snapshot_and_recipe_directory_are_mutually_exclusive() {
    let output = recipe_check()
        .args([".", "--snapshot", "-"])
        .output()
        .expect("invoke recipe-check");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used with"));
}

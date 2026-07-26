use std::io::Read;
use std::process::ExitCode;

use recipe_check::{check_recipe_files, CheckProfile, RecipeFiles};

fn profile(args: &[String]) -> Result<CheckProfile, String> {
    let value = args
        .windows(2)
        .find_map(|pair| (pair[0] == "--profile").then_some(pair[1].as_str()))
        .unwrap_or("local");
    match value {
        "local" => Ok(CheckProfile::Local),
        "ci" => Ok(CheckProfile::Ci),
        "publish" => Ok(CheckProfile::Publish),
        _ => Err(format!("unknown check profile: {value}")),
    }
}

fn run() -> Result<ExitCode, String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !args.windows(2).any(|pair| pair == ["--snapshot", "-"]) {
        return Err(
            "recipe-check is an internal snapshot validator; expected --snapshot -".to_owned(),
        );
    }
    if !args.iter().any(|arg| arg == "--json") {
        return Err("recipe-check requires --json".to_owned());
    }

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read recipe snapshot: {error}"))?;
    let files: RecipeFiles = serde_json::from_str(&input)
        .map_err(|error| format!("failed to parse recipe snapshot: {error}"))?;
    let report = check_recipe_files(&files, profile(&args)?);
    println!(
        "{}",
        serde_json::to_string(&report)
            .map_err(|error| format!("failed to serialize check report: {error}"))?
    );
    Ok(if report.valid {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

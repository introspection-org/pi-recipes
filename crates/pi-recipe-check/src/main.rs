use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use pi_recipe_check::{check_recipe, check_recipe_files, render_human, CheckProfile, RecipeFiles};

#[derive(Debug, Parser)]
#[command(name = "recipe-check", about = "Check a Pi recipe package")]
struct Cli {
    /// Recipe directory to check.
    #[arg(conflicts_with = "snapshot")]
    recipe_dir: Option<PathBuf>,

    /// Read a serialized recipe snapshot from PATH (`-` for stdin).
    #[arg(long, value_name = "PATH", conflicts_with = "recipe_dir")]
    snapshot: Option<PathBuf>,

    /// Emit a machine-readable JSON report.
    #[arg(long)]
    json: bool,

    /// Validation profile.
    #[arg(long, value_enum, default_value = "local")]
    profile: ProfileArg,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ProfileArg {
    Local,
    Ci,
    Publish,
}

impl From<ProfileArg> for CheckProfile {
    fn from(value: ProfileArg) -> Self {
        match value {
            ProfileArg::Local => Self::Local,
            ProfileArg::Ci => Self::Ci,
            ProfileArg::Publish => Self::Publish,
        }
    }
}

fn run() -> Result<ExitCode> {
    let cli = Cli::parse();
    let profile = cli.profile.into();
    let report = match cli.snapshot {
        Some(path) => check_recipe_files(&read_snapshot(&path)?, profile),
        None => check_recipe(
            cli.recipe_dir.unwrap_or_else(|| PathBuf::from(".")),
            profile,
        )?,
    };
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", render_human(&report));
    }

    if report.valid {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::from(1))
    }
}

fn read_snapshot(path: &Path) -> Result<RecipeFiles> {
    let mut input = String::new();
    if path == Path::new("-") {
        std::io::stdin()
            .read_to_string(&mut input)
            .context("failed to read recipe snapshot from stdin")?;
    } else {
        input = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read recipe snapshot {}", path.display()))?;
    }
    serde_json::from_str(&input).with_context(|| {
        if path == Path::new("-") {
            "failed to parse recipe snapshot from stdin".to_owned()
        } else {
            format!("failed to parse recipe snapshot {}", path.display())
        }
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("{err:#}");
            ExitCode::from(2)
        }
    }
}

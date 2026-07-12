use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::{Parser, ValueEnum};
use pi_recipe_check::{check_recipe, render_human, CheckProfile};

#[derive(Debug, Parser)]
#[command(name = "recipe-check", about = "Check a Pi recipe package")]
struct Cli {
    /// Recipe directory to check.
    #[arg(default_value = ".")]
    recipe_dir: PathBuf,

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
    let report = check_recipe(&cli.recipe_dir, cli.profile.into())?;
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

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("{err:#}");
            ExitCode::from(1)
        }
    }
}

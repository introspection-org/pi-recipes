//! Filesystem front-end for the pure validation core.
//!
//! Walks a recipe directory into a [`RecipeFiles`] snapshot and runs
//! [`check_recipe_files`]. Content is read only for the files the core
//! inspects: `package.json`, `.pi/mcp.local.example.json`, and YAML files
//! (agent definitions can match anywhere via `package.json#pi` patterns).

use std::path::{Component, Path};

use anyhow::{Context, Result};
use walkdir::WalkDir;

use crate::{check_recipe_files, CheckProfile, RecipeFile, RecipeFiles, Report};

/// Validate the recipe rooted at `recipe_dir`.
pub fn check_recipe(recipe_dir: impl AsRef<Path>, profile: CheckProfile) -> Result<Report> {
    let root = recipe_dir.as_ref().canonicalize().with_context(|| {
        format!(
            "failed to resolve recipe directory {}",
            recipe_dir.as_ref().display()
        )
    })?;
    let input = collect_recipe_files(&root)?;
    let mut report = check_recipe_files(&input, profile);
    report.recipe_dir = root.display().to_string();
    Ok(report)
}

/// Walk `root` into an in-memory snapshot for [`check_recipe_files`].
pub fn collect_recipe_files(root: &Path) -> Result<RecipeFiles> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.with_context(|| format!("failed to walk {}", root.display()))?;
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let path = path_to_slashes(relative);
        if path.is_empty() {
            continue;
        }
        if entry.file_type().is_dir() {
            directories.push(path);
        } else if entry.file_type().is_file() {
            let content = if needs_content(&path) {
                Some(
                    std::fs::read_to_string(entry.path())
                        .with_context(|| format!("failed to read {}", entry.path().display()))?,
                )
            } else {
                None
            };
            files.push(RecipeFile { path, content });
        }
    }
    Ok(RecipeFiles { files, directories })
}

fn needs_content(path: &str) -> bool {
    path == "package.json"
        || path == ".pi/mcp.local.example.json"
        || path.ends_with(".yaml")
        || path.ends_with(".yml")
}

fn path_to_slashes(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_recipe(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("pi-recipe-check-{name}-{suffix}"));
        fs::create_dir_all(root.join("agents")).expect("create recipe dirs");
        root
    }

    #[test]
    fn checks_recipe_from_disk() {
        let root = temp_recipe("fs-roundtrip");
        fs::write(
            root.join("package.json"),
            concat!(
                "{\n",
                "  \"name\": \"fs-test\",\n",
                "  \"description\": \"Test recipe\",\n",
                "  \"pi\": { \"agents\": [\"agents/*.yaml\"] }\n",
                "}\n"
            ),
        )
        .expect("write package");
        fs::write(
            root.join("agents").join("agent.yaml"),
            concat!(
                "name: agent\n",
                "description: Test agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "  thinking_level: low\n",
                "tools: []\n",
                "skills: []\n",
                "subagents: []\n",
                "system_instructions:\n",
                "  content: Test instructions\n",
            ),
        )
        .expect("write agent");

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(report.package_name.as_deref(), Some("fs-test"));
        assert_eq!(report.resources.get("agents"), Some(&1));
        assert_ne!(report.recipe_dir, ".");
    }

    #[test]
    fn missing_directory_is_an_error() {
        let missing = std::env::temp_dir().join("pi-recipe-check-does-not-exist");
        let result = check_recipe(&missing, CheckProfile::Local);
        assert!(result.is_err());
    }
}

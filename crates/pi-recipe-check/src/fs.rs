//! Filesystem front-end for the pure validation core.
//!
//! Walks a recipe directory into a [`RecipeFiles`] snapshot and runs
//! [`check_recipe_files`]. Content is read only for the files the core
//! inspects: `package.json`, `.pi/mcp.local.example.json`, and YAML files
//! (agent definitions can match anywhere via `package.json#pi` patterns;
//! judges are direct children of `judges/`).

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
///
/// Symlinks are never traversed recursively, but a symlink to a file or
/// directory is classified by its target so symlinked manifests, lockfiles,
/// and agent directories stay visible; a symlinked directory additionally
/// gets a one-level enumeration of its files (matching the read-a-directory
/// behaviour of the pre-snapshot checker). Broken symlinks are skipped.
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
            files.push(read_recipe_file(entry.path(), path)?);
        } else if entry.file_type().is_symlink() {
            // Classify by the symlink target; std::fs::metadata follows links.
            let Ok(metadata) = std::fs::metadata(entry.path()) else {
                continue;
            };
            if metadata.is_file() {
                files.push(read_recipe_file(entry.path(), path)?);
            } else if metadata.is_dir() {
                collect_symlinked_dir(entry.path(), &path, &mut files, &mut directories)?;
            }
        }
    }
    Ok(RecipeFiles { files, directories })
}

/// One-level enumeration of a symlinked directory: record its files (and
/// immediate subdirectories) without descending further, so no symlink chain
/// is ever walked recursively.
fn collect_symlinked_dir(
    dir: &Path,
    relative: &str,
    files: &mut Vec<RecipeFile>,
    directories: &mut Vec<String>,
) -> Result<()> {
    directories.push(relative.to_owned());
    let entries = std::fs::read_dir(dir)
        .with_context(|| format!("failed to read symlinked directory {}", dir.display()))?;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let child_path = format!("{relative}/{name}");
        let Ok(metadata) = std::fs::metadata(entry.path()) else {
            continue;
        };
        if metadata.is_file() {
            files.push(read_recipe_file(&entry.path(), child_path)?);
        } else if metadata.is_dir() {
            directories.push(child_path);
        }
    }
    Ok(())
}

fn read_recipe_file(disk_path: &Path, path: String) -> Result<RecipeFile> {
    let content = if needs_content(&path) {
        Some(
            std::fs::read_to_string(disk_path)
                .with_context(|| format!("failed to read {}", disk_path.display()))?,
        )
    } else {
        None
    };
    Ok(RecipeFile { path, content })
}

fn needs_content(path: &str) -> bool {
    path == "package.json"
        || path == "package-lock.json"
        || path == "npm-shrinkwrap.json"
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
    fn checks_judge_yaml_from_disk_through_the_shared_core() {
        let root = temp_recipe("fs-judge");
        fs::create_dir_all(root.join("judges")).expect("create judges dir");
        fs::write(
            root.join("package.json"),
            concat!(
                "{\n",
                "  \"name\": \"fs-judge-test\",\n",
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
        fs::write(
            root.join("judges").join("invalid.yml"),
            "judge: helpful\ninstructions: Grade it.\nllm:\n  model: ''\n",
        )
        .expect("write judge");

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert_eq!(report.resources.get("judges"), Some(&1));
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "judge.llm.model_invalid" && diagnostic.path == "judges/invalid.yml"
        }));
    }

    #[test]
    fn missing_directory_is_an_error() {
        let missing = std::env::temp_dir().join("pi-recipe-check-does-not-exist");
        let result = check_recipe(&missing, CheckProfile::Local);
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinked_manifest_and_agents_directory() {
        use std::os::unix::fs::symlink;

        let root = temp_recipe("fs-symlinks");
        let shared = root.join("shared");
        fs::create_dir_all(shared.join("agents-src")).expect("create shared dirs");
        fs::write(
            shared.join("package.json"),
            concat!(
                "{\n",
                "  \"name\": \"symlink-test\",\n",
                "  \"description\": \"Test recipe\",\n",
                "  \"dependencies\": { \"left-pad\": \"^1.0.0\" },\n",
                "  \"pi\": { \"agents\": [\"agents\"] }\n",
                "}\n"
            ),
        )
        .expect("write package");
        fs::write(shared.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").expect("write lockfile");
        fs::write(
            shared.join("agents-src").join("agent.yaml"),
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

        fs::remove_dir_all(root.join("agents")).expect("drop empty agents dir");
        symlink(shared.join("package.json"), root.join("package.json"))
            .expect("symlink package.json");
        symlink(shared.join("pnpm-lock.yaml"), root.join("pnpm-lock.yaml"))
            .expect("symlink lockfile");
        symlink(shared.join("agents-src"), root.join("agents")).expect("symlink agents dir");

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(report.package_name.as_deref(), Some("symlink-test"));
        assert_eq!(report.resources.get("agents"), Some(&1));
    }
}

//! Pure validation library for Recipe packages.
//!
//! The core API is I/O-free: [`check_recipe_files`] takes an in-memory
//! [`RecipeFiles`] snapshot of a recipe directory and returns a [`Report`].
//! The Introspection CLI owns filesystem discovery and presents snapshots to
//! this library.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

mod judges;
pub mod resources;
pub mod spec;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckProfile {
    Local,
    Ci,
    Publish,
}

/// In-memory snapshot of a recipe directory.
///
/// Paths are relative to the recipe root and use `/` separators. Every
/// ancestor of a file path is implicitly a directory; `directories` only
/// needs entries for directories that contain no files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFiles {
    pub files: Vec<RecipeFile>,
    #[serde(default)]
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFile {
    pub path: String,
    /// File content, when the host chose to read it. `None` means the file
    /// exists but its content was not supplied; checks that need the content
    /// report it as unreadable.
    pub content: Option<String>,
}

impl RecipeFile {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: Some(content.into()),
        }
    }

    pub fn unread(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub valid: bool,
    pub profile: CheckProfile,
    pub recipe_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub resources: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

/// 1-based source location of a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub const fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }
}

type JsonMap = serde_json::Map<String, JsonValue>;

#[derive(Debug, Clone)]
struct Package {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    license: Option<String>,
    pi: Option<JsonValue>,
    runtime_dependencies: bool,
}

#[derive(Debug, Clone)]
struct ResourcePatterns {
    explicit: bool,
    patterns: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawAgent {
    name: String,
    fallback_name: String,
    explicit_name: bool,
    path: String,
    from: Option<String>,
    fields: HashSet<AgentField>,
    mcp: Option<AgentMcpConfig>,
}

#[derive(Debug, Clone, Default)]
struct McpToolSelectors {
    include: Option<BTreeSet<String>>,
    exclude: Option<BTreeSet<String>>,
}

type McpToolPolicy = BTreeMap<String, McpToolSelectors>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMcpMode {
    Cli,
    Tools,
}

#[derive(Debug, Clone, Default)]
struct AgentMcpConfig {
    mode: Option<AgentMcpMode>,
    servers: BTreeMap<String, McpToolSelectors>,
    initial_tools: Option<BTreeMap<String, BTreeSet<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AgentField {
    ModelName,
    ModelThinkingLevel,
    Tools,
    Skills,
    Subagents,
    SystemInstructions,
}

impl AgentField {
    const REQUIRED: [Self; 4] = [
        Self::ModelName,
        Self::ModelThinkingLevel,
        Self::Tools,
        Self::SystemInstructions,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::ModelName => "model.name",
            Self::ModelThinkingLevel => "model.thinkingLevel",
            Self::Tools => "tools",
            Self::Skills => "skills",
            Self::Subagents => "subagents",
            Self::SystemInstructions => "systemInstructions",
        }
    }

    const fn help(self) -> Option<&'static str> {
        match self {
            Self::ModelName => Some("set a model or inherit one from a base agent"),
            Self::ModelThinkingLevel => {
                Some("omit this field to preserve the provider or session default")
            }
            Self::Tools => Some("omit this field for no tools, or declare the intended tools"),
            Self::Skills | Self::Subagents | Self::SystemInstructions => None,
        }
    }
}

struct CheckContext {
    profile: CheckProfile,
    files: BTreeMap<String, Option<String>>,
    directories: BTreeSet<String>,
    package_name: Option<String>,
    diagnostics: Vec<Diagnostic>,
    resources: BTreeMap<String, usize>,
}

impl CheckContext {
    fn new(input: &RecipeFiles, profile: CheckProfile) -> Self {
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        for file in &input.files {
            let path = normalize_relative(&file.path);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            files.insert(path, file.content.clone());
        }
        for directory in &input.directories {
            let path = normalize_relative(directory);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            directories.insert(path);
        }
        Self {
            profile,
            files,
            directories,
            package_name: None,
            diagnostics: Vec::new(),
            resources: BTreeMap::new(),
        }
    }

    fn has_file(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn has_dir(&self, path: &str) -> bool {
        self.directories.contains(path)
    }

    fn path_exists(&self, path: &str) -> bool {
        self.has_file(path) || self.has_dir(path)
    }

    fn content(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(Option::as_deref)
    }

    /// Files that are direct children of `dir`.
    fn child_files(&self, dir: &str) -> Vec<&str> {
        let prefix = format!("{dir}/");
        self.files
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
            .filter(|(path, _)| !path[prefix.len()..].contains('/'))
            .map(|(path, _)| path.as_str())
            .collect()
    }

    fn push(
        &mut self,
        severity: Severity,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.diagnostics.push(Diagnostic {
            severity,
            code: code.into(),
            path: path.into(),
            span,
            message: message.into(),
            help: help.map(Into::into),
        });
    }

    fn error(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Error, code, path, None, message, help);
    }

    fn error_at(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Error, code, path, span, message, help);
    }

    fn warning(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Warning, code, path, None, message, help);
    }

    fn warning_at(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Warning, code, path, span, message, help);
    }
}

/// Validate an in-memory recipe snapshot. Pure: no filesystem access.
pub fn check_recipe_files(input: &RecipeFiles, profile: CheckProfile) -> Report {
    let mut ctx = CheckContext::new(input, profile);

    let package = read_package(&mut ctx);
    if let Some(package) = package {
        ctx.package_name = package.name.clone();
        validate_package_identity(&package, &mut ctx);
        validate_runtime_dependencies(&package, &mut ctx);
        validate_publish_metadata(&package, &mut ctx);
        let resources = validate_pi_config(&package, &mut ctx);
        validate_mcp_local_example(&mut ctx);

        let mcp_tool_policy = package
            .pi
            .as_ref()
            .and_then(JsonValue::as_object)
            .and_then(|pi| mcp_tool_policy(pi.get("mcp")));
        let agent_paths = resolve_agents(&resources, &ctx);
        ctx.resources.insert("agents".to_owned(), agent_paths.len());
        validate_agents(&agent_paths, mcp_tool_policy.as_ref(), &mut ctx);
        for key in ["extensions", "skills", "prompts"] {
            if let Some(paths) = resources.get(key) {
                ctx.resources.insert(key.to_owned(), paths.len());
            }
        }
    }

    let judge_count = judges::validate_judges(&mut ctx);
    if judge_count > 0 {
        ctx.resources.insert("judges".to_owned(), judge_count);
    }

    let valid = !ctx
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_error());
    Report {
        valid,
        profile,
        recipe_dir: ".".to_owned(),
        package_name: ctx.package_name,
        diagnostics: ctx.diagnostics,
        resources: ctx.resources,
    }
}

pub fn render_human(report: &Report) -> String {
    let name = report.package_name.as_deref().unwrap_or("<unknown>");
    let mut out = String::new();
    out.push_str(name);
    out.push('\n');
    for diagnostic in &report.diagnostics {
        out.push_str(&format!(
            "{}: {}: {}",
            match diagnostic.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            },
            diagnostic.code,
            diagnostic.message
        ));
        if !diagnostic.path.is_empty() {
            match diagnostic.span {
                Some(span) => out.push_str(&format!(
                    " ({}:{}:{})",
                    diagnostic.path, span.line, span.column
                )),
                None => out.push_str(&format!(" ({})", diagnostic.path)),
            }
        }
        out.push('\n');
        if let Some(help) = &diagnostic.help {
            out.push_str(&format!("  help: {help}\n"));
        }
    }
    if report.diagnostics.is_empty() {
        out.push_str("ok\n");
    }
    if !report.resources.is_empty() {
        out.push_str("\nResources:\n");
        for (key, count) in &report.resources {
            out.push_str(&format!("  {key}: {count}\n"));
        }
    }
    out
}

const PACKAGE_JSON: &str = "package.json";

fn read_package(ctx: &mut CheckContext) -> Option<Package> {
    if !ctx.has_file(PACKAGE_JSON) {
        ctx.error(
            "package.manifest_missing",
            PACKAGE_JSON,
            "Recipe is missing package.json",
            Some("add package.json with a non-empty pi object"),
        );
        return None;
    }
    let Some(content) = ctx.content(PACKAGE_JSON).map(str::to_owned) else {
        ctx.error(
            "package.manifest_unreadable",
            PACKAGE_JSON,
            "package.json content was not provided",
            Some("supply package.json content to the validator"),
        );
        return None;
    };

    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let span = Some(Span {
                line: err.line(),
                column: err.column(),
            });
            ctx.error_at(
                "package.manifest_malformed",
                PACKAGE_JSON,
                span,
                format!("package.json is not valid JSON: {err}"),
                Some("fix package.json syntax"),
            );
            return None;
        }
    };

    let Some(object) = parsed.as_object() else {
        ctx.error(
            "package.manifest_invalid",
            PACKAGE_JSON,
            "package.json must be an object",
            Some("make the top-level JSON value an object"),
        );
        return None;
    };

    let pi = object.get("pi").cloned();
    if !matches!(pi.as_ref(), Some(JsonValue::Object(map)) if !map.is_empty()) {
        ctx.error(
            "package.pi_missing",
            PACKAGE_JSON,
            "package.json is missing a non-empty pi object",
            Some("add package.json#pi with recipe resources"),
        );
    }

    Some(Package {
        name: string_value(object.get("name")),
        version: string_value(object.get("version")),
        description: string_value(object.get("description")),
        license: string_value(object.get("license")),
        pi,
        runtime_dependencies: has_non_empty_object(object.get("dependencies"))
            || has_non_empty_object(object.get("optionalDependencies")),
    })
}

fn validate_package_identity(package: &Package, ctx: &mut CheckContext) {
    if package.name.is_none() {
        ctx.error(
            "package.name_missing",
            PACKAGE_JSON,
            "Package is missing name",
            Some("set package.json#name to the recipe identifier"),
        );
    }
    if package.description.is_none() {
        ctx.warning(
            "package.description_missing",
            PACKAGE_JSON,
            "Package is missing description",
            Some("add a short package.json#description for humans browsing recipes"),
        );
    }
}

fn validate_runtime_dependencies(package: &Package, ctx: &mut CheckContext) {
    if !package.runtime_dependencies || has_dependency_lockfile(ctx) {
        return;
    }
    let severity = match ctx.profile {
        CheckProfile::Local => Severity::Warning,
        CheckProfile::Ci | CheckProfile::Publish => Severity::Error,
    };
    ctx.push(
        severity,
        "package.lockfile_missing",
        PACKAGE_JSON,
        None,
        "Recipe declares runtime dependencies but has no lockfile",
        Some("commit package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, or yarn.lock"),
    );
}

fn validate_publish_metadata(package: &Package, ctx: &mut CheckContext) {
    if ctx.profile != CheckProfile::Publish {
        return;
    }

    if let Some(license) = package.license.as_deref() {
        let normalized = license.trim().to_ascii_uppercase();
        let has_license_text = if normalized.starts_with("SEE LICENSE IN ") {
            let path = license["SEE LICENSE IN ".len()..].trim();
            validate_relative_pattern(path).is_ok() && ctx.has_file(path)
        } else {
            ctx.files.keys().any(|path| {
                if path.contains('/') {
                    return false;
                }
                let upper = path.to_ascii_uppercase();
                ["LICENSE", "LICENCE", "COPYING"]
                    .iter()
                    .any(|base| upper == *base || upper.starts_with(&format!("{base}.")))
            })
        };
        if normalized != "UNLICENSED" && !has_license_text {
            ctx.error(
                "package.license_file_missing",
                PACKAGE_JSON,
                format!("Package declares license '{license}' but no root license file exists"),
                Some("add the matching license text at the recipe root before distribution"),
            );
        }
    }

    if ctx.has_file(".pi/mcp.local.json") {
        ctx.error(
            "package.local_config_present",
            ".pi/mcp.local.json",
            "Local capability configuration must not be distributed with a recipe",
            Some("remove .pi/mcp.local.json and keep only a redacted example when needed"),
        );
    }

    for lockfile in ["package-lock.json", "npm-shrinkwrap.json"] {
        let Some(content) = ctx.content(lockfile).map(str::to_owned) else {
            continue;
        };
        let parsed: JsonValue = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(err) => {
                ctx.error(
                    "package.lockfile_malformed",
                    lockfile,
                    format!("{lockfile} is not valid JSON: {err}"),
                    Some("regenerate the lockfile from the current package.json"),
                );
                continue;
            }
        };
        let Some(root) = parsed.as_object() else {
            continue;
        };
        let package_root = root
            .get("packages")
            .and_then(JsonValue::as_object)
            .and_then(|packages| packages.get(""))
            .and_then(JsonValue::as_object);
        for (location, entry) in [("top-level", Some(root)), ("packages[\"\"]", package_root)] {
            let Some(entry) = entry else {
                continue;
            };
            for (field, package_value) in [
                ("name", package.name.as_deref()),
                ("version", package.version.as_deref()),
            ] {
                if let (Some(expected), Some(actual)) =
                    (package_value, string_value(entry.get(field)))
                {
                    if expected != actual {
                        ctx.error(
                            format!("package.lockfile_{field}_mismatch"),
                            lockfile,
                            format!(
                                "{lockfile} {location} {field} '{actual}' does not match package.json '{expected}'"
                            ),
                            Some("regenerate the lockfile after changing recipe identity"),
                        );
                    }
                }
            }
        }
    }
}

fn validate_pi_config(
    package: &Package,
    ctx: &mut CheckContext,
) -> HashMap<&'static str, Vec<String>> {
    let mut resolved = HashMap::new();
    let Some(JsonValue::Object(pi)) = package.pi.as_ref() else {
        return resolved;
    };
    let known: HashSet<&str> = ["agents", "extensions", "skills", "prompts", "mcp"]
        .into_iter()
        .collect();
    for key in pi.keys() {
        if key == "evals" {
            ctx.error(
                "pi.evals_unsupported",
                PACKAGE_JSON,
                "package.json#pi.evals is not supported",
                Some("keep evaluation configuration outside the Recipe"),
            );
            continue;
        }
        if !known.contains(key.as_str()) {
            ctx.warning(
                "pi.unknown_key",
                PACKAGE_JSON,
                format!("package.json#pi contains unknown key '{key}'"),
                Some("remove unknown pi keys or update recipe-check if this is a new recipe field"),
            );
        }
    }

    let agents = resource_patterns("agents", pi.get("agents"), true, ctx);
    let extensions = resource_patterns("extensions", pi.get("extensions"), false, ctx);
    let skills = resource_patterns("skills", pi.get("skills"), false, ctx);
    let prompts = resource_patterns("prompts", pi.get("prompts"), false, ctx);

    for (key, patterns, required) in [
        ("agents", agents, true),
        ("extensions", extensions, false),
        ("skills", skills, false),
        ("prompts", prompts, false),
    ] {
        let paths = resolve_resource_patterns(key, &patterns, required, ctx);
        if required && paths.is_empty() {
            ctx.error(
                "package.agents_missing",
                PACKAGE_JSON,
                "Recipe declares no loadable agents",
                Some("add agents/*.yaml or configure package.json#pi.agents"),
            );
        }
        resolved.insert(key, paths);
    }

    validate_mcp_config(pi.get("mcp"), ctx);

    resolved
}

fn resource_patterns(
    key: &'static str,
    value: Option<&JsonValue>,
    required: bool,
    ctx: &mut CheckContext,
) -> ResourcePatterns {
    match value {
        Some(JsonValue::Array(items)) => {
            let mut patterns = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                match string_value(Some(item)) {
                    Some(pattern) => patterns.push(pattern),
                    None => ctx.error(
                        format!("pi.{key}_invalid"),
                        PACKAGE_JSON,
                        format!("package.json#pi.{key}[{index}] must be a non-empty string"),
                        Some("remove the entry or replace it with a relative resource path"),
                    ),
                }
            }
            ResourcePatterns {
                explicit: true,
                patterns,
            }
        }
        Some(_) => {
            ctx.error(
                format!("pi.{key}_invalid"),
                PACKAGE_JSON,
                format!("package.json#pi.{key} must be an array of strings"),
                Some("use a list of relative resource paths"),
            );
            ResourcePatterns {
                explicit: true,
                patterns: Vec::new(),
            }
        }
        None => {
            let patterns = if required || key != "extensions" {
                if ctx.path_exists(key) {
                    vec![key.to_owned()]
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            ResourcePatterns {
                explicit: false,
                patterns,
            }
        }
    }
}

fn resolve_resource_patterns(
    key: &'static str,
    patterns: &ResourcePatterns,
    required: bool,
    ctx: &mut CheckContext,
) -> Vec<String> {
    let mut resolved = BTreeSet::new();
    for pattern in &patterns.patterns {
        if let Err(message) = validate_relative_pattern(pattern) {
            ctx.error(
                format!("package.{key}_invalid"),
                PACKAGE_JSON,
                message,
                Some("use paths relative to the recipe directory"),
            );
            continue;
        }

        let matches = match_paths(ctx, pattern);
        if matches.is_empty() {
            let severity = if required {
                Severity::Error
            } else {
                Severity::Warning
            };
            ctx.push(
                severity,
                format!("package.{key}_unmatched"),
                PACKAGE_JSON,
                None,
                format!("package.json#pi.{key} pattern '{pattern}' matched no files"),
                Some("update or remove the unmatched resource pattern"),
            );
        }
        for path in matches {
            if key == "extensions" && !is_loadable_extension_file(ctx, &path) {
                ctx.warning(
                    "package.extensions_non_loadable",
                    path.clone(),
                    format!(
                        "package.json#pi.extensions pattern '{pattern}' matched a file that is not a loadable extension module"
                    ),
                    Some("point extension patterns at .ts, .tsx, .js, .jsx, .mjs, or .cjs files"),
                );
            }
            resolved.insert(path);
        }
    }

    if required && !patterns.explicit && patterns.patterns.is_empty() {
        ctx.error(
            "package.agents_missing",
            PACKAGE_JSON,
            "Recipe has no package.json#pi.agents and no conventional agents directory",
            Some("add agents/*.yaml or configure package.json#pi.agents"),
        );
    }

    resolved.into_iter().collect()
}

fn resolve_agents(
    resources: &HashMap<&'static str, Vec<String>>,
    ctx: &CheckContext,
) -> Vec<String> {
    let mut agents = BTreeSet::new();
    for path in resources.get("agents").into_iter().flatten() {
        if ctx.has_file(path) {
            if is_yaml_path(path) {
                agents.insert(path.clone());
            }
        } else if ctx.has_dir(path) {
            for child in ctx.child_files(path) {
                if is_yaml_path(child) {
                    agents.insert(child.to_owned());
                }
            }
        }
    }
    agents.into_iter().collect()
}

fn validate_agents(
    agent_paths: &[String],
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let mut sources = Vec::new();
    for path in agent_paths {
        if let Some(agent) = read_agent(path, ctx) {
            sources.push(agent);
        }
    }
    if sources.is_empty() {
        return;
    }

    validate_agent_names(&sources, ctx);

    let mut raw_by_name = HashMap::new();
    let mut aliases = HashMap::new();
    for source in &sources {
        raw_by_name.insert(source.name.clone(), source);
        aliases.insert(source.fallback_name.clone(), source.name.clone());
    }

    let mut unique_names: Vec<String> = raw_by_name.keys().cloned().collect();
    unique_names.sort();
    for name in unique_names {
        validate_agent_inheritance(&name, &raw_by_name, &aliases, ctx);
        for field in AgentField::REQUIRED {
            if !resolved_field_provided(&name, field, &raw_by_name, &aliases, &mut Vec::new()) {
                let path = raw_by_name
                    .get(&name)
                    .map(|agent| agent.path.clone())
                    .unwrap_or_default();
                let severity = match field {
                    AgentField::ModelName => Severity::Error,
                    AgentField::ModelThinkingLevel
                    | AgentField::Tools
                    | AgentField::SystemInstructions => Severity::Warning,
                    AgentField::Skills | AgentField::Subagents => continue,
                };
                ctx.push(
                    severity,
                    format!("agent.{}_missing", field.label()),
                    path,
                    None,
                    format!(
                        "Recipe agent '{name}' must declare {} directly or inherit it with from",
                        field.label()
                    ),
                    field.help(),
                );
            }
        }
        validate_resolved_agent_mcp(&name, &raw_by_name, &aliases, mcp_tool_policy, ctx);
    }
}

fn read_agent(path: &str, ctx: &mut CheckContext) -> Option<RawAgent> {
    let Some(content) = ctx.content(path).map(str::to_owned) else {
        ctx.error(
            "agent.unreadable",
            path,
            "Agent YAML content was not provided",
            Some("supply agent YAML content to the validator"),
        );
        return None;
    };
    let parsed: JsonValue = match serde_saphyr::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            let span = span_from_message(&message);
            ctx.error_at(
                "agent.yaml_malformed",
                path,
                span,
                format!("Agent file is not valid YAML: {message}"),
                Some("fix the YAML syntax"),
            );
            return None;
        }
    };
    let Some(map) = parsed.as_object() else {
        ctx.error(
            "agent.invalid",
            path,
            "Agent file must contain a YAML object",
            Some("make the top-level YAML value a mapping"),
        );
        return None;
    };

    let fallback_name = file_stem(path).unwrap_or("agent").to_owned();
    let explicit_name = obj_string(map, "name").filter(|value| !value.trim().is_empty());
    let name = explicit_name
        .clone()
        .unwrap_or_else(|| fallback_name.clone());
    if !map.contains_key("name") {
        ctx.warning(
            "agent.name_missing",
            path,
            format!("Recipe agent '{name}' must declare name"),
            Some("add a non-empty name field to the agent YAML"),
        );
    }
    if map.contains_key("name") && explicit_name.is_none() {
        ctx.error(
            "agent.name_invalid",
            path,
            "Agent name must be a non-empty string",
            Some("remove the field to use the filename, or set a non-empty name"),
        );
    }

    if obj_string(map, "description").is_none() {
        ctx.warning(
            "agent.description_missing",
            path,
            format!("Recipe agent '{name}' is missing description"),
            Some("add a short description to explain when this agent should be used"),
        );
    }

    let from = match map.get("from") {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Some(_) => {
            ctx.error(
                "agent.from_invalid",
                path,
                "Agent from must be a non-empty string",
                Some("remove the field or reference an existing agent"),
            );
            None
        }
        None => None,
    };

    let mut fields = HashSet::new();
    validate_agent_model(map, path, &name, &mut fields, ctx);
    validate_agent_string_array(map, "tools", AgentField::Tools, path, &mut fields, ctx);
    let mcp = validate_agent_mcp(map, path, ctx);
    validate_agent_string_array(map, "skills", AgentField::Skills, path, &mut fields, ctx);
    validate_agent_string_array(
        map,
        "subagents",
        AgentField::Subagents,
        path,
        &mut fields,
        ctx,
    );
    validate_agent_system_instructions(map, path, &mut fields, ctx);
    validate_agent_extensions(map, path, ctx);

    Some(RawAgent {
        name,
        fallback_name,
        explicit_name: explicit_name.is_some(),
        path: path.to_owned(),
        from,
        fields,
        mcp,
    })
}

fn validate_agent_model(
    map: &JsonMap,
    path: &str,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get("model") else {
        return;
    };
    let Some(model) = value.as_object() else {
        ctx.error(
            "agent.model_invalid",
            path,
            "Agent model must be an object",
            Some("make model a mapping of supported model settings"),
        );
        return;
    };

    if let Some(model_name) = obj_string(model, "name") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.model.name_invalid",
                path,
                format!(
                    "Recipe agent '{name}' has invalid model.name '{model_name}' - expected '<provider>/<model_id>'"
                ),
                Some("use an available provider and model identifier"),
            );
        }
    } else if model.contains_key("name") {
        ctx.error(
            "agent.model.name_invalid",
            path,
            "Agent model.name must be a non-empty string",
            Some("set an available provider and model identifier"),
        );
    }

    if obj_string(model, "thinking_level").is_some() || obj_string(model, "thinkingLevel").is_some()
    {
        fields.insert(AgentField::ModelThinkingLevel);
    } else if model.contains_key("thinking_level") || model.contains_key("thinkingLevel") {
        ctx.error(
            "agent.model.thinkingLevel_invalid",
            path,
            "Agent model thinking level must be a string",
            Some("remove the field to preserve the default, or set a supported level"),
        );
    }
}

fn validate_agent_string_array(
    map: &JsonMap,
    key: &'static str,
    field: AgentField,
    path: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get(key) else {
        return;
    };
    match string_array(value) {
        Ok(()) => {
            fields.insert(field);
        }
        Err(message) => ctx.error(
            format!("agent.{key}_invalid"),
            path,
            message,
            Some("use a list containing only non-empty strings"),
        ),
    }
}

fn validate_agent_mcp(map: &JsonMap, path: &str, ctx: &mut CheckContext) -> Option<AgentMcpConfig> {
    let value = map.get("mcp")?;
    let Some(mcp) = value.as_object() else {
        ctx.error(
            "agent.mcp_invalid",
            path,
            "Agent mcp must be an object",
            Some("remove mcp for no access, or declare server policies"),
        );
        return Some(AgentMcpConfig::default());
    };
    let structured = mcp.get("mode").is_some_and(|value| !value.is_object());
    let mode = if structured {
        match mcp.get("mode") {
            Some(JsonValue::String(value)) if value == "cli" => Some(AgentMcpMode::Cli),
            Some(JsonValue::String(value)) if value == "tools" => Some(AgentMcpMode::Tools),
            Some(_) => {
                ctx.error(
                    "agent.mcp_mode_invalid",
                    path,
                    "Agent mcp.mode must be 'cli' or 'tools'",
                    Some("set mcp.mode to cli or tools"),
                );
                None
            }
            None => None,
        }
    } else {
        None
    };
    let empty_servers = JsonMap::new();
    let servers = if structured {
        match mcp.get("servers") {
            Some(JsonValue::Object(servers)) => servers,
            Some(_) => {
                ctx.error(
                    "agent.mcp_servers_invalid",
                    path,
                    "Agent mcp.servers must be an object",
                    Some("move server selections under mcp.servers"),
                );
                return Some(AgentMcpConfig {
                    mode,
                    ..AgentMcpConfig::default()
                });
            }
            None => &empty_servers,
        }
    } else {
        mcp
    };
    let mut parsed = BTreeMap::new();
    for (server_key, value) in servers {
        if server_key.trim().is_empty() {
            ctx.error(
                "agent.mcp_server_invalid",
                path,
                "Agent mcp server ids must be non-empty strings",
                Some("remove the entry or give the server a non-empty identifier"),
            );
            continue;
        }
        let server_id = server_key.as_str();
        let Some(server) = value.as_object() else {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("Agent mcp server '{server_id}' must be an object"),
                Some("remove the server for no access, or declare its tool policy"),
            );
            continue;
        };
        let mut selectors = McpToolSelectors::default();
        for key in ["include", "exclude"] {
            let Some(value) = server.get(key) else {
                continue;
            };
            if let Err(message) = string_array(value) {
                ctx.error(
                    "agent.mcp_invalid",
                    path,
                    format!("mcp.{server_id}.{key}: {message}"),
                    Some("use a list containing only non-empty tool names"),
                );
                continue;
            }
            let Some(items) = value.as_array() else {
                continue;
            };
            let values = items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            for selector in &values {
                let valid = if key == "include" {
                    !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                } else {
                    !selector.is_empty() && !selector.contains('*')
                };
                if !valid {
                    ctx.error(
                        "agent.mcp_selector_invalid",
                        path,
                        format!(
                            "Agent mcp server '{server_id}' {key} entry '{selector}' must be {}",
                            if key == "include" {
                                "an exact tool name or '*'"
                            } else {
                                "an exact tool name"
                            }
                        ),
                        None::<String>,
                    );
                }
            }
            if key == "include" {
                selectors.include = Some(values);
            } else {
                selectors.exclude = Some(values);
            }
        }
        let normalized_server_id = safe_mcp_server_id(server_id);
        if parsed.contains_key(&normalized_server_id) {
            ctx.error(
                "agent.mcp_server_collision",
                path,
                format!(
                    "Agent mcp server '{server_id}' collides with another server after id normalization"
                ),
                Some("use server ids that remain unique after normalization"),
            );
            continue;
        }
        parsed.insert(normalized_server_id, selectors);
    }
    let initial_tools = if structured && mcp.contains_key("initial_tools") {
        let Some(initial_tools) = mcp.get("initial_tools").and_then(JsonValue::as_object) else {
            ctx.error(
                "agent.mcp_initial_tools_invalid",
                path,
                "Agent mcp.initial_tools must be an object of server ids to exact tool-name lists",
                Some("use initial_tools: {} or initial_tools: { server: [tool] }"),
            );
            return Some(AgentMcpConfig {
                mode,
                servers: parsed,
                initial_tools: Some(BTreeMap::new()),
            });
        };
        if mode == Some(AgentMcpMode::Cli) {
            ctx.error(
                "agent.mcp_initial_tools_invalid",
                path,
                "Agent mcp.initial_tools is only valid when mcp.mode is tools",
                Some("remove initial_tools or set mcp.mode to tools"),
            );
        }
        let mut parsed_initial_tools = BTreeMap::new();
        for (server_id, value) in initial_tools {
            if let Err(message) = string_array(value) {
                ctx.error(
                    "agent.mcp_initial_tools_invalid",
                    path,
                    format!("mcp.initial_tools.{server_id}: {message}"),
                    Some("use exact tool names, or a sole '*' selector"),
                );
                continue;
            }
            let values = value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            if values
                .iter()
                .any(|selector| selector.is_empty() || (selector.contains('*') && selector != "*"))
                || (values.contains("*") && values.len() != 1)
            {
                ctx.error(
                    "agent.mcp_initial_tools_selector_invalid",
                    path,
                    format!(
                        "Agent mcp.initial_tools server '{server_id}' must contain exact tool names or '*' by itself"
                    ),
                    None::<String>,
                );
            }
            let normalized_server_id = safe_mcp_server_id(server_id);
            if parsed_initial_tools.contains_key(&normalized_server_id) {
                ctx.error(
                    "agent.mcp_initial_tools_collision",
                    path,
                    format!(
                        "Agent mcp.initial_tools server '{server_id}' collides with another server after id normalization"
                    ),
                    Some("use server ids that remain unique after normalization"),
                );
                continue;
            }
            parsed_initial_tools.insert(normalized_server_id, values);
        }
        Some(parsed_initial_tools)
    } else {
        None
    };
    Some(AgentMcpConfig {
        mode,
        servers: parsed,
        initial_tools,
    })
}

fn validate_agent_system_instructions(
    map: &JsonMap,
    path: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    if let Some(prompt) = map.get("prompt") {
        if matches!(prompt, JsonValue::String(value) if !value.trim().is_empty()) {
            fields.insert(AgentField::SystemInstructions);
        } else {
            ctx.error(
                "agent.prompt_invalid",
                path,
                "Agent prompt must be a non-empty string",
                None::<String>,
            );
        }
    }

    let Some(value) = map
        .get("system_instructions")
        .or_else(|| map.get("systemInstructions"))
    else {
        return;
    };
    let Some(system) = value.as_object() else {
        ctx.error(
            "agent.systemInstructions_invalid",
            path,
            "Agent system_instructions must be an object",
            None::<String>,
        );
        return;
    };
    match system.get("content") {
        Some(JsonValue::String(_)) => {
            fields.insert(AgentField::SystemInstructions);
        }
        Some(_) => ctx.error(
            "agent.systemInstructions_invalid",
            path,
            "Agent system_instructions.content must be a string",
            None::<String>,
        ),
        None => ctx.error(
            "agent.systemInstructions_invalid",
            path,
            "Agent system_instructions must declare content",
            None::<String>,
        ),
    }
    if let Some(mode) = system.get("mode") {
        match mode {
            JsonValue::String(value) if value == "append" || value == "replace" => {}
            JsonValue::String(_) => ctx.error(
                "agent.systemInstructions_invalid",
                path,
                "Agent system_instructions.mode must be append or replace",
                None::<String>,
            ),
            _ => ctx.error(
                "agent.systemInstructions_invalid",
                path,
                "Agent system_instructions.mode must be a string",
                None::<String>,
            ),
        }
    }
}

fn validate_agent_extensions(map: &JsonMap, path: &str, ctx: &mut CheckContext) {
    let Some(value) = map.get("extensions") else {
        return;
    };
    let Some(extensions) = value.as_object() else {
        ctx.error(
            "agent.extensions_invalid",
            path,
            "Agent extensions must be an object",
            None::<String>,
        );
        return;
    };
    for key in ["include", "exclude"] {
        if let Some(value) = extensions.get(key) {
            if let Err(message) = string_array(value) {
                ctx.error(
                    "agent.extensions_invalid",
                    path,
                    format!("extensions.{key}: {message}"),
                    None::<String>,
                );
            }
        }
    }
}

fn validate_agent_names(sources: &[RawAgent], ctx: &mut CheckContext) {
    let mut explicit_counts: HashMap<&str, usize> = HashMap::new();
    let mut explicit_names = HashSet::new();
    for source in sources {
        if source.explicit_name {
            explicit_names.insert(source.name.as_str());
            *explicit_counts.entry(source.name.as_str()).or_default() += 1;
        }
    }
    for (name, count) in explicit_counts {
        if count > 1 {
            ctx.error(
                "agent.name_duplicate",
                "agents",
                format!("Recipe agent name '{name}' is declared by multiple files"),
                Some("choose unique agent names"),
            );
        }
    }
    for source in sources {
        if source.fallback_name != source.name
            && explicit_names.contains(source.fallback_name.as_str())
        {
            ctx.error(
                "agent.name_alias_conflict",
                source.path.clone(),
                format!(
                    "Recipe agent file alias '{}' conflicts with an explicit agent name",
                    source.fallback_name
                ),
                Some("rename the file or choose a non-conflicting agent name"),
            );
        }
    }
}

fn validate_agent_inheritance(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    aliases: &HashMap<String, String>,
    ctx: &mut CheckContext,
) {
    let mut stack = Vec::new();
    let mut current = resolve_agent_name(name, raw_by_name, aliases);
    loop {
        let Some(agent) = raw_by_name.get(&current) else {
            return;
        };
        let Some(from) = &agent.from else {
            return;
        };
        let parent = resolve_agent_name(from, raw_by_name, aliases);
        if stack.contains(&parent) || parent == current {
            ctx.error(
                "agent.from_cycle",
                agent.path.clone(),
                format!("Recipe agent '{}' has cyclic from chain", agent.name),
                Some("remove the inheritance cycle"),
            );
            return;
        }
        if !raw_by_name.contains_key(&parent) {
            ctx.error(
                "agent.from_missing",
                agent.path.clone(),
                format!(
                    "Recipe agent '{}' inherits from missing agent '{}'",
                    agent.name, from
                ),
                Some("update from to reference an existing agent"),
            );
            return;
        }
        stack.push(current);
        current = parent;
    }
}

fn resolved_field_provided(
    name: &str,
    field: AgentField,
    raw_by_name: &HashMap<String, &RawAgent>,
    aliases: &HashMap<String, String>,
    stack: &mut Vec<String>,
) -> bool {
    let resolved = resolve_agent_name(name, raw_by_name, aliases);
    if stack.contains(&resolved) {
        return false;
    }
    let Some(agent) = raw_by_name.get(&resolved) else {
        return false;
    };
    if agent.fields.contains(&field) {
        return true;
    }
    if let Some(parent) = &agent.from {
        stack.push(resolved);
        return resolved_field_provided(parent, field, raw_by_name, aliases, stack);
    }
    false
}

fn resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    aliases: &HashMap<String, String>,
    stack: &mut Vec<String>,
) -> Option<AgentMcpConfig> {
    let resolved = resolve_agent_name(name, raw_by_name, aliases);
    if stack.contains(&resolved) {
        return None;
    }
    let agent = raw_by_name.get(&resolved)?;
    stack.push(resolved);
    let mut merged = agent
        .from
        .as_deref()
        .and_then(|parent| resolved_agent_mcp(parent, raw_by_name, aliases, stack))
        .unwrap_or_default();
    stack.pop();

    let Some(child) = &agent.mcp else {
        return (!merged.servers.is_empty()
            || merged.mode.is_some()
            || merged.initial_tools.is_some())
        .then_some(merged);
    };
    for (server_id, child_tools) in &child.servers {
        let base_tools = merged.servers.get(server_id);
        merged.servers.insert(
            server_id.clone(),
            McpToolSelectors {
                include: child_tools
                    .include
                    .clone()
                    .or_else(|| base_tools.and_then(|tools| tools.include.clone())),
                exclude: child_tools
                    .exclude
                    .clone()
                    .or_else(|| base_tools.and_then(|tools| tools.exclude.clone())),
            },
        );
    }
    if child.mode.is_some() {
        merged.mode = child.mode;
    }
    if child.initial_tools.is_some() {
        merged.initial_tools = child.initial_tools.clone();
    }
    if merged.mode == Some(AgentMcpMode::Cli) {
        merged.initial_tools = None;
    }
    Some(merged)
}

fn validate_resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    aliases: &HashMap<String, String>,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let Some(mcp) = resolved_agent_mcp(name, raw_by_name, aliases, &mut Vec::new()) else {
        return;
    };
    let path = raw_by_name
        .get(&resolve_agent_name(name, raw_by_name, aliases))
        .map(|agent| agent.path.clone())
        .unwrap_or_default();

    for (server_id, selection) in &mcp.servers {
        let Some(include) = &selection.include else {
            continue;
        };
        let Some(server_policy) = mcp_tool_policy.and_then(|policy| policy.get(server_id)) else {
            ctx.error(
                "agent.mcp_server_undeclared",
                path.clone(),
                format!("Recipe agent '{name}' references undeclared MCP server '{server_id}'"),
                Some("add the server to package.json#pi.mcp.servers or remove it from the agent"),
            );
            continue;
        };
        for tool in include.iter().filter(|tool| tool.as_str() != "*") {
            if mcp_package_policy_allows(server_policy, tool) {
                continue;
            }
            ctx.error(
                "agent.mcp_tool_undeclared",
                path.clone(),
                format!(
                    "Recipe agent '{name}' MCP tool '{server_id}/{tool}' is not included by the package policy"
                ),
                Some("include the tool in the package MCP policy or update the agent"),
            );
        }
    }
    if let Some(initial_tools) = &mcp.initial_tools {
        for (server_id, selectors) in initial_tools {
            let Some(selection) = mcp.servers.get(server_id) else {
                ctx.error(
                    "agent.mcp_initial_tools_server_unauthorized",
                    path.clone(),
                    format!(
                        "Recipe agent '{name}' activates MCP server '{server_id}' without authorizing it in mcp.servers"
                    ),
                    Some("add the server selection under mcp.servers or remove it from initial_tools"),
                );
                continue;
            };
            for tool in selectors.iter().filter(|tool| tool.as_str() != "*") {
                if mcp_package_policy_allows(selection, tool) {
                    continue;
                }
                ctx.error(
                    "agent.mcp_initial_tools_tool_unauthorized",
                    path.clone(),
                    format!(
                        "Recipe agent '{name}' activates MCP tool '{server_id}/{tool}' outside its mcp.servers authorization"
                    ),
                    Some("authorize the tool under mcp.servers or remove it from initial_tools"),
                );
            }
        }
    }
}

fn resolve_agent_name(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    aliases: &HashMap<String, String>,
) -> String {
    if raw_by_name.contains_key(name) {
        name.to_owned()
    } else {
        aliases
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_owned())
    }
}

fn validate_mcp_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    match value {
        JsonValue::String(path) => validate_mcp_manifest_pattern(path, ctx),
        JsonValue::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(path) = string_value(Some(item)) {
                    validate_mcp_manifest_pattern(&path, ctx);
                } else {
                    ctx.error(
                        "pi.mcp_invalid",
                        PACKAGE_JSON,
                        format!("package.json#pi.mcp[{index}] must be a non-empty string"),
                        Some("remove the entry or provide a relative manifest path"),
                    );
                }
            }
        }
        JsonValue::Object(map) => {
            if let Some(manifest) = map.get("manifest") {
                if let Some(path) = string_value(Some(manifest)) {
                    validate_mcp_manifest_pattern(&path, ctx);
                } else {
                    ctx.error(
                        "pi.mcp_invalid",
                        PACKAGE_JSON,
                        "package.json#pi.mcp.manifest must be a non-empty string",
                        Some("remove manifest or provide a relative manifest path"),
                    );
                }
            }
            if let Some(manifests) = map.get("manifests") {
                match manifests {
                    JsonValue::Array(items) => {
                        for (index, item) in items.iter().enumerate() {
                            if let Some(path) = string_value(Some(item)) {
                                validate_mcp_manifest_pattern(&path, ctx);
                            } else {
                                ctx.error(
                                    "pi.mcp_invalid",
                                    PACKAGE_JSON,
                                    format!("package.json#pi.mcp.manifests[{index}] must be a non-empty string"),
                                    Some("remove the entry or provide a relative manifest path"),
                                );
                            }
                        }
                    }
                    _ => ctx.error(
                        "pi.mcp_invalid",
                        PACKAGE_JSON,
                        "package.json#pi.mcp.manifests must be an array of strings",
                        Some("use a list of relative manifest paths"),
                    ),
                }
            }
            validate_mcp_servers(map.get("servers"), ctx);
        }
        _ => ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp must be an object, string, or string array",
            Some("remove mcp for no access, or use a supported MCP declaration"),
        ),
    }
}

fn validate_mcp_servers(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let JsonValue::Array(servers) = value else {
        ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp.servers must be an array",
            Some("use a list of MCP server declarations"),
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}] must be an object"),
                Some("remove the entry or make it a server declaration"),
            );
            continue;
        };
        if string_value(server.get("id")).is_none() {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}].id must be a non-empty string"),
                Some("give the server a non-empty identifier"),
            );
        }
        if let Some(required) = server.get("required") {
            if !required.is_boolean() {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].required must be boolean"),
                    Some("remove required or set it to a boolean value"),
                );
            }
        }
        if let Some(tools) = server.get("tools") {
            let JsonValue::Object(tools) = tools else {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].tools must be an object"),
                    Some("remove tools for no access, or declare a tool policy"),
                );
                continue;
            };
            if !tools.contains_key("include") {
                ctx.warning(
                    "pi.mcp_include_missing",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp.servers[{index}].tools must declare include; use ['*'] for all tools or [] for none"
                    ),
                    Some("declare an explicit allowlist or omit the server"),
                );
            }
            for key in ["include", "exclude"] {
                let Some(selectors) = tools.get(key) else {
                    continue;
                };
                validate_json_string_array(
                    selectors,
                    &format!("package.json#pi.mcp.servers[{index}].tools.{key}"),
                    "pi.mcp_invalid",
                    ctx,
                );
                if let Some(selectors) = selectors.as_array() {
                    for selector in selectors
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::trim)
                    {
                        let valid = if key == "include" {
                            !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                        } else {
                            !selector.is_empty() && !selector.contains('*')
                        };
                        if !valid {
                            ctx.error(
                                "pi.mcp_selector_invalid",
                                PACKAGE_JSON,
                                format!(
                                    "package.json#pi.mcp.servers[{index}].tools.{key} entry '{selector}' must be {}",
                                    if key == "include" {
                                        "an exact tool name or '*'"
                                    } else {
                                        "an exact tool name"
                                    }
                                ),
                                None::<String>,
                            );
                        }
                    }
                }
            }
        } else {
            ctx.warning(
                "pi.mcp_include_missing",
                PACKAGE_JSON,
                format!(
                    "package.json#pi.mcp.servers[{index}] must declare tools.include; use ['*'] for all tools or [] for none"
                ),
                Some("declare an explicit allowlist or omit the server"),
            );
        }
    }
}

fn mcp_tool_policy(value: Option<&JsonValue>) -> Option<McpToolPolicy> {
    let JsonValue::Object(map) = value? else {
        return None;
    };
    let servers = map.get("servers")?;
    let JsonValue::Array(servers) = servers else {
        return None;
    };

    let mut policy: McpToolPolicy = BTreeMap::new();
    for server in servers {
        let JsonValue::Object(server) = server else {
            continue;
        };
        let Some(id) = string_value(server.get("id")) else {
            continue;
        };
        let tools = server.get("tools").and_then(JsonValue::as_object);
        let include = tools
            .and_then(|tools| tools.get("include"))
            .and_then(json_string_set);
        let exclude = tools.and_then(|tools| tools.get("exclude"));
        policy.insert(
            safe_mcp_server_id(&id),
            McpToolSelectors {
                include,
                exclude: exclude.and_then(json_string_set),
            },
        );
    }
    Some(policy)
}

fn validate_mcp_manifest_pattern(pattern: &str, ctx: &mut CheckContext) {
    if let Err(message) = validate_relative_pattern(pattern) {
        ctx.error(
            "pi.mcp_manifest_invalid",
            PACKAGE_JSON,
            message,
            Some("use manifest paths relative to the recipe directory"),
        );
        return;
    }
    let matches = match_paths(ctx, pattern);
    if matches.is_empty() {
        ctx.error(
            "pi.mcp_manifest_missing",
            PACKAGE_JSON,
            format!("MCP manifest pattern '{pattern}' matched no files"),
            Some("add the manifest file or update package.json#pi.mcp"),
        );
    }
}

const MCP_LOCAL_EXAMPLE: &str = ".pi/mcp.local.example.json";

fn validate_mcp_local_example(ctx: &mut CheckContext) {
    if !ctx.has_file(MCP_LOCAL_EXAMPLE) {
        return;
    }
    let Some(content) = ctx.content(MCP_LOCAL_EXAMPLE).map(str::to_owned) else {
        ctx.warning(
            "mcp.local_example_unreadable",
            MCP_LOCAL_EXAMPLE,
            "MCP local example content was not provided",
            Some("supply .pi/mcp.local.example.json content to the validator"),
        );
        return;
    };
    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let span = Some(Span {
                line: err.line(),
                column: err.column(),
            });
            ctx.warning_at(
                "mcp.local_example_malformed",
                MCP_LOCAL_EXAMPLE,
                span,
                format!(".pi/mcp.local.example.json is not valid JSON: {err}"),
                Some("fix the local MCP config template JSON"),
            );
            return;
        }
    };
    let JsonValue::Object(map) = parsed else {
        ctx.warning(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json must be an object",
            Some("fix the file structure or remove the optional example"),
        );
        return;
    };
    let Some(servers) = map.get("servers") else {
        return;
    };
    let JsonValue::Array(servers) = servers else {
        ctx.warning(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json servers must be an array",
            Some("fix the server list or remove the optional example"),
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.warning(
                "mcp.local_example_invalid",
                MCP_LOCAL_EXAMPLE,
                format!("servers[{index}] must be an object"),
                Some("fix the server entry or remove it"),
            );
            continue;
        };
        for key in ["id", "name", "transport", "url"] {
            if let Some(value) = server.get(key) {
                if string_value(Some(value)).is_none() {
                    ctx.warning(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].{key} must be a non-empty string"),
                        Some("remove the field or provide a non-empty value"),
                    );
                }
            }
        }
        if let Some(headers) = server.get("headers") {
            let JsonValue::Object(headers) = headers else {
                ctx.warning(
                    "mcp.local_example_invalid",
                    MCP_LOCAL_EXAMPLE,
                    format!("servers[{index}].headers must be an object"),
                    Some("remove headers or make it a string-valued mapping"),
                );
                continue;
            };
            for (key, value) in headers {
                if !matches!(value, JsonValue::String(_)) {
                    ctx.warning(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].headers.{key} must be a string"),
                        Some("remove the header or provide a string value"),
                    );
                }
            }
        }
    }
}

fn validate_json_string_array(value: &JsonValue, label: &str, code: &str, ctx: &mut CheckContext) {
    let JsonValue::Array(items) = value else {
        ctx.error(
            code,
            PACKAGE_JSON,
            format!("{label} must be an array of strings"),
            Some("use a list containing only non-empty strings"),
        );
        return;
    };
    for (index, item) in items.iter().enumerate() {
        if string_value(Some(item)).is_none() {
            ctx.error(
                code,
                PACKAGE_JSON,
                format!("{label}[{index}] must be a non-empty string"),
                Some("remove the entry or replace it with a non-empty string"),
            );
        }
    }
}

fn match_paths(ctx: &CheckContext, pattern: &str) -> Vec<String> {
    let normalized = normalize_slashes(pattern.trim().trim_start_matches("./"));
    if !has_glob(&normalized) {
        return ctx
            .path_exists(&normalized)
            .then_some(normalized)
            .into_iter()
            .collect();
    }

    let mut matches = BTreeSet::new();
    for path in ctx
        .files
        .keys()
        .map(String::as_str)
        .chain(ctx.directories.iter().map(String::as_str))
    {
        if glob_matches(&normalized, path) {
            matches.insert(path.to_owned());
        }
    }
    matches.into_iter().collect()
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = normalize_slashes(pattern);
    let path = normalize_slashes(path);
    glob_match_parts(
        &pattern.split('/').collect::<Vec<_>>(),
        &path.split('/').collect::<Vec<_>>(),
    )
}

fn glob_match_parts(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        return glob_match_parts(&pattern[1..], path)
            || (!path.is_empty() && glob_match_parts(pattern, &path[1..]));
    }
    if path.is_empty() {
        return false;
    }
    segment_match(pattern[0], path[0]) && glob_match_parts(&pattern[1..], &path[1..])
}

fn segment_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pi, mut ti) = (0, 0);
    let mut star = None;
    let mut match_i = 0;
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == text[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            match_i = ti;
            pi += 1;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            match_i += 1;
            ti = match_i;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

fn validate_relative_pattern(pattern: &str) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("resource pattern must be non-empty".to_owned());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!("resource pattern '{pattern}' must be relative"));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) || trimmed
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.is_empty())
    {
        return Err(format!(
            "resource pattern '{pattern}' escapes the recipe directory"
        ));
    }
    Ok(())
}

fn has_dependency_lockfile(ctx: &CheckContext) -> bool {
    [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
    ]
    .iter()
    .any(|name| ctx.path_exists(name))
}

fn has_non_empty_object(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Object(map)) if !map.is_empty())
}

fn string_value(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn obj_string(map: &JsonMap, key: &str) -> Option<String> {
    match map.get(key) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn string_array(value: &JsonValue) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err("field must be an array of strings".to_owned());
    };
    for (index, item) in items.iter().enumerate() {
        if !matches!(item, JsonValue::String(value) if !value.trim().is_empty()) {
            return Err(format!("item {index} must be a non-empty string"));
        }
    }
    Ok(())
}

fn valid_model_spec(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !model.is_empty()
        && !provider.chars().any(|ch| ch.is_whitespace() || ch == ':')
}

fn json_string_set(value: &JsonValue) -> Option<BTreeSet<String>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| string_value(Some(item)))
            .collect(),
    )
}

fn mcp_package_policy_allows(policy: &McpToolSelectors, tool: &str) -> bool {
    let included = match &policy.include {
        Some(include) => include.contains("*") || include.contains(tool),
        None => false,
    };
    included
        && !policy
            .exclude
            .as_ref()
            .is_some_and(|exclude| exclude.contains(tool))
}

fn safe_mcp_server_id(value: &str) -> String {
    let mut id = String::new();
    let mut previous_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            id.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            id.push('-');
            previous_dash = true;
        }
    }
    let id = id.trim_matches('-').to_owned();
    if id.is_empty() {
        "mcp".to_owned()
    } else {
        id
    }
}

fn has_glob(value: &str) -> bool {
    value.chars().any(|ch| matches!(ch, '*' | '?'))
}

fn is_yaml_path(path: &str) -> bool {
    matches!(extension(path), Some("yaml" | "yml"))
}

fn is_loadable_extension_file(ctx: &CheckContext, path: &str) -> bool {
    ctx.has_file(path)
        && matches!(
            extension(path),
            Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
        )
}

fn extension(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty()).then_some(extension)
}

fn file_stem(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    if name.is_empty() {
        return None;
    }
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => Some(stem),
        _ => Some(name),
    }
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_relative(path: &str) -> String {
    let mut normalized = normalize_slashes(path.trim());
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_owned();
    }
    normalized.trim_matches('/').to_owned()
}

fn ancestor_dirs(path: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    for (index, ch) in path.char_indices() {
        if ch == '/' {
            ancestors.push(path[..index].to_owned());
        }
    }
    ancestors
}

/// Best-effort extraction of "line N column M" from a parser error message.
fn span_from_message(message: &str) -> Option<Span> {
    fn number_after<'a>(message: &'a str, keyword: &str) -> Option<(usize, &'a str)> {
        let start = message.find(keyword)? + keyword.len();
        let rest = message[start..].trim_start();
        let digits_len = rest.chars().take_while(char::is_ascii_digit).count();
        if digits_len == 0 {
            return None;
        }
        let value = rest[..digits_len].parse().ok()?;
        Some((value, &rest[digits_len..]))
    }

    let (line, rest) = number_after(message, "line")?;
    let column = number_after(rest, "column").map(|(value, _)| value)?;
    Some(Span { line, column })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipe_files(files: &[(&str, &str)]) -> RecipeFiles {
        RecipeFiles {
            files: files
                .iter()
                .map(|(path, content)| RecipeFile::new(*path, *content))
                .collect(),
            directories: Vec::new(),
        }
    }

    fn selector_recipe(
        package_tools: JsonValue,
        agent_mcp: &str,
        include_bash: bool,
    ) -> RecipeFiles {
        let package = json!({
            "name": "mcp-selector-test",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": package_tools
                    }]
                }
            }
        });
        let bash = if include_bash { "  - bash\n" } else { "" };
        let agent = format!(
            concat!(
                "name: agent\n",
                "description: Test agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "  thinking_level: low\n",
                "tools:\n",
                "  - read\n",
                "{}",
                "mcp:\n",
                "{}",
                "skills: []\n",
                "subagents: []\n",
                "system_instructions:\n",
                "  mode: append\n",
                "  content: Test instructions\n",
            ),
            bash, agent_mcp
        );
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", &agent),
        ])
    }

    #[test]
    fn accepts_package_and_agent_mcp_include_exclude_selectors() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            concat!(
                "  salesforce:\n",
                "    include:\n",
                "      - '*'\n",
                "    exclude:\n",
                "      - export_all\n",
            ),
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn preserves_a_legacy_flat_server_named_mode() {
        let package = json!({
            "name": "legacy-mode-server",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "mode",
                        "tools": { "include": ["search"] }
                    }]
                }
            }
        });
        let agent = concat!(
            "name: agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode:\n",
            "    include:\n",
            "      - search\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", agent),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_structured_tools_mode_with_authorized_initial_tools() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "get_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "        - get_profile\n",
                "  initial_tools:\n",
                "    salesforce:\n",
                "      - search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_invalid_structured_mcp_mode_and_initial_tools_shape() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            concat!(
                "  mode: deferred\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "  initial_tools:\n",
                "    salesforce: search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        for code in ["agent.mcp_mode_invalid", "agent.mcp_initial_tools_invalid"] {
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn rejects_initial_tools_outside_agent_authorization() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "delete_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "  initial_tools:\n",
                "    salesforce:\n",
                "      - delete_profile\n",
            ),
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_initial_tools_tool_unauthorized"
                && diagnostic.message.contains("salesforce/delete_profile")
        }));
    }

    #[test]
    fn accepts_independent_mcp_modes_across_visible_agent_tree() {
        let package = json!({
            "name": "mcp-mode-conflict",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": { "include": ["search_profiles"] }
                    }]
                }
            }
        });
        let root = concat!(
            "name: root\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: tools\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents:\n",
            "  - child\n",
            "system_instructions:\n",
            "  content: Root instructions\n",
        );
        let child = concat!(
            "name: child\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: cli\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Child instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/root.yaml", root),
            ("agents/child.yaml", child),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_agent_exact_selector_excluded_by_package_policy() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            "  salesforce:\n    include:\n      - delete_org\n",
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_tool_undeclared"
                && diagnostic.message.contains("salesforce/delete_org")
        }));
    }

    #[test]
    fn rejects_malformed_agent_mcp_selectors() {
        let input = selector_recipe(
            json!({ "include": ["*"] }),
            "  salesforce:\n    include:\n      - search_*\n",
            true,
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_selector_invalid"));
    }

    #[test]
    fn rejects_non_object_agent_mcp_blocks() {
        let package = json!({
            "name": "invalid-agent-mcp-shape",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let agent = concat!(
            "name: agent\n",
            "description: Test agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "mcp: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", agent),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_invalid"
                && diagnostic.severity == Severity::Error));
    }

    #[test]
    fn missing_agent_mcp_includes_are_silent_and_fail_closed() {
        let input = selector_recipe(json!({}), "  salesforce: {}\n", true);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.mcp_include_missing"
                && diagnostic.severity == Severity::Warning));
        assert!(!report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_include_missing"));

        let empty_agent_mcp = selector_recipe(json!({ "include": ["*"] }), "  {}\n", true);
        let empty_report = check_recipe_files(&empty_agent_mcp, CheckProfile::Ci);
        assert!(empty_report.valid, "{:?}", empty_report.diagnostics);
        assert!(!empty_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_empty"));
    }

    #[test]
    fn optional_agent_defaults_are_warnings() {
        let package = json!({
            "name": "agent-defaults",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "model:\n  name: test/provider-model\n"),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
        for code in [
            "agent.name_missing",
            "agent.model.thinkingLevel_missing",
            "agent.tools_missing",
            "agent.systemInstructions_missing",
        ] {
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == code && diagnostic.severity == Severity::Warning
                }),
                "missing warning {code}: {:?}",
                report.diagnostics
            );
        }
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.model.thinkingLevel_missing" && diagnostic.help.is_some()
        }));
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.systemInstructions_missing" && diagnostic.help.is_none()
        }));
    }

    #[test]
    fn malformed_local_mcp_example_is_only_a_warning() {
        let package = json!({
            "name": "local-mcp-example",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinking_level: low\ntools: []\nsystem_instructions:\n  content: Test\n",
            ),
            (".pi/mcp.local.example.json", "{ invalid"),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "mcp.local_example_malformed"
                && diagnostic.severity == Severity::Warning
        }));
    }

    #[test]
    fn rejects_recipe_eval_declarations() {
        let package = json!({
            "name": "evals-unsupported",
            "pi": {
                "agents": ["agents/*.yaml"],
                "evals": { "suites": [] }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinking_level: low\ntools: []\nsystem_instructions:\n  content: Test\n",
            ),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Local);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.evals_unsupported"));
    }

    #[test]
    fn rejects_agent_mcp_access_without_package_server_policy() {
        let mut input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            "  salesforce:\n    include:\n      - search_profiles\n",
            true,
        );
        let package = json!({
            "name": "mcp-policy-missing-test",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        input.files[0] = RecipeFile::new(
            "package.json",
            serde_json::to_string_pretty(&package).expect("serialize package"),
        );

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared"
                && diagnostic.message.contains("salesforce")
        }));
    }

    #[test]
    fn reports_missing_package_manifest() {
        let report = check_recipe_files(&RecipeFiles::default(), CheckProfile::Local);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_missing"));
    }

    #[test]
    fn reports_unread_file_content_as_unreadable() {
        let input = RecipeFiles {
            files: vec![RecipeFile::unread("package.json")],
            directories: Vec::new(),
        };

        let report = check_recipe_files(&input, CheckProfile::Local);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_unreadable"));
    }

    #[test]
    fn malformed_package_json_has_span() {
        let input = recipe_files(&[("package.json", "{\n  \"name\": ,\n}\n")]);

        let report = check_recipe_files(&input, CheckProfile::Local);

        let diagnostic = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "package.manifest_malformed")
            .expect("malformed diagnostic");
        let span = diagnostic.span.expect("span");
        assert_eq!(span.line, 2);
    }

    #[test]
    fn lockfile_requirement_escalates_by_profile() {
        let package = json!({
            "name": "lockfile-test",
            "description": "Test",
            "dependencies": { "left-pad": "^1.0.0" },
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let agent = concat!(
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
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", agent),
        ]);

        let local = check_recipe_files(&input, CheckProfile::Local);
        assert!(local.valid, "{:?}", local.diagnostics);
        assert!(local
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_missing"
                && diagnostic.severity == Severity::Warning));

        let ci = check_recipe_files(&input, CheckProfile::Ci);
        assert!(!ci.valid);

        let mut with_lockfile = input.clone();
        with_lockfile
            .files
            .push(RecipeFile::new("pnpm-lock.yaml", "lockfileVersion: 9\n"));
        let report = check_recipe_files(&with_lockfile, CheckProfile::Ci);
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn publish_requires_declared_license_text_and_current_lock_identity() {
        let package = json!({
            "name": "owned-recipe",
            "version": "0.2.0",
            "description": "Test",
            "license": "Apache-2.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let agent = concat!(
            "name: agent\n",
            "description: Test agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let lockfile = json!({
            "name": "upstream-recipe",
            "version": "0.1.0",
            "lockfileVersion": 3,
            "packages": { "": { "name": "upstream-recipe", "version": "0.1.0" } }
        });
        let mut input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "package-lock.json",
                &serde_json::to_string_pretty(&lockfile).expect("serialize lockfile"),
            ),
            ("agents/agent.yaml", agent),
            (".pi/mcp.local.json", "{\"servers\": []}\n"),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Publish);
        assert!(!report.valid);
        for code in [
            "package.license_file_missing",
            "package.lockfile_name_mismatch",
            "package.lockfile_version_mismatch",
            "package.local_config_present",
        ] {
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                report.diagnostics
            );
        }

        input.files.retain(|file| file.path != ".pi/mcp.local.json");
        input
            .files
            .push(RecipeFile::new("LICENSE", "Apache License\n"));
        let current_lock = json!({
            "name": "owned-recipe",
            "version": "0.2.0",
            "lockfileVersion": 3,
            "packages": { "": { "name": "owned-recipe", "version": "0.2.0" } }
        });
        input
            .files
            .iter_mut()
            .find(|file| file.path == "package-lock.json")
            .expect("lockfile")
            .content = Some(serde_json::to_string_pretty(&current_lock).expect("serialize lock"));

        let report = check_recipe_files(&input, CheckProfile::Publish);
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn resolves_agents_from_conventional_directory() {
        let package = json!({
            "name": "conventional-agents",
            "description": "Test",
            "pi": { "agents": ["agents"] }
        });
        let agent = concat!(
            "name: helper\n",
            "description: Helper agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "skills: []\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/helper.yaml", agent),
            ("agents/notes.md", "not an agent\n"),
            ("agents/nested/inner.yaml", "name: inner\n"),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert_eq!(report.resources.get("agents"), Some(&1));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn malformed_agent_yaml_is_reported() {
        let package = json!({
            "name": "malformed-agent",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "name: [unterminated\n"),
        ]);

        let report = check_recipe_files(&input, CheckProfile::Ci);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.yaml_malformed"));
    }
}

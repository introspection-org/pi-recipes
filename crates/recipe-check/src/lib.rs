use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckProfile {
    Local,
    Ci,
    Publish,
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
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
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

#[derive(Debug, Clone)]
struct Package {
    name: Option<String>,
    description: Option<String>,
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
    path: PathBuf,
    from: Option<String>,
    fields: HashSet<AgentField>,
    mcp: Option<BTreeMap<String, McpToolSelectors>>,
}

#[derive(Debug, Clone, Default)]
struct McpToolSelectors {
    include: Option<BTreeSet<String>>,
    exclude: Option<BTreeSet<String>>,
}

type McpToolPolicy = BTreeMap<String, McpToolSelectors>;

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
    const REQUIRED: [Self; 6] = [
        Self::ModelName,
        Self::ModelThinkingLevel,
        Self::Tools,
        Self::Skills,
        Self::Subagents,
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
}

#[derive(Debug, Clone)]
struct CheckContext {
    root: PathBuf,
    profile: CheckProfile,
    package_name: Option<String>,
    diagnostics: Vec<Diagnostic>,
    resources: BTreeMap<String, usize>,
}

impl CheckContext {
    fn new(root: PathBuf, profile: CheckProfile) -> Self {
        Self {
            root,
            profile,
            package_name: None,
            diagnostics: Vec::new(),
            resources: BTreeMap::new(),
        }
    }

    fn push(
        &mut self,
        severity: Severity,
        code: impl Into<String>,
        path: impl AsRef<Path>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.diagnostics.push(Diagnostic {
            severity,
            code: code.into(),
            path: self.display_path(path.as_ref()),
            message: message.into(),
            help: help.map(Into::into),
        });
    }

    fn error(
        &mut self,
        code: impl Into<String>,
        path: impl AsRef<Path>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Error, code, path, message, help);
    }

    fn warning(
        &mut self,
        code: impl Into<String>,
        path: impl AsRef<Path>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(Severity::Warning, code, path, message, help);
    }

    fn display_path(&self, path: &Path) -> String {
        let path = if path.is_absolute() {
            path.strip_prefix(&self.root).unwrap_or(path)
        } else {
            path
        };
        path_to_slashes(path)
    }
}

pub fn check_recipe(recipe_dir: impl AsRef<Path>, profile: CheckProfile) -> Result<Report> {
    let root = recipe_dir.as_ref().canonicalize().with_context(|| {
        format!(
            "failed to resolve recipe directory {}",
            recipe_dir.as_ref().display()
        )
    })?;
    let mut ctx = CheckContext::new(root.clone(), profile);

    let package = read_package(&root, &mut ctx);
    if let Some(package) = package {
        ctx.package_name = package.name.clone();
        validate_package_identity(&package, &mut ctx);
        validate_runtime_dependencies(&package, &mut ctx);
        let resources = validate_pi_config(&package, &mut ctx);
        validate_mcp_local_example(&mut ctx);

        let mcp_tool_policy = package
            .pi
            .as_ref()
            .and_then(JsonValue::as_object)
            .and_then(|pi| mcp_tool_policy(pi.get("mcp")));
        let agent_paths = resolve_agents(&resources, &mut ctx);
        ctx.resources.insert("agents".to_owned(), agent_paths.len());
        validate_agents(&agent_paths, mcp_tool_policy.as_ref(), &mut ctx);
        for key in ["extensions", "skills", "prompts"] {
            if let Some(paths) = resources.get(key) {
                ctx.resources.insert(key.to_owned(), paths.len());
            }
        }
    }

    let valid = !ctx
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_error());
    Ok(Report {
        valid,
        profile,
        recipe_dir: root.display().to_string(),
        package_name: ctx.package_name,
        diagnostics: ctx.diagnostics,
        resources: ctx.resources,
    })
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
            out.push_str(&format!(" ({})", diagnostic.path));
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

fn read_package(root: &Path, ctx: &mut CheckContext) -> Option<Package> {
    let path = root.join("package.json");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ctx.error(
                "package.manifest_missing",
                &path,
                "Recipe is missing package.json",
                Some("add package.json with a non-empty pi object"),
            );
            return None;
        }
        Err(err) => {
            ctx.error(
                "package.manifest_unreadable",
                &path,
                format!("Failed to read package.json: {err}"),
                None::<String>,
            );
            return None;
        }
    };

    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            ctx.error(
                "package.manifest_malformed",
                &path,
                format!("package.json is not valid JSON: {err}"),
                Some("fix package.json syntax"),
            );
            return None;
        }
    };

    let Some(object) = parsed.as_object() else {
        ctx.error(
            "package.manifest_invalid",
            &path,
            "package.json must be an object",
            None::<String>,
        );
        return None;
    };

    let pi = object.get("pi").cloned();
    if !matches!(pi.as_ref(), Some(JsonValue::Object(map)) if !map.is_empty()) {
        ctx.error(
            "package.pi_missing",
            &path,
            "package.json is missing a non-empty pi object",
            Some("add package.json#pi with recipe resources"),
        );
    }

    Some(Package {
        name: string_value(object.get("name")),
        description: string_value(object.get("description")),
        pi,
        runtime_dependencies: has_non_empty_object(object.get("dependencies"))
            || has_non_empty_object(object.get("optionalDependencies")),
    })
}

fn validate_package_identity(package: &Package, ctx: &mut CheckContext) {
    if package.name.is_none() {
        ctx.error(
            "package.name_missing",
            ctx.root.join("package.json"),
            "Package is missing name",
            Some("set package.json#name to the recipe identifier"),
        );
    }
    if package.description.is_none() {
        ctx.warning(
            "package.description_missing",
            ctx.root.join("package.json"),
            "Package is missing description",
            Some("add a short package.json#description for humans browsing recipes"),
        );
    }
}

fn validate_runtime_dependencies(package: &Package, ctx: &mut CheckContext) {
    if !package.runtime_dependencies || has_dependency_lockfile(&ctx.root) {
        return;
    }
    let severity = match ctx.profile {
        CheckProfile::Local => Severity::Warning,
        CheckProfile::Ci | CheckProfile::Publish => Severity::Error,
    };
    ctx.push(
        severity,
        "package.lockfile_missing",
        ctx.root.join("package.json"),
        "Recipe declares runtime dependencies but has no lockfile",
        Some("commit package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, or yarn.lock"),
    );
}

fn validate_pi_config(
    package: &Package,
    ctx: &mut CheckContext,
) -> HashMap<&'static str, Vec<PathBuf>> {
    let mut resolved = HashMap::new();
    let Some(JsonValue::Object(pi)) = package.pi.as_ref() else {
        return resolved;
    };
    let package_path = ctx.root.join("package.json");
    let known: HashSet<&str> = ["agents", "extensions", "skills", "prompts", "mcp", "evals"]
        .into_iter()
        .collect();
    for key in pi.keys() {
        if !known.contains(key.as_str()) {
            ctx.warning(
                "pi.unknown_key",
                &package_path,
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
                &package_path,
                "Recipe declares no loadable agents",
                Some("add agents/*.yaml or configure package.json#pi.agents"),
            );
        }
        resolved.insert(key, paths);
    }

    validate_mcp_config(pi.get("mcp"), ctx);
    validate_evals_config(pi.get("evals"), ctx);

    resolved
}

fn resource_patterns(
    key: &'static str,
    value: Option<&JsonValue>,
    required: bool,
    ctx: &mut CheckContext,
) -> ResourcePatterns {
    let package_path = ctx.root.join("package.json");
    match value {
        Some(JsonValue::Array(items)) => {
            let mut patterns = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                match string_value(Some(item)) {
                    Some(pattern) => patterns.push(pattern),
                    None => ctx.error(
                        format!("pi.{key}_invalid"),
                        &package_path,
                        format!("package.json#pi.{key}[{index}] must be a non-empty string"),
                        None::<String>,
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
                &package_path,
                format!("package.json#pi.{key} must be an array of strings"),
                None::<String>,
            );
            ResourcePatterns {
                explicit: true,
                patterns: Vec::new(),
            }
        }
        None => {
            let conventional = ctx.root.join(key);
            let patterns = if required || key != "extensions" {
                if conventional.exists() {
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
) -> Vec<PathBuf> {
    let mut resolved = BTreeSet::new();
    for pattern in &patterns.patterns {
        if let Err(message) = validate_relative_pattern(pattern) {
            ctx.error(
                format!("package.{key}_invalid"),
                ctx.root.join("package.json"),
                message,
                Some("use paths relative to the recipe directory"),
            );
            continue;
        }

        let matches = match_paths(&ctx.root, pattern);
        if matches.is_empty() {
            let severity = if required {
                Severity::Error
            } else {
                Severity::Warning
            };
            ctx.push(
                severity,
                format!("package.{key}_unmatched"),
                ctx.root.join("package.json"),
                format!("package.json#pi.{key} pattern '{pattern}' matched no files"),
                Some("update or remove the unmatched resource pattern"),
            );
        }
        for path in matches {
            if key == "extensions" && !is_loadable_extension_file(&path) {
                ctx.warning(
                    "package.extensions_non_loadable",
                    &path,
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
            ctx.root.join("package.json"),
            "Recipe has no package.json#pi.agents and no conventional agents directory",
            Some("add agents/*.yaml or configure package.json#pi.agents"),
        );
    }

    resolved.into_iter().collect()
}

fn resolve_agents(
    resources: &HashMap<&'static str, Vec<PathBuf>>,
    ctx: &mut CheckContext,
) -> Vec<PathBuf> {
    let mut agents = BTreeSet::new();
    for path in resources.get("agents").into_iter().flatten() {
        if path.is_file() {
            if is_yaml_file(path) {
                agents.insert(path.clone());
            }
        } else if path.is_dir() {
            match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() && is_yaml_file(&path) {
                            agents.insert(path);
                        }
                    }
                }
                Err(err) => ctx.error(
                    "package.agents_unreadable",
                    path,
                    format!("Failed to read agents directory: {err}"),
                    None::<String>,
                ),
            }
        }
    }
    agents.into_iter().collect()
}

fn validate_agents(
    agent_paths: &[PathBuf],
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let mut sources = Vec::new();
    for path in agent_paths {
        if let Some(agent) = read_agent(path, mcp_tool_policy, ctx) {
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
                ctx.error(
                    format!("agent.{}_missing", field.label()),
                    path,
                    format!(
                        "Recipe agent '{name}' must declare {} directly or inherit it with from",
                        field.label()
                    ),
                    None::<String>,
                );
            }
        }
        validate_resolved_agent_mcp(&name, &raw_by_name, &aliases, mcp_tool_policy, ctx);
    }
}

fn read_agent(
    path: &Path,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) -> Option<RawAgent> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) => {
            ctx.error(
                "agent.unreadable",
                path,
                format!("Failed to read agent YAML: {err}"),
                None::<String>,
            );
            return None;
        }
    };
    let parsed: YamlValue = match serde_yaml::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            ctx.error(
                "agent.yaml_malformed",
                path,
                format!("Agent file is not valid YAML: {err}"),
                Some("fix the YAML syntax"),
            );
            return None;
        }
    };
    let Some(map) = parsed.as_mapping() else {
        ctx.error(
            "agent.invalid",
            path,
            "Agent file must contain a YAML object",
            None::<String>,
        );
        return None;
    };

    let fallback_name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("agent")
        .to_owned();
    let explicit_name = yaml_string(map, "name").filter(|value| !value.trim().is_empty());
    let name = explicit_name
        .clone()
        .unwrap_or_else(|| fallback_name.clone());
    if explicit_name.is_none() {
        ctx.error(
            "agent.name_missing",
            path,
            format!("Recipe agent '{name}' must declare name"),
            Some("add a non-empty name field to the agent YAML"),
        );
    }
    if yaml_has_key(map, "name") && explicit_name.is_none() {
        ctx.error(
            "agent.name_invalid",
            path,
            "Agent name must be a non-empty string",
            None::<String>,
        );
    }

    if yaml_string(map, "description").is_none() {
        ctx.warning(
            "agent.description_missing",
            path,
            format!("Recipe agent '{name}' is missing description"),
            Some("add a short description to explain when this agent should be used"),
        );
    }

    let from = match yaml_value(map, "from") {
        Some(YamlValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Some(_) => {
            ctx.error(
                "agent.from_invalid",
                path,
                "Agent from must be a non-empty string",
                None::<String>,
            );
            None
        }
        None => None,
    };

    let mut fields = HashSet::new();
    validate_agent_model(map, path, &name, &mut fields, ctx);
    validate_agent_string_array(
        map,
        "tools",
        AgentField::Tools,
        path,
        &mut fields,
        mcp_tool_policy,
        ctx,
    );
    let mcp = validate_agent_mcp(map, path, ctx);
    validate_agent_string_array(
        map,
        "skills",
        AgentField::Skills,
        path,
        &mut fields,
        None,
        ctx,
    );
    validate_agent_string_array(
        map,
        "subagents",
        AgentField::Subagents,
        path,
        &mut fields,
        None,
        ctx,
    );
    validate_agent_system_instructions(map, path, &mut fields, ctx);
    validate_agent_extensions(map, path, ctx);
    validate_mcp_requires_bash(map, path, ctx);

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
    map: &serde_yaml::Mapping,
    path: &Path,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = yaml_value(map, "model") else {
        return;
    };
    let Some(model) = value.as_mapping() else {
        ctx.error(
            "agent.model_invalid",
            path,
            "Agent model must be an object",
            None::<String>,
        );
        return;
    };

    if let Some(model_name) = yaml_string(model, "name") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.model.name_invalid",
                path,
                format!(
                    "Recipe agent '{name}' has invalid model.name '{model_name}' - expected '<provider>/<model_id>'"
                ),
                None::<String>,
            );
        }
    } else if yaml_has_key(model, "name") {
        ctx.error(
            "agent.model.name_invalid",
            path,
            "Agent model.name must be a non-empty string",
            None::<String>,
        );
    }

    if yaml_string(model, "thinking_level").is_some()
        || yaml_string(model, "thinkingLevel").is_some()
    {
        fields.insert(AgentField::ModelThinkingLevel);
    } else if yaml_has_key(model, "thinking_level") || yaml_has_key(model, "thinkingLevel") {
        ctx.error(
            "agent.model.thinkingLevel_invalid",
            path,
            "Agent model thinking level must be a string",
            None::<String>,
        );
    }
}

fn validate_agent_string_array(
    map: &serde_yaml::Mapping,
    key: &'static str,
    field: AgentField,
    path: &Path,
    fields: &mut HashSet<AgentField>,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let Some(value) = yaml_value(map, key) else {
        return;
    };
    match yaml_string_array(value) {
        Ok(()) => {
            fields.insert(field);
            if key == "tools" {
                validate_mcp_tool_refs(value, path, mcp_tool_policy, ctx);
            }
        }
        Err(message) => ctx.error(
            format!("agent.{key}_invalid"),
            path,
            message,
            None::<String>,
        ),
    }
}

fn validate_mcp_requires_bash(map: &serde_yaml::Mapping, path: &Path, ctx: &mut CheckContext) {
    let tool_items = yaml_value(map, "tools").and_then(YamlValue::as_sequence);
    let has_legacy_mcp = tool_items.is_some_and(|items| {
        items
            .iter()
            .filter_map(YamlValue::as_str)
            .any(|tool| parse_mcp_tool_ref(tool).is_some())
    });
    let has_agent_mcp = yaml_value(map, "mcp")
        .and_then(YamlValue::as_mapping)
        .is_some_and(|mcp| {
            mcp.values().any(|server| {
                server
                    .as_mapping()
                    .and_then(|server| yaml_value(server, "include"))
                    .and_then(YamlValue::as_sequence)
                    .is_some_and(|items| !items.is_empty())
            })
        });
    let has_bash = tool_items.is_some_and(|items| {
        items
            .iter()
            .filter_map(YamlValue::as_str)
            .any(|tool| tool == "bash")
    });
    if (has_legacy_mcp || has_agent_mcp) && !has_bash {
        ctx.warning(
            "agent.mcp_requires_bash",
            path,
            "Agent declares MCP access without bash",
            Some("add bash or ensure another active tool can execute the session-local mcp CLI"),
        );
    }
}

fn validate_agent_mcp(
    map: &serde_yaml::Mapping,
    path: &Path,
    ctx: &mut CheckContext,
) -> Option<BTreeMap<String, McpToolSelectors>> {
    let Some(value) = yaml_value(map, "mcp") else {
        return None;
    };
    let Some(mcp) = value.as_mapping() else {
        ctx.error(
            "agent.mcp_invalid",
            path,
            "Agent mcp must be an object",
            None::<String>,
        );
        return Some(BTreeMap::new());
    };
    if mcp.is_empty() {
        ctx.error(
            "agent.mcp_empty",
            path,
            "Agent mcp must declare at least one server; omit mcp for no access",
            None::<String>,
        );
    }

    let mut parsed = BTreeMap::new();
    for (server_key, value) in mcp {
        let Some(server_id) = server_key.as_str().filter(|value| !value.trim().is_empty()) else {
            ctx.error(
                "agent.mcp_server_invalid",
                path,
                "Agent mcp server ids must be non-empty strings",
                None::<String>,
            );
            continue;
        };
        let Some(server) = value.as_mapping() else {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("Agent mcp server '{server_id}' must be an object"),
                None::<String>,
            );
            continue;
        };
        let mut selectors = McpToolSelectors::default();
        for key in ["include", "exclude"] {
            let Some(value) = yaml_value(server, key) else {
                continue;
            };
            if let Err(message) = yaml_string_array(value) {
                ctx.error(
                    "agent.mcp_invalid",
                    path,
                    format!("mcp.{server_id}.{key}: {message}"),
                    None::<String>,
                );
                continue;
            }
            let Some(items) = value.as_sequence() else {
                continue;
            };
            let values = items
                .iter()
                .filter_map(YamlValue::as_str)
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
        parsed.insert(safe_mcp_server_id(server_id), selectors);
    }
    Some(parsed)
}

fn validate_agent_system_instructions(
    map: &serde_yaml::Mapping,
    path: &Path,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    if let Some(prompt) = yaml_value(map, "prompt") {
        if matches!(prompt, YamlValue::String(value) if !value.trim().is_empty()) {
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

    let Some(value) =
        yaml_value(map, "system_instructions").or_else(|| yaml_value(map, "systemInstructions"))
    else {
        return;
    };
    let Some(system) = value.as_mapping() else {
        ctx.error(
            "agent.systemInstructions_invalid",
            path,
            "Agent system_instructions must be an object",
            None::<String>,
        );
        return;
    };
    match yaml_value(system, "content") {
        Some(YamlValue::String(_)) => {
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
    if let Some(mode) = yaml_value(system, "mode") {
        match mode {
            YamlValue::String(value) if value == "append" || value == "replace" => {}
            YamlValue::String(_) => ctx.error(
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

fn validate_agent_extensions(map: &serde_yaml::Mapping, path: &Path, ctx: &mut CheckContext) {
    let Some(value) = yaml_value(map, "extensions") else {
        return;
    };
    let Some(extensions) = value.as_mapping() else {
        ctx.error(
            "agent.extensions_invalid",
            path,
            "Agent extensions must be an object",
            None::<String>,
        );
        return;
    };
    for key in ["include", "exclude"] {
        if let Some(value) = yaml_value(extensions, key) {
            if let Err(message) = yaml_string_array(value) {
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
                ctx.root.join("agents"),
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
                &source.path,
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
                &agent.path,
                format!("Recipe agent '{}' has cyclic from chain", agent.name),
                Some("remove the inheritance cycle"),
            );
            return;
        }
        if !raw_by_name.contains_key(&parent) {
            ctx.error(
                "agent.from_missing",
                &agent.path,
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
) -> Option<BTreeMap<String, McpToolSelectors>> {
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
        return (!merged.is_empty()).then_some(merged);
    };
    for (server_id, child_tools) in child {
        let base_tools = merged.get(server_id);
        merged.insert(
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

    for (server_id, selection) in mcp {
        let Some(include) = selection.include else {
            ctx.error(
                "agent.mcp_include_missing",
                &path,
                format!(
                    "Recipe agent '{name}' MCP server '{server_id}' must declare include; use ['*'] for all tools or [] for none"
                ),
                None::<String>,
            );
            continue;
        };
        let Some(server_policy) = mcp_tool_policy.and_then(|policy| policy.get(&server_id)) else {
            ctx.error(
                "agent.mcp_server_undeclared",
                &path,
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
                &path,
                format!(
                    "Recipe agent '{name}' MCP tool '{server_id}/{tool}' is not included by the package policy"
                ),
                Some("include the tool in the package MCP policy or update the agent"),
            );
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

fn validate_mcp_tool_refs(
    value: &YamlValue,
    path: &Path,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let Some(items) = value.as_sequence() else {
        return;
    };
    for item in items {
        let Some(tool) = item.as_str() else {
            continue;
        };
        if !tool.starts_with("mcp:") {
            continue;
        }
        let Some((server, tool_name)) = parse_mcp_tool_ref(tool) else {
            ctx.error(
                "agent.mcp_ref_invalid",
                path,
                format!("Invalid MCP tool reference '{tool}'"),
                Some("use mcp:<server-id>/<tool-name>"),
            );
            continue;
        };
        let server_id = safe_mcp_server_id(server);
        let Some(server_policy) = mcp_tool_policy.and_then(|policy| policy.get(&server_id)) else {
            ctx.error(
                "agent.mcp_server_undeclared",
                path,
                format!("Agent MCP tool reference '{tool}' uses undeclared server '{server_id}'"),
                Some("add the server to package.json#pi.mcp.servers or update the mcp:<server-id>/<tool-name> reference"),
            );
            continue;
        };
        if !mcp_package_policy_allows(server_policy, tool_name) {
            ctx.error(
                "agent.mcp_tool_undeclared",
                path,
                format!(
                    "Agent MCP tool reference '{tool}' is not included by package.json#pi.mcp.servers for server '{server_id}'"
                ),
                Some("include the tool in that server's tools policy or update the agent reference"),
            );
        }
    }
}

fn validate_mcp_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let package_path = ctx.root.join("package.json");
    match value {
        JsonValue::String(path) => validate_mcp_manifest_pattern(path, ctx),
        JsonValue::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if let Some(path) = string_value(Some(item)) {
                    validate_mcp_manifest_pattern(&path, ctx);
                } else {
                    ctx.error(
                        "pi.mcp_invalid",
                        &package_path,
                        format!("package.json#pi.mcp[{index}] must be a non-empty string"),
                        None::<String>,
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
                        &package_path,
                        "package.json#pi.mcp.manifest must be a non-empty string",
                        None::<String>,
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
                                    &package_path,
                                    format!("package.json#pi.mcp.manifests[{index}] must be a non-empty string"),
                                    None::<String>,
                                );
                            }
                        }
                    }
                    _ => ctx.error(
                        "pi.mcp_invalid",
                        &package_path,
                        "package.json#pi.mcp.manifests must be an array of strings",
                        None::<String>,
                    ),
                }
            }
            validate_mcp_servers(map.get("servers"), ctx);
        }
        _ => ctx.error(
            "pi.mcp_invalid",
            &package_path,
            "package.json#pi.mcp must be an object, string, or string array",
            None::<String>,
        ),
    }
}

fn validate_mcp_servers(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let package_path = ctx.root.join("package.json");
    let JsonValue::Array(servers) = value else {
        ctx.error(
            "pi.mcp_invalid",
            &package_path,
            "package.json#pi.mcp.servers must be an array",
            None::<String>,
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "pi.mcp_invalid",
                &package_path,
                format!("package.json#pi.mcp.servers[{index}] must be an object"),
                None::<String>,
            );
            continue;
        };
        if string_value(server.get("id")).is_none() {
            ctx.error(
                "pi.mcp_invalid",
                &package_path,
                format!("package.json#pi.mcp.servers[{index}].id must be a non-empty string"),
                None::<String>,
            );
        }
        if let Some(required) = server.get("required") {
            if !required.is_boolean() {
                ctx.error(
                    "pi.mcp_invalid",
                    &package_path,
                    format!("package.json#pi.mcp.servers[{index}].required must be boolean"),
                    None::<String>,
                );
            }
        }
        if let Some(tools) = server.get("tools") {
            let JsonValue::Object(tools) = tools else {
                ctx.error(
                    "pi.mcp_invalid",
                    &package_path,
                    format!("package.json#pi.mcp.servers[{index}].tools must be an object"),
                    None::<String>,
                );
                continue;
            };
            if !tools.contains_key("include") && !tools.contains_key("allow") {
                ctx.error(
                    "pi.mcp_include_missing",
                    &package_path,
                    format!(
                        "package.json#pi.mcp.servers[{index}].tools must declare include; use ['*'] for all tools or [] for none"
                    ),
                    None::<String>,
                );
            }
            if tools.contains_key("allow") {
                ctx.warning(
                    "pi.mcp_allow_deprecated",
                    &package_path,
                    format!("package.json#pi.mcp.servers[{index}].tools.allow is deprecated"),
                    Some("migrate tools.allow to tools.include"),
                );
            }
            if tools.contains_key("allow") && tools.contains_key("include") {
                ctx.error(
                    "pi.mcp_invalid",
                    &package_path,
                    format!("package.json#pi.mcp.servers[{index}].tools cannot declare both allow and include"),
                    Some("use include and exclude; allow is a legacy alias for include"),
                );
            }
            for key in ["include", "exclude", "allow"] {
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
                        let valid = if key == "include" || key == "allow" {
                            !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                        } else {
                            !selector.is_empty() && !selector.contains('*')
                        };
                        if !valid {
                            ctx.error(
                                "pi.mcp_selector_invalid",
                                &package_path,
                                format!(
                                    "package.json#pi.mcp.servers[{index}].tools.{key} entry '{selector}' must be {}",
                                    if key == "include" || key == "allow" {
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
            ctx.error(
                "pi.mcp_include_missing",
                &package_path,
                format!(
                    "package.json#pi.mcp.servers[{index}] must declare tools.include; use ['*'] for all tools or [] for none"
                ),
                None::<String>,
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
        let include = tools.and_then(|tools| {
            if let Some(include) = tools.get("include") {
                return json_string_set(include);
            }
            let mut allow = tools.get("allow").and_then(json_string_set)?;
            if allow.is_empty() {
                allow.insert("*".to_owned());
            }
            Some(allow)
        });
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
            ctx.root.join("package.json"),
            message,
            Some("use manifest paths relative to the recipe directory"),
        );
        return;
    }
    let matches = match_paths(&ctx.root, pattern);
    if matches.is_empty() {
        ctx.error(
            "pi.mcp_manifest_missing",
            ctx.root.join("package.json"),
            format!("MCP manifest pattern '{pattern}' matched no files"),
            Some("add the manifest file or update package.json#pi.mcp"),
        );
    }
}

fn validate_mcp_local_example(ctx: &mut CheckContext) {
    let path = ctx.root.join(".pi").join("mcp.local.example.json");
    if !path.exists() {
        return;
    }
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => {
            ctx.error(
                "mcp.local_example_unreadable",
                &path,
                format!("Failed to read MCP local example: {err}"),
                None::<String>,
            );
            return;
        }
    };
    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            ctx.error(
                "mcp.local_example_malformed",
                &path,
                format!(".pi/mcp.local.example.json is not valid JSON: {err}"),
                Some("fix the local MCP config template JSON"),
            );
            return;
        }
    };
    let JsonValue::Object(map) = parsed else {
        ctx.error(
            "mcp.local_example_invalid",
            &path,
            ".pi/mcp.local.example.json must be an object",
            None::<String>,
        );
        return;
    };
    let Some(servers) = map.get("servers") else {
        return;
    };
    let JsonValue::Array(servers) = servers else {
        ctx.error(
            "mcp.local_example_invalid",
            &path,
            ".pi/mcp.local.example.json servers must be an array",
            None::<String>,
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "mcp.local_example_invalid",
                &path,
                format!("servers[{index}] must be an object"),
                None::<String>,
            );
            continue;
        };
        for key in ["id", "name", "transport", "url"] {
            if let Some(value) = server.get(key) {
                if string_value(Some(value)).is_none() {
                    ctx.error(
                        "mcp.local_example_invalid",
                        &path,
                        format!("servers[{index}].{key} must be a non-empty string"),
                        None::<String>,
                    );
                }
            }
        }
        if let Some(headers) = server.get("headers") {
            let JsonValue::Object(headers) = headers else {
                ctx.error(
                    "mcp.local_example_invalid",
                    &path,
                    format!("servers[{index}].headers must be an object"),
                    None::<String>,
                );
                continue;
            };
            for (key, value) in headers {
                if !matches!(value, JsonValue::String(_)) {
                    ctx.error(
                        "mcp.local_example_invalid",
                        &path,
                        format!("servers[{index}].headers.{key} must be a string"),
                        None::<String>,
                    );
                }
            }
        }
    }
}

fn validate_evals_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let package_path = ctx.root.join("package.json");
    let JsonValue::Object(evals) = value else {
        ctx.error(
            "evals.suite_invalid",
            &package_path,
            "package.json#pi.evals must be an object with a suites array",
            None::<String>,
        );
        return;
    };
    let Some(suites) = evals.get("suites") else {
        return;
    };
    let JsonValue::Array(suites) = suites else {
        ctx.error(
            "evals.suite_invalid",
            &package_path,
            "package.json#pi.evals.suites must be an array",
            None::<String>,
        );
        return;
    };

    let mut seen = HashMap::new();
    for (index, suite) in suites.iter().enumerate() {
        let label = format!("pi.evals.suites[{index}]");
        let JsonValue::Object(suite) = suite else {
            ctx.error(
                "evals.suite_invalid",
                &package_path,
                format!("{label} must be an object"),
                None::<String>,
            );
            continue;
        };
        let name = string_value(suite.get("name"));
        if let Some(name) = &name {
            if let Some(first) = seen.insert(name.clone(), index) {
                ctx.error(
                    "evals.name_duplicate",
                    &package_path,
                    format!("{label} reuses suite name '{name}' already declared at pi.evals.suites[{first}]"),
                    None::<String>,
                );
            }
        } else {
            ctx.error(
                "evals.suite_invalid",
                &package_path,
                format!("{label} must declare a non-empty name"),
                None::<String>,
            );
        }
        let suite_type = string_value(suite.get("type"));
        match suite_type.as_deref() {
            Some("registry") => validate_registry_eval_suite(suite, &label, ctx),
            Some("git") => validate_git_eval_suite(suite, &label, ctx),
            _ => ctx.error(
                "evals.suite_invalid",
                &package_path,
                format!("{label} must use type 'registry' or 'git'"),
                None::<String>,
            ),
        }
    }
}

fn validate_registry_eval_suite(
    suite: &serde_json::Map<String, JsonValue>,
    label: &str,
    ctx: &mut CheckContext,
) {
    let package_path = ctx.root.join("package.json");
    if string_value(suite.get("dataset")).is_none() {
        ctx.error(
            "evals.suite_invalid",
            &package_path,
            format!("{label} registry suite must declare dataset"),
            None::<String>,
        );
    }
    match string_value(suite.get("version")) {
        Some(version) if fixed_registry_tag(&version) => {}
        Some(version) => ctx.error(
            "evals.pin_mutable",
            &package_path,
            format!("{label} registry version must be an explicit Harbor registry tag, not a mutable alias or range: {version}"),
            None::<String>,
        ),
        None => ctx.error(
            "evals.suite_invalid",
            &package_path,
            format!("{label} registry suite must declare version"),
            None::<String>,
        ),
    }
}

fn validate_git_eval_suite(
    suite: &serde_json::Map<String, JsonValue>,
    label: &str,
    ctx: &mut CheckContext,
) {
    let package_path = ctx.root.join("package.json");
    if string_value(suite.get("repo")).is_none() {
        ctx.error(
            "evals.suite_invalid",
            &package_path,
            format!("{label} git suite must declare repo"),
            None::<String>,
        );
    }
    match string_value(suite.get("rev")) {
        Some(rev) if fixed_git_rev(&rev) => {}
        Some(rev) => ctx.error(
            "evals.pin_mutable",
            &package_path,
            format!("{label} git rev must be a 7-40 character hex commit SHA: {rev}"),
            None::<String>,
        ),
        None => ctx.error(
            "evals.suite_invalid",
            &package_path,
            format!("{label} git suite must declare rev"),
            None::<String>,
        ),
    }
    if string_value(suite.get("dataset")).is_none() {
        ctx.error(
            "evals.suite_invalid",
            &package_path,
            format!("{label} git suite must declare dataset"),
            None::<String>,
        );
    }
}

fn validate_json_string_array(value: &JsonValue, label: &str, code: &str, ctx: &mut CheckContext) {
    let package_path = ctx.root.join("package.json");
    let JsonValue::Array(items) = value else {
        ctx.error(
            code,
            &package_path,
            format!("{label} must be an array of strings"),
            None::<String>,
        );
        return;
    };
    for (index, item) in items.iter().enumerate() {
        if string_value(Some(item)).is_none() {
            ctx.error(
                code,
                &package_path,
                format!("{label}[{index}] must be a non-empty string"),
                None::<String>,
            );
        }
    }
}

fn match_paths(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let normalized = normalize_slashes(pattern.trim().trim_start_matches("./"));
    let absolute = root.join(normalized.as_str());
    if !has_glob(&normalized) {
        return absolute.exists().then_some(absolute).into_iter().collect();
    }

    let entries: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.path().to_owned())
        .collect();
    entries
        .into_iter()
        .filter(|path| {
            let Ok(relative) = path.strip_prefix(root) else {
                return false;
            };
            glob_matches(&normalized, &path_to_slashes(relative))
        })
        .collect()
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

fn validate_relative_pattern(pattern: &str) -> std::result::Result<(), String> {
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

fn has_dependency_lockfile(root: &Path) -> bool {
    [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
    ]
    .iter()
    .any(|name| root.join(name).exists())
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

fn yaml_value<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a YamlValue> {
    map.get(YamlValue::String(key.to_owned()))
}

fn yaml_has_key(map: &serde_yaml::Mapping, key: &str) -> bool {
    map.contains_key(YamlValue::String(key.to_owned()))
}

fn yaml_string(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    match yaml_value(map, key) {
        Some(YamlValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn yaml_string_array(value: &YamlValue) -> std::result::Result<(), String> {
    let Some(items) = value.as_sequence() else {
        return Err("field must be an array of strings".to_owned());
    };
    for (index, item) in items.iter().enumerate() {
        if !matches!(item, YamlValue::String(value) if !value.trim().is_empty()) {
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

fn parse_mcp_tool_ref(value: &str) -> Option<(&str, &str)> {
    let body = value.strip_prefix("mcp:")?.trim();
    let (server, tool) = body.split_once('/')?;
    let server = server.trim();
    let tool = tool.trim();
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
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

fn fixed_registry_tag(value: &str) -> bool {
    let tag = value.trim();
    if tag.is_empty() || tag.eq_ignore_ascii_case("latest") {
        return false;
    }
    if tag.chars().any(char::is_whitespace) || tag.chars().any(|ch| "^~<>=*|".contains(ch)) {
        return false;
    }
    !tag.split(['.', '_', '-'])
        .any(|part| part.eq_ignore_ascii_case("x"))
}

fn fixed_git_rev(value: &str) -> bool {
    let len = value.len();
    (7..=40).contains(&len) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn has_glob(value: &str) -> bool {
    value.chars().any(|ch| matches!(ch, '*' | '?'))
}

fn is_yaml_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("yaml" | "yml")
    )
}

fn is_loadable_extension_file(path: &Path) -> bool {
    path.is_file()
        && matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
        )
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
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_recipe(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("recipe-check-{name}-{suffix}"));
        fs::create_dir_all(root.join("agents")).expect("create recipe dirs");
        root
    }

    fn write_recipe(
        root: &Path,
        server_id: &str,
        allowed: &[&str],
        agent_tools: &[&str],
        include_bash: bool,
    ) {
        let package = json!({
            "name": "mcp-policy-test",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": server_id,
                        "tools": { "allow": allowed }
                    }]
                }
            }
        });
        fs::write(
            root.join("package.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&package).expect("serialize package")
            ),
        )
        .expect("write package");

        let tools = agent_tools
            .iter()
            .map(|tool| format!("  - {tool}"))
            .collect::<Vec<_>>()
            .join("\n");
        let bash = if include_bash { "  - bash\n" } else { "" };
        fs::write(
            root.join("agents").join("agent.yaml"),
            format!(
                concat!(
                    "name: agent\n",
                    "description: Test agent\n",
                    "model:\n",
                    "  name: test/provider-model\n",
                    "  thinking_level: low\n",
                    "tools:\n",
                    "  - read\n",
                    "{}",
                    "{}\n",
                    "skills: []\n",
                    "subagents: []\n",
                    "system_instructions:\n",
                    "  mode: append\n",
                    "  content: Test instructions\n",
                ),
                bash, tools
            ),
        )
        .expect("write agent");
    }

    fn write_selector_recipe(
        root: &Path,
        package_tools: JsonValue,
        agent_mcp: &str,
        include_bash: bool,
    ) {
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
        fs::write(
            root.join("package.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&package).expect("serialize package")
            ),
        )
        .expect("write package");

        let bash = if include_bash { "  - bash\n" } else { "" };
        fs::write(
            root.join("agents").join("agent.yaml"),
            format!(
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
            ),
        )
        .expect("write agent");
    }

    #[test]
    fn flags_agent_mcp_refs_to_undeclared_servers() {
        let root = temp_recipe("mcp-server");
        write_recipe(
            &root,
            "slack-mcp",
            &["slack_read_channel"],
            &["mcp:slack/slack_read_channel"],
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared"
                && diagnostic.message.contains("mcp:slack/slack_read_channel")
                && diagnostic.message.contains("slack")
        }));
    }

    #[test]
    fn flags_agent_mcp_refs_to_undeclared_tools() {
        let root = temp_recipe("mcp-tool");
        write_recipe(
            &root,
            "slack-mcp",
            &["slack_read_channel"],
            &["mcp:slack-mcp/slack_send_message"],
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_tool_undeclared"
                && diagnostic
                    .message
                    .contains("mcp:slack-mcp/slack_send_message")
        }));
    }

    #[test]
    fn accepts_agent_mcp_refs_declared_in_policy() {
        let root = temp_recipe("mcp-ok");
        write_recipe(
            &root,
            "Slack MCP",
            &["slack_read_channel"],
            &["mcp:slack-mcp/slack_read_channel"],
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn preserves_empty_legacy_allow_as_uncapped_with_warning() {
        let root = temp_recipe("mcp-legacy-empty-allow");
        write_recipe(
            &root,
            "nextplay",
            &[],
            &["mcp:nextplay/search_profiles"],
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.mcp_allow_deprecated" && diagnostic.severity == Severity::Warning
        }));
    }

    #[test]
    fn warns_for_agent_mcp_refs_without_bash() {
        let root = temp_recipe("mcp-requires-bash");
        write_recipe(
            &root,
            "slack-mcp",
            &["slack_read_channel"],
            &["mcp:slack-mcp/slack_read_channel"],
            false,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_requires_bash" && diagnostic.severity == Severity::Warning
        }));
    }

    #[test]
    fn accepts_package_and_agent_mcp_include_exclude_selectors() {
        let root = temp_recipe("mcp-selectors");
        write_selector_recipe(
            &root,
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

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_agent_exact_selector_excluded_by_package_policy() {
        let root = temp_recipe("mcp-selector-excluded");
        write_selector_recipe(
            &root,
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            "  salesforce:\n    include:\n      - delete_org\n",
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_tool_undeclared"
                && diagnostic.message.contains("salesforce/delete_org")
        }));
    }

    #[test]
    fn rejects_malformed_agent_mcp_selectors() {
        let root = temp_recipe("mcp-selector-invalid");
        write_selector_recipe(
            &root,
            json!({ "include": ["*"] }),
            "  salesforce:\n    include:\n      - search_*\n",
            true,
        );

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_selector_invalid"));
    }

    #[test]
    fn requires_explicit_package_and_agent_mcp_includes() {
        let root = temp_recipe("mcp-selector-missing-include");
        write_selector_recipe(&root, json!({}), "  salesforce: {}\n", true);

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.mcp_include_missing"));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_include_missing"));
    }

    #[test]
    fn rejects_agent_mcp_access_without_package_server_policy() {
        let root = temp_recipe("mcp-package-policy-missing");
        write_recipe(
            &root,
            "nextplay",
            &["search_profiles"],
            &["mcp:nextplay/search_profiles"],
            true,
        );
        let package = json!({
            "name": "mcp-policy-missing-test",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        fs::write(
            root.join("package.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&package).expect("serialize package")
            ),
        )
        .expect("write package");

        let report = check_recipe(&root, CheckProfile::Ci).expect("check recipe");
        fs::remove_dir_all(&root).expect("cleanup recipe");

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared"
                && diagnostic.message.contains("nextplay")
        }));
    }
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

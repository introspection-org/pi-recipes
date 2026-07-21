import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  loadRecipeAgentDefinitions,
  resolveRecipeAgentDefinition,
  validateRecipeAgentDefinitions,
} from "./recipe-agent.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
  type RecipePackageManifest,
  type RecipePackageResources,
  type RecipeValidationFinding,
  type RecipeValidationReport,
} from "./recipe-package.js";

export interface RecipeScaffoldFile {
  path: string;
  action: "created" | "overwritten" | "existing";
}

export interface RecipeScaffoldResult {
  recipeDir: string;
  name: string;
  files: RecipeScaffoldFile[];
}

export interface RecipeDevelopmentReport {
  valid: boolean;
  manifest: RecipePackageManifest;
  findings: RecipeValidationFinding[];
  resources: Partial<Record<keyof RecipePackageResources | "evals", string[]>>;
}

export interface RecipePublishGuide {
  manifest: RecipePackageManifest;
  report: RecipeDevelopmentReport;
  sourceExamples: string[];
  checklist: string[];
}

const RESOURCE_KEYS: Array<keyof RecipePackageResources> = [
  "agents",
  "extensions",
  "skills",
  "prompts",
];

function recipeNameFromTarget(target: string): string {
  const name = basename(resolve(target)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return name && name !== "." && name !== ".." ? name : "my-recipe";
}

function finding(
  severity: RecipeValidationFinding["severity"],
  code: string,
  message: string,
  packageName?: string
): RecipeValidationFinding {
  return {
    severity,
    code,
    message,
    packageName,
  };
}

function writeScaffoldFile(
  path: string,
  content: string,
  opts: { force?: boolean }
): RecipeScaffoldFile {
  const exists = existsSync(path);
  if (exists && !opts.force) return { path, action: "existing" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { path, action: exists ? "overwritten" : "created" };
}

function assertScaffoldTargetWritable(
  files: string[],
  opts: { force?: boolean }
): void {
  if (opts.force) return;
  const existing = files.filter((path) => existsSync(path));
  if (existing.length === 0) return;
  throw new Error(
    [
      "Recipe scaffold would overwrite existing files:",
      ...existing.map((path) => `  - ${path}`),
      "Re-run with --force to overwrite them.",
    ].join("\n")
  );
}

export function createRecipeScaffold(
  target: string,
  opts: { cwd?: string; name?: string; force?: boolean } = {}
): RecipeScaffoldResult {
  const cwd = opts.cwd ?? process.cwd();
  const recipeDir = resolve(cwd, target);
  const name = (opts.name?.trim() || recipeNameFromTarget(recipeDir)).replace(
    /[^a-zA-Z0-9._-]+/g,
    "-"
  );
  const files = [
    join(recipeDir, "package.json"),
    join(recipeDir, "SYSTEM.md"),
    join(recipeDir, "agents", "agent.yaml"),
    join(recipeDir, "README.md"),
  ];

  if (existsSync(recipeDir) && !statSync(recipeDir).isDirectory()) {
    throw new Error(`Recipe target exists and is not a directory: ${recipeDir}`);
  }
  assertScaffoldTargetWritable(files, opts);
  mkdirSync(join(recipeDir, "agents"), { recursive: true });

  const written = [
    writeScaffoldFile(
      files[0]!,
      `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          description: "Describe what this recipe helps users do.",
          type: "module",
          pi: {
            agents: ["agents/*.yaml"],
          },
        },
        null,
        2
      )}\n`,
      opts
    ),
    writeScaffoldFile(
      files[1]!,
      [
        "# Recipe Workflow",
        "",
        "Describe the durable workflow guidance this recipe should add to the session.",
        "",
      ].join("\n"),
      opts
    ),
    writeScaffoldFile(
      files[2]!,
      [
        "name: agent",
        "description: Main recipe agent.",
        "model:",
        "  name: openai/gpt-5.4",
        "  thinking_level: medium",
        "tools:",
        "  - read",
        "  - bash",
        "system_instructions:",
        "  mode: append",
        "  content: |",
        "    Follow the recipe workflow.",
        "",
      ].join("\n"),
      opts
    ),
    writeScaffoldFile(
      files[3]!,
      [
        `# ${name}`,
        "",
        "## Develop",
        "",
        "```bash",
        "recipes check .",
        "pi --recipe . --agent agent",
        "```",
        "",
        "## Publish",
        "",
        "Commit this directory to Git and share the repository locator:",
        "",
        "```bash",
        `recipes install github:owner/${name}`,
        "```",
        "",
      ].join("\n"),
      opts
    ),
  ];

  return { recipeDir, name, files: written };
}

export function validateRecipeDirectory(recipeDir: string): RecipeDevelopmentReport {
  const manifest = readPiPackageManifest(recipeDir);
  const baseReport: RecipeValidationReport = validatePiPackageManifest(manifest);
  const findings = [...baseReport.findings];
  const resources: RecipeDevelopmentReport["resources"] = {};

  for (const key of RESOURCE_KEYS) {
    try {
      resources[key] = packageResourcePaths(manifest, key);
    } catch (err) {
      findings.push(
        finding(
          "error",
          `package.${key}_invalid`,
          err instanceof Error ? err.message : String(err),
          manifest.name
        )
      );
    }
  }
  resources.evals = manifest.evals.suites.map((suite) => suite.name);

  try {
    const agents = loadRecipeAgentDefinitions(recipeDir);
    const uniqueAgents = new Set(
      [...agents.values()].map((agent) => agent.name)
    );
    if (uniqueAgents.size === 0) {
      findings.push(
        finding(
          "warning",
          "agent.none_loaded",
          "No recipe agent definitions were loaded",
          manifest.name
        )
      );
    }
    for (const agentFinding of validateRecipeAgentDefinitions(recipeDir)) {
      findings.push(
        finding(
          agentFinding.severity ?? "error",
          `agent.${agentFinding.code ?? `${agentFinding.field}_missing`}`,
          agentFinding.message,
          manifest.name
        )
      );
    }
    if (uniqueAgents.size > 0) {
      try {
        resolveRecipeAgentDefinition({ recipeDir });
      } catch (err) {
        findings.push(
          finding(
            "warning",
            "agent.default_missing",
            err instanceof Error ? err.message : String(err),
            manifest.name
          )
        );
      }
    }
  } catch (err) {
    findings.push(
      finding(
        "error",
        "agent.invalid",
        err instanceof Error ? err.message : String(err),
        manifest.name
      )
    );
  }

  return {
    valid: findings.every((item) => item.severity !== "error"),
    manifest,
    findings,
    resources,
  };
}

export function createRecipePublishGuide(recipeDir: string): RecipePublishGuide {
  const report = validateRecipeDirectory(recipeDir);
  const name = report.manifest.name;
  const repositoryName = name.startsWith("@")
    ? name.slice(1).split("/").at(-1) ?? name.slice(1)
    : name;
  return {
    manifest: report.manifest,
    report,
    checklist: [
      "Run `recipes check .` and fix any errors.",
      `Run \`recipes publish . --github owner/${repositoryName} --visibility private\` to create, commit, and push a GitHub repository.`,
      "Commit package.json, agents, prompts, skills, extensions, and SYSTEM.md.",
      "If extensions have runtime dependencies, commit the package lockfile.",
      "Push the recipe to a Git repository.",
      "Tag releases when users should install a stable version.",
    ],
    sourceExamples: [
      `recipes install github:owner/${repositoryName}`,
      `recipes install github:owner/${repositoryName}#v${report.manifest.version}`,
      `recipes install git@github.com:owner/${repositoryName}.git`,
    ],
  };
}

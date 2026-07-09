import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RECIPE_ENV_PREFIX = "PI_RECIPES_";

export const RECIPE_RUNTIME_DIR_ENV = `${RECIPE_ENV_PREFIX}RUNTIME_DIR`;
export const MCP_SESSION_DIR_ENV = `${RECIPE_ENV_PREFIX}MCP_SESSION_DIR`;

function defaultRecipeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_RECIPES_HOME ?? join(homedir(), ".pi", "recipes");
}

export function defaultRecipeRuntimeDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env[RECIPE_RUNTIME_DIR_ENV] ?? join(defaultRecipeHome(env), "runtime");
}

function sanitizeWorkspacePath(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "workspace";
}

export function workspaceRuntimeKey(workspaceDir: string): string {
  const resolved = resolve(workspaceDir);
  const slug = sanitizeWorkspacePath(resolved).slice(0, 96);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function workspaceRuntimeDir(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(defaultRecipeRuntimeDir(env), "workspaces", workspaceRuntimeKey(workspaceDir));
}

export function childAgentRunsDir(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(workspaceRuntimeDir(workspaceDir, env), "agents");
}

export function legacyChildAgentRunsDir(workspaceDir: string): string {
  return join(workspaceDir, ".pi", "agents");
}

export function ensureMcpSessionDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  const existing = env[MCP_SESSION_DIR_ENV];
  if (existing) return existing;
  return createMcpSessionDir(env);
}

export function createMcpSessionDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  const created = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-"));
  env[MCP_SESSION_DIR_ENV] = created;
  return created;
}

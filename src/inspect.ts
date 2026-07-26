import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRecipeAgentDefinitions } from "./recipe-agent.js";
import {
  generatedBindingEnvVars,
  placeholderEnvVars,
  recipeMcpLocalConfigPath,
  recipeMcpLocalExamplePath,
} from "./recipe-mcp-config.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
} from "./recipe-package.js";
import { expectedProviderEnvVars } from "./provider-env.js";

/**
 * What a recipe requires before it can run, derived entirely from the
 * package's existing declarations — no new manifest keys. Hosts and adapters
 * can use this for preflight checks and configuration UIs.
 */
export interface RecipeInspection {
  name: string;
  version: string;
  description?: string;
  agents: string[];
  providers: string[];
  credential_env: string[];
  mcp: { required: string[]; optional: string[] };
  mcp_env: string[];
  resources: {
    agents: number;
    skills: number;
    extensions: number;
    prompts: number;
  };
}

export function inspectRecipe(recipeDir: string): RecipeInspection {
  const dir = resolve(recipeDir);
  const manifest = readPiPackageManifest(dir);
  const definitions = loadRecipeAgentDefinitions(dir);
  const agents = [...new Set([...definitions.values()].map((a) => a.name))];

  const providers = [
    ...new Set(
      [...definitions.values()].flatMap((agent) => {
        const spec = agent.model?.name;
        const slash = spec?.indexOf("/") ?? -1;
        return spec && slash > 0 ? [spec.slice(0, slash)] : [];
      })
    ),
  ];
  const credentialEnv = [
    ...new Set(
      providers.flatMap((provider) =>
        expectedProviderEnvVars(
          provider === "gemini" ? "google" : provider
        )
      )
    ),
  ].sort();

  const required = manifest.mcp.servers
    .filter((server) => server.required)
    .map((server) => server.id);
  const optional = manifest.mcp.servers
    .filter((server) => !server.required)
    .map((server) => server.id);

  // Binding env vars: prefer the recipe's own binding file (or its example)
  // when present; otherwise the generated-binding convention per server.
  let mcpEnv: string[];
  const bindingSource = [
    recipeMcpLocalConfigPath(dir),
    recipeMcpLocalExamplePath(dir),
  ].find((path) => existsSync(path));
  if (bindingSource) {
    const content = readFileSync(bindingSource, "utf8");
    const parsed = JSON.parse(content) as {
      servers?: Array<{ oauthClientSecretEnv?: unknown }>;
    };
    mcpEnv = [
      ...new Set([
        ...placeholderEnvVars(content),
        ...(parsed.servers ?? []).flatMap((server) =>
          typeof server.oauthClientSecretEnv === "string" &&
          server.oauthClientSecretEnv
            ? [server.oauthClientSecretEnv]
            : []
        ),
      ]),
    ].sort();
  } else {
    mcpEnv = [
      ...new Set(
        manifest.mcp.servers.flatMap((server) =>
          generatedBindingEnvVars(server.id)
        )
      ),
    ].sort();
  }

  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    agents,
    providers,
    credential_env: credentialEnv,
    mcp: { required, optional },
    mcp_env: mcpEnv,
    resources: {
      agents: agents.length,
      skills: packageResourcePaths(manifest, "skills").length,
      extensions: packageResourcePaths(manifest, "extensions").length,
      prompts: packageResourcePaths(manifest, "prompts").length,
    },
  };
}

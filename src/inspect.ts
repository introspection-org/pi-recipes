import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRecipe } from "./recipe/resolve.js";
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
import type { RecipeAgentConfigField } from "./recipe-agent.js";
import type { ResolvedRecipe, ResolvedRecipeAgent } from "./recipe/resolve.js";

export interface RecipeAgentInspection {
  name: string;
  from?: string;
  declared_fields: RecipeAgentConfigField[];
  provenance: Partial<Record<RecipeAgentConfigField, string[]>>;
  model: {
    name: string;
    thinking_level?: string;
    config?: ResolvedRecipeAgent["modelConfig"];
  };
  prompt: {
    base: "SYSTEM.md" | "pi";
    agent_instructions?: {
      mode: "append" | "replace";
      source: string;
    };
  };
  tools: {
    authored: string[];
    root: string[];
    subagent: string[];
  };
  skills: string[];
  subagents: string[];
  mcp?: ResolvedRecipeAgent["mcp"];
}

/**
 * What a recipe requires before it can run, derived entirely from the
 * package's existing declarations — no new manifest keys. Hosts can use this
 * for preflight checks and configuration UIs.
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
  package_closure: {
    extensions: string[];
    prompts: string[];
  };
  resolved_agents: RecipeAgentInspection[];
  host_boundary: {
    interactive_pi_may_add_ambient_resources: true;
    embedded_host_overrides_are_not_recipe_source: true;
  };
}

function agentChain(
  recipe: ResolvedRecipe,
  agent: ResolvedRecipeAgent
): ResolvedRecipeAgent[] {
  const chain: ResolvedRecipeAgent[] = [];
  const seen = new Set<string>();
  let current: ResolvedRecipeAgent | undefined = agent;
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    chain.unshift(current);
    current = current.definition.from
      ? recipe.agents.get(current.definition.from)
      : undefined;
  }
  return chain;
}

function inspectAgent(
  recipe: ResolvedRecipe,
  agent: ResolvedRecipeAgent,
  hasSystemPrompt: boolean
): RecipeAgentInspection {
  const chain = agentChain(recipe, agent);
  const fields: RecipeAgentConfigField[] = [
    "description",
    "model",
    "tools",
    "mcp",
    "skills",
    "subagents",
    "system_instructions",
  ];
  const provenance = Object.fromEntries(
    fields.flatMap((field) => {
      const sources = chain
        .filter((entry) =>
          entry.definition.declaredFields?.includes(field)
        )
        .map((entry) => entry.name);
      return sources.length > 0 ? [[field, sources]] : [];
    })
  ) as Partial<Record<RecipeAgentConfigField, string[]>>;
  const instructionSource = provenance.system_instructions?.at(-1);
  const rootTools = [
    ...agent.tools,
    ...(agent.subagents.size > 0 ? ["agent"] : []),
  ];
  return {
    name: agent.name,
    ...(agent.definition.from ? { from: agent.definition.from } : {}),
    declared_fields: [...(agent.definition.declaredFields ?? [])],
    provenance,
    model: {
      name: agent.modelSpec,
      ...(agent.thinkingLevel
        ? { thinking_level: agent.thinkingLevel }
        : {}),
      ...(agent.modelConfig ? { config: agent.modelConfig } : {}),
    },
    prompt: {
      base: hasSystemPrompt ? "SYSTEM.md" : "pi",
      ...(agent.definition.systemInstructions && instructionSource
        ? {
            agent_instructions: {
              mode: agent.definition.systemInstructions.mode,
              source: instructionSource,
            },
          }
        : {}),
    },
    tools: {
      authored: [...agent.tools],
      root: rootTools,
      subagent: [...agent.tools],
    },
    skills: [...agent.skillPaths],
    subagents: [...agent.subagents.keys()],
    ...(agent.mcp ? { mcp: agent.mcp } : {}),
  };
}

export function inspectRecipe(recipeDir: string): RecipeInspection {
  const dir = resolve(recipeDir);
  const manifest = readPiPackageManifest(dir);
  const resolvedRecipe = resolveRecipe({ recipeDir: dir });
  const definitions = [...resolvedRecipe.agents.values()].map(
    (agent) => agent.definition
  );
  const agents = [...new Set(definitions.map((agent) => agent.name))];
  const uniqueResolvedAgents = [
    ...new Map(
      [...resolvedRecipe.agents.values()].map((agent) => [agent.name, agent])
    ).values(),
  ];
  const extensionPaths = packageResourcePaths(manifest, "extensions");
  const promptPaths = packageResourcePaths(manifest, "prompts");

  const providers = [
    ...new Set(
      definitions.flatMap((agent) => {
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
      extensions: extensionPaths.length,
      prompts: promptPaths.length,
    },
    package_closure: {
      extensions: extensionPaths,
      prompts: promptPaths,
    },
    resolved_agents: uniqueResolvedAgents.map((agent) =>
      inspectAgent(
        resolvedRecipe,
        agent,
        existsSync(resolve(dir, "SYSTEM.md"))
      )
    ),
    host_boundary: {
      interactive_pi_may_add_ambient_resources: true,
      embedded_host_overrides_are_not_recipe_source: true,
    },
  };
}

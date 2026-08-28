import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RECIPE_TOOL_SEARCH_NAME = "tool_search";

export interface RecipeToolActivation {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface RecipeToolSearchOptions {
  tools: readonly RecipeSearchableTool[];
  deferredToolNames: readonly string[];
  activation: RecipeToolActivation;
}

export interface RecipeSearchableTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
}

interface ScoredTool {
  tool: RecipeSearchableTool;
  score: number;
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function scoreTool(tool: RecipeSearchableTool, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const name = tool.name.toLowerCase();
  const label = (tool.label ?? tool.name).toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  if (name === normalizedQuery) score += 500;
  if (label === normalizedQuery) score += 300;
  if (name.includes(normalizedQuery)) score += 120;
  if (label.includes(normalizedQuery)) score += 100;
  if (description.includes(normalizedQuery)) score += 60;

  const nameTerms = new Set(words(name));
  const labelTerms = new Set(words(label));
  for (const term of words(normalizedQuery)) {
    if (nameTerms.has(term)) score += 40;
    else if (name.includes(term)) score += 20;
    if (labelTerms.has(term)) score += 30;
    else if (label.includes(term)) score += 15;
    if (description.includes(term)) score += 16;
  }
  return score;
}

export function createRecipeToolSearch(
  options: RecipeToolSearchOptions
): ToolDefinition | undefined {
  const toolsByName = new Map(
    options.tools.map((tool) => [tool.name, tool] as const)
  );
  const deferred = [...new Set(options.deferredToolNames)].map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(
        `Recipe deferred tool '${name}' was not registered before tool search`
      );
    }
    return tool;
  });
  if (deferred.length === 0) return undefined;
  if (toolsByName.has(RECIPE_TOOL_SEARCH_NAME)) {
    throw new Error(
      `Recipe tool name '${RECIPE_TOOL_SEARCH_NAME}' is reserved by the session`
    );
  }

  return {
    name: RECIPE_TOOL_SEARCH_NAME,
    label: "Tool search",
    description:
      "Search inactive tools allowed for this Recipe and enable the best matches for the next model request.",
    parameters: Type.Object({
      query: Type.String({
        description: "Capability or task to find a tool for.",
      }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, default: 3 })
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const input = params as { query?: unknown; limit?: unknown };
      const query = typeof input.query === "string" ? input.query : "";
      const limit = typeof input.limit === "number" ? input.limit : 3;
      const active = new Set(options.activation.getActiveTools());
      const matches = deferred
        .filter((tool) => !active.has(tool.name))
        .map((tool): ScoredTool => ({ tool, score: scoreTool(tool, query) }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.tool.name.localeCompare(right.tool.name)
        )
        .slice(0, limit);
      const added = matches.map((match) => match.tool.name);
      if (added.length > 0) {
        options.activation.setActiveTools([...active, ...added]);
      }
      const details = {
        matches: matches.map(({ tool }) => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
        })),
        added,
      };
      const text =
        matches.length === 0
          ? `No inactive Recipe tools matched "${query}".`
          : [
              `Enabled ${matches.length} Recipe tool(s) for the next model request:`,
              ...matches.map(
                ({ tool }) =>
                  `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`
              ),
            ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  };
}

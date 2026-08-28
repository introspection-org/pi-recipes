export interface RecipeConnectorToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly defaultActive: boolean;
}

export interface RecipeConnectorDefinition {
  readonly provider: string;
  readonly packageName: string;
  readonly tools: readonly RecipeConnectorToolDefinition[];
  readonly loadToolName?: string;
}

export interface RecipeConnectorToolReference {
  readonly provider: string;
  readonly id?: string;
  readonly name: string;
  readonly defaultActive: boolean;
}

const slackToolIds = [
  "origin",
  "send_message",
  "react",
  "read_thread",
  "read_history",
  "list_channels",
  "join_channel",
  "resolve_user",
  "get_permalink",
  "download_file",
] as const;

const slackDefaultToolIds = new Set<string>([
  "origin",
  "read_thread",
  "send_message",
]);

export const RECIPE_CONNECTOR_DEFINITIONS: readonly RecipeConnectorDefinition[] = [
  {
    provider: "slack",
    packageName: "@introspection-ai/recipe-connector-slack",
    tools: slackToolIds.map((id) => ({
      id,
      name: `slack_${id}`,
      defaultActive: slackDefaultToolIds.has(id),
    })),
    loadToolName: "slack_load_tools",
  },
];

const definitionsByProvider = new Map(
  RECIPE_CONNECTOR_DEFINITIONS.map((definition) => [
    definition.provider,
    definition,
  ])
);

const toolsByName = new Map<string, RecipeConnectorToolReference>();
for (const definition of RECIPE_CONNECTOR_DEFINITIONS) {
  for (const tool of definition.tools) {
    toolsByName.set(tool.name, { provider: definition.provider, ...tool });
  }
  if (definition.loadToolName) {
    toolsByName.set(definition.loadToolName, {
      provider: definition.provider,
      name: definition.loadToolName,
      defaultActive: false,
    });
  }
}

export function recipeConnectorDefinition(
  provider: string
): RecipeConnectorDefinition | undefined {
  return definitionsByProvider.get(provider);
}

export function recipeConnectorToolDefinition(name: string) {
  return toolsByName.get(name);
}

import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadRecipeAgentDefinitions } from "./recipe-agent.js";

const RunRecipeAgentParams = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("interrupt"),
      Type.Literal("close"),
    ], {
      description:
        "Child-run action. Omit or use start to launch a new recipe agent run.",
    })
  ),
  id: Type.Optional(
    Type.String({ description: "Recipe agent run id for status, wait, interrupt, or close." })
  ),
  name: Type.Optional(Type.String({ description: "Name of the recipe agent to run." })),
  task: Type.Optional(Type.String({ description: "Task or question for the recipe agent." })),
  label: Type.Optional(Type.String({ description: "Short label for this delegated run." })),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "On start, wait for this child run to finish before returning. Defaults to false so multiple agents can run in parallel.",
    })
  ),
});

type RunRecipeAgentParams = Static<typeof RunRecipeAgentParams>;

export type RecipeAgentAction = "start" | "status" | "wait" | "interrupt" | "close";

export interface RecipeAgentRunRequest {
  action: RecipeAgentAction;
  id?: string;
  name?: string;
  task?: string;
  label?: string;
  wait?: boolean;
}

export interface RecipeAgentRunResult {
  output: string;
  details?: Record<string, unknown>;
}

export interface RecipeAgentsExtensionOptions {
  recipeDir: string;
  parentAgentName: string;
  runAgent(request: RecipeAgentRunRequest): Promise<RecipeAgentRunResult>;
}

function textResult(text: string, details: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    details,
  };
}

export function createRecipeAgentsExtension(
  opts: RecipeAgentsExtensionOptions
): ExtensionFactory {
  return (pi) => {
    const definitions = loadRecipeAgentDefinitions(opts.recipeDir);
    const parent = definitions.get(opts.parentAgentName);
    const visibleNames = parent?.subagents.length
      ? parent.subagents
      : [...new Set([...definitions.values()].map((agent) => agent.name))].filter(
          (name) => name !== opts.parentAgentName
        );
    const visible = visibleNames
      .map((name) => definitions.get(name))
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));

    if (visible.length === 0) return;

    const agentList = visible
      .map((agent) => `- ${agent.name}${agent.description ? `: ${agent.description}` : ""}`)
      .join("\n");

    pi.registerTool(
      defineTool({
        name: "agent",
        label: "Recipe agent",
        description: [
          "Start or manage another agent from this recipe.",
          "Starts run in the background by default so you can launch several agents in parallel.",
          "Use wait=true on start, or action=wait with an id, when you need the child result before answering.",
          "Use action=status to inspect retained child runs.",
          "Available recipe agents:",
          agentList,
        ].join("\n"),
        parameters: RunRecipeAgentParams,
        async execute(_runId, params: RunRecipeAgentParams) {
          const action = params.action ?? "start";
          if (action !== "start") {
            const result = await opts.runAgent({
              action,
              id: params.id,
            });
            return textResult(result.output, result.details ?? { action, id: params.id });
          }

          if (!params.name || !params.task) {
            return {
              ...textResult("Starting a recipe agent requires both name and task.", {
                action,
                available_agents: visible.map((item) => item.name),
              }),
              isError: true,
            };
          }

          const agent = definitions.get(params.name);
          if (!agent || !visible.some((item) => item.name === agent.name)) {
            return {
              ...textResult(
                `Unknown or unavailable recipe agent: ${params.name}. Available agents: ${visible.map((item) => item.name).join(", ")}`,
                { agent: params.name, available_agents: visible.map((item) => item.name) }
              ),
              isError: true,
            };
          }

          const result = await opts.runAgent({
            action,
            name: agent.name,
            task: params.task,
            label: params.label,
            wait: params.wait,
          });
          return textResult(result.output, result.details ?? {
            agent: agent.name,
            label: params.label ?? agent.name,
          });
        },
      })
    );
  };
}

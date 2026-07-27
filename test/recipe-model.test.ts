import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadValidatedRecipeAgentDefinitions,
  validateRecipeAgentDefinitions,
} from "../src/recipe-agent.js";
import {
  applyRecipeAgentModelConfigToModel,
  cloneModelForRecipe,
  mergeRecipeAgentModelConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
} from "../src/recipe-model.js";

describe("parseRecipeAgentModelConfig", () => {
  it("parses the full model block", () => {
    const config = parseRecipeAgentModelConfig("test", {
      name: "anthropic/claude-fable-5",
      thinking_level: "high",
      temperature: 0.4,
      max_tokens: 4096,
      cache_retention: "long",
      timeout_ms: 30000,
      max_retries: 3,
      max_retry_delay_ms: 10000,
      providers: {
        openrouter: { routing: { sort: "throughput", zdr: true } },
        anthropic: { betas: ["context-1m-2025-08-07"] },
      },
    });

    expect(config).toEqual({
      name: "anthropic/claude-fable-5",
      thinkingLevel: "high",
      streamOptions: {
        temperature: 0.4,
        maxTokens: 4096,
        cacheRetention: "long",
        timeoutMs: 30000,
        maxRetries: 3,
        maxRetryDelayMs: 10000,
      },
      openrouter: { sort: "throughput", zdr: true },
      anthropic: { betas: ["context-1m-2025-08-07"] },
    });
  });

  it("rejects non-canonical thinking-level aliases", () => {
    expect(() =>
      parseRecipeAgentModelConfig("test", { thinkingLevel: "low" })
    ).toThrow(/unsupported model key/);
    expect(() =>
      parseRecipeAgentModelConfig("test", { reasoning_effort: "high" })
    ).toThrow(/unsupported model key/);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => parseRecipeAgentModelConfig("test", { cache_rention: "long" })).toThrow(
      RecipeModelConfigError
    );
    expect(() => parseRecipeAgentModelConfig("test", { temperature: "hot" })).toThrow(
      /temperature/
    );
    expect(() => parseRecipeAgentModelConfig("test", "gpt")).toThrow(/expected object/);
  });

  it("returns undefined for an absent block", () => {
    expect(parseRecipeAgentModelConfig("test", undefined)).toBeUndefined();
  });
});

describe("mergeRecipeAgentModelConfig", () => {
  it("resets inherited tuning when model identity changes", () => {
    const merged = mergeRecipeAgentModelConfig(
      {
        name: "openai/gpt-5.5",
        streamOptions: { temperature: 0.2, maxTokens: 1024 },
        anthropic: { betas: ["a"] },
      },
      {
        name: "anthropic/claude-fable-5",
        streamOptions: { temperature: 0.7 },
        openrouter: { sort: "price" },
      }
    );

    expect(merged).toEqual({
      name: "anthropic/claude-fable-5",
      streamOptions: { temperature: 0.7 },
      openrouter: { sort: "price" },
    });
  });

  it("merges sections when the child omits model identity", () => {
    expect(
      mergeRecipeAgentModelConfig(
        {
          name: "anthropic/claude-fable-5",
          streamOptions: { temperature: 0.2, maxTokens: 1024 },
        },
        { streamOptions: { temperature: 0.7 } }
      )
    ).toEqual({
      name: "anthropic/claude-fable-5",
      streamOptions: { temperature: 0.7, maxTokens: 1024 },
    });
  });

  it("passes through one-sided configs", () => {
    const only = { name: "openai/gpt-5.5" };
    expect(mergeRecipeAgentModelConfig(only, undefined)).toBe(only);
    expect(mergeRecipeAgentModelConfig(undefined, only)).toBe(only);
  });
});

describe("applyRecipeAgentModelConfigToModel", () => {
  it("applies configuration to a session-local model clone", () => {
    const shared = {
      provider: "anthropic",
      id: "claude",
      headers: { existing: "yes" },
      compat: { supportsStore: true },
    } as any;
    const local = cloneModelForRecipe(shared);
    applyRecipeAgentModelConfigToModel(local, {
      anthropic: { betas: ["context-1m"] },
    });

    expect(local).not.toBe(shared);
    expect(local.headers).not.toBe(shared.headers);
    expect(shared.headers).toEqual({ existing: "yes" });
    expect(shared.compat).toEqual({ supportsStore: true });
  });

  it("applies routing and merges anthropic beta headers", () => {
    const model = {
      headers: { "anthropic-beta": "existing" },
    } as never;
    const applied = applyRecipeAgentModelConfigToModel(model, {
      openrouter: { sort: "throughput" },
      anthropic: { betas: ["new-beta"] },
    }) as { compat?: Record<string, unknown>; headers?: Record<string, string> };

    expect(applied.compat?.openRouterRouting).toEqual({ sort: "throughput" });
    expect(applied.headers?.["anthropic-beta"]).toBe("existing,new-beta");
  });
});

describe("recipe agent model config loading", () => {
  let recipeDir: string;

  beforeEach(() => {
    recipeDir = mkdtempSync(join(tmpdir(), "recipes-model-"));
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "model-recipe", version: "0.0.1", pi: { agents: ["agents/*.yaml"] } })
    );
    mkdirSync(join(recipeDir, "agents"));
  });

  afterEach(() => {
    rmSync(recipeDir, { recursive: true, force: true });
  });

  it("starts fresh model config when identity changes across the from chain", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "description: base",
        "model:",
        "  name: openai/gpt-5.5",
        "  temperature: 0.2",
        "  providers:",
        "    anthropic:",
        "      betas: [interleaved-thinking]",
      ].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "sweep.yaml"),
      [
        "name: sweep",
        "from: agent",
        "description: sweep",
        "model:",
        "  name: anthropic/claude-fable-5",
        "  thinking_level: high",
      ].join("\n")
    );

    const definitions = loadValidatedRecipeAgentDefinitions(recipeDir).definitions;
    const sweep = definitions.get("sweep");

    expect(sweep?.model).toEqual({ name: "anthropic/claude-fable-5", thinkingLevel: "high" });
    expect(sweep?.modelConfig).toEqual({
      name: "anthropic/claude-fable-5",
      thinkingLevel: "high",
    });
  });

  it("accepts the minimal explicitly named agent", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: openai/gpt-5.5\n"
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([]);
    expect(
      loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get("agent")
    ).toMatchObject({
      name: "agent",
      tools: [],
      skills: [],
      subagents: [],
    });
  });

  it.each(["append", "replace"] as const)(
    "accepts explicitly blank %s system instructions",
    (mode) => {
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-5.5",
          "system_instructions:",
          `  mode: ${mode}`,
          "  content: '   '",
        ].join("\n")
      );

      expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([]);
      expect(
        loadValidatedRecipeAgentDefinitions(recipeDir).definitions.get("agent")
          ?.systemInstructions
      ).toEqual({ mode, content: "" });
    }
  );

  it("rejects legacy agent instruction keys", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "model:",
        "  name: openai/gpt-5.5",
        "systemInstructions:",
        "  content: legacy",
        "prompt: legacy",
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({
        agentName: "agent",
        field: "file",
        message: expect.stringMatching(/unsupported key\(s\): .*prompt.*systemInstructions|unsupported key\(s\): .*systemInstructions.*prompt/),
      }),
    ]);
  });

  it.each([
    ["name", "name: 42"],
    ["from", "from: []"],
    ["description", "description: {}"],
    ["tools", "tools: [read, 42]"],
    ["skills", "skills: missing"],
    ["subagents", "subagents: ['']"],
    ["extensions", "extensions:\n  include: [42]"],
    [
      "system instructions",
      "system_instructions:\n  mode: invalid\n  content: Test",
    ],
  ])("rejects malformed present %s fields", (_label, fieldYaml) => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        ...(_label === "name" ? [] : ["name: agent"]),
        "model:",
        "  name: openai/gpt-5.5",
        fieldYaml,
      ].join("\n")
    );

    expect(validateRecipeAgentDefinitions(recipeDir)).toEqual([
      expect.objectContaining({
        agentName: "agent",
        field: "file",
      }),
    ]);
  });

  it("excludes invalid files from the parsed graph and returns their diagnostics", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      ["name: agent", "description: ok", "model:", "  name: openai/gpt-5.5"].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "broken.yaml"),
      ["name: broken", "description: bad", "model:", "  temprature: 1"].join("\n")
    );

    const result = loadValidatedRecipeAgentDefinitions(recipeDir);
    const definitions = result.definitions;

    expect(definitions.has("agent")).toBe(true);
    expect(definitions.has("broken")).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.field === "file" && finding.agentName === "broken"
      )
    ).toBe(true);
  });
});

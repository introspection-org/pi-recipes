import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecipeAgentDefinitions, validateRecipeAgentDefinitions } from "../src/recipe-agent.js";
import {
  applyRecipeAgentModelConfigToModel,
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

  it("accepts thinkingLevel camelCase and reasoning_effort alias", () => {
    expect(parseRecipeAgentModelConfig("test", { thinkingLevel: "low" })).toEqual({
      thinkingLevel: "low",
    });
    expect(parseRecipeAgentModelConfig("test", { reasoning_effort: "high" })).toEqual({
      thinkingLevel: "high",
    });
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => parseRecipeAgentModelConfig("test", { cache_rention: "long" })).toThrow(
      RecipeModelConfigError
    );
    expect(() => parseRecipeAgentModelConfig("test", { temperature: "hot" })).toThrow(
      /temperature/
    );
    expect(() =>
      parseRecipeAgentModelConfig("test", { thinking_level: "low", reasoning_effort: "high" })
    ).toThrow(/different values/);
    expect(() => parseRecipeAgentModelConfig("test", "gpt")).toThrow(/expected object/);
  });

  it("returns undefined for an absent block", () => {
    expect(parseRecipeAgentModelConfig("test", undefined)).toBeUndefined();
  });
});

describe("mergeRecipeAgentModelConfig", () => {
  it("merges sections by key with the overlay winning", () => {
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
      streamOptions: { temperature: 0.7, maxTokens: 1024 },
      anthropic: { betas: ["a"] },
      openrouter: { sort: "price" },
    });
  });

  it("passes through one-sided configs", () => {
    const only = { name: "openai/gpt-5.5" };
    expect(mergeRecipeAgentModelConfig(only, undefined)).toBe(only);
    expect(mergeRecipeAgentModelConfig(undefined, only)).toBe(only);
  });
});

describe("applyRecipeAgentModelConfigToModel", () => {
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
    recipeDir = mkdtempSync(join(tmpdir(), "pi-recipes-model-"));
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "model-recipe", version: "0.0.1", pi: { agents: ["agents/*.yaml"] } })
    );
    mkdirSync(join(recipeDir, "agents"));
  });

  afterEach(() => {
    rmSync(recipeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("carries the merged model config across the from chain", () => {
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
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
        "from: agent",
        "description: sweep",
        "model:",
        "  name: anthropic/claude-fable-5",
        "  thinking_level: high",
      ].join("\n")
    );

    const definitions = loadRecipeAgentDefinitions(recipeDir);
    const sweep = definitions.get("sweep");

    expect(sweep?.model).toEqual({ name: "anthropic/claude-fable-5", thinkingLevel: "high" });
    expect(sweep?.modelConfig).toEqual({
      name: "anthropic/claude-fable-5",
      thinkingLevel: "high",
      streamOptions: { temperature: 0.2 },
      anthropic: { betas: ["interleaved-thinking"] },
    });
  });

  it("skips files with invalid model config and surfaces a validation finding", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      ["description: ok", "model:", "  name: openai/gpt-5.5"].join("\n")
    );
    writeFileSync(
      join(recipeDir, "agents", "broken.yaml"),
      ["description: bad", "model:", "  temprature: 1"].join("\n")
    );

    const definitions = loadRecipeAgentDefinitions(recipeDir);

    expect(definitions.has("agent")).toBe(true);
    expect(definitions.has("broken")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken.yaml"));

    const findings = validateRecipeAgentDefinitions(recipeDir);
    expect(
      findings.some((finding) => finding.field === "file" && finding.agentName === "broken")
    ).toBe(true);
  });
});

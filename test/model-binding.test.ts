import { describe, expect, it } from "vitest";
import { resolveRecipeCredentials } from "../src/model-binding.js";

describe("resolveRecipeCredentials", () => {
  it("applies nullable Pi 0.84 auth headers without leaking nulls to models", async () => {
    const model = {
      provider: "test",
      id: "model",
      headers: { existing: "keep", removed: "old" },
    } as any;
    const modelRegistry = {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "secret",
        env: {},
        headers: { added: "new", removed: null },
      }),
    } as any;

    await resolveRecipeCredentials({
      provider: "test",
      env: {},
      model,
      modelRegistry,
    });

    expect(model.headers).toEqual({ existing: "keep", added: "new" });
  });
});

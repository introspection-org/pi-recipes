import { describe, it } from "vitest";
import { createAgentSessionFromRecipe } from "../src/session.js";
import { hostConformanceCases } from "../src/test-utils.js";

// Recipes runs its own conformance suite so the public cases cannot drift
// from createAgentSessionFromRecipe.
describe("host conformance: createAgentSessionFromRecipe", () => {
  for (const conformanceCase of hostConformanceCases({
    createSession: (options) => createAgentSessionFromRecipe(options),
  })) {
    it(conformanceCase.name, conformanceCase.run, 30_000);
  }
});

import { describe, it } from "vitest";
import { createRecipeSession } from "../src/session.js";
import { hostConformanceCases } from "../src/test-utils.js";

// Recipes runs its own conformance suite so the public cases cannot drift
// from createRecipeSession.
describe("host conformance: createRecipeSession", () => {
  for (const conformanceCase of hostConformanceCases({
    createSession: (options) => createRecipeSession(options),
  })) {
    it(conformanceCase.name, conformanceCase.run, 30_000);
  }
});

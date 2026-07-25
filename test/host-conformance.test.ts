import { describe, it } from "vitest";
import { createRecipeSession } from "../src/session.js";
import { hostConformanceCases } from "../src/test-utils.js";

// The first-party engine runs its own conformance suite, so the suite can
// never drift from the engine it specifies.
describe("host conformance: first-party engine", () => {
  for (const conformanceCase of hostConformanceCases({
    createSession: (options) => createRecipeSession(options),
  })) {
    it(conformanceCase.name, conformanceCase.run, 30_000);
  }
});

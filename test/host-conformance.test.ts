import { describe, it } from "vitest";
import { createAgentSession } from "../src/session.js";
import { hostConformanceCases } from "../src/test-utils.js";

// Recipes runs its own conformance suite so the public cases cannot drift
// from createAgentSession. The suite hands one flat options bag to the host;
// the constructor reads the package from it and the injections from it, so
// the same object serves as both arguments.
describe("host conformance: createAgentSession", () => {
  for (const conformanceCase of hostConformanceCases({
    createSession: (options) => createAgentSession(options, options),
  })) {
    it(conformanceCase.name, conformanceCase.run, 30_000);
  }
});

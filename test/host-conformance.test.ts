import { describe, it } from "vitest";
import { createAgentSession } from "../src/session.js";
import { hostConformanceCases } from "../src/test-utils.js";

// Recipes runs its own conformance suite so the public cases cannot drift
// from createAgentSession.
describe("host conformance: createAgentSession", () => {
  for (const conformanceCase of hostConformanceCases({
    createSession: createAgentSession,
  })) {
    it(conformanceCase.name, conformanceCase.run, 30_000);
  }
});

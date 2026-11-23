import { assert, it } from "@effect/vitest";

import { messageAnswerText } from "./Orchestrator.ts";

it("turns typed, single and multi-choice answers into reply text", () => {
  assert.equal(messageAnswerText("  Install now  "), "Install now");
  assert.equal(messageAnswerText(["Only one"]), "Only one");
  assert.equal(messageAnswerText(["A, with a comma", " B ", "", 3]), "- A, with a comma\n- B");
  assert.equal(messageAnswerText([]), "");
  assert.equal(messageAnswerText(undefined), "");
  assert.equal(messageAnswerText({ q: "x" }), "");
});

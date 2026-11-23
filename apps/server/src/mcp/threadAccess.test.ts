import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertTargetWithinLimits } from "./threadAccess.ts";

it.effect("identifies the target and caller ceiling when a thread write is refused", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:above-caller");
    for (const [runtimeMode, interactionMode, code] of [
      ["approval-required", "default", "runtime_mode_escalation_denied"],
      ["full-access", "plan", "interaction_mode_escalation_denied"],
      ["approval-required", "plan", "runtime_mode_escalation_denied"],
    ] as const) {
      const target = liveThreadShell(threadId, { runtimeMode: "full-access" });
      const error = yield* assertTargetWithinLimits({ runtimeMode, interactionMode }, target).pipe(
        Effect.flip,
      );

      expect(error.code).toBe(code);
      expect(error.message).toContain(threadId);
      expect(error.message).toContain("full-access/default");
      expect(error.message).toContain(`${runtimeMode}/${interactionMode}`);
      expect(error.message).not.toMatch(/child|parent mode/i);
    }
  }),
);

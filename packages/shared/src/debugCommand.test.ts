import { ComposerContextId, type OrchestrationMessageContext } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { expandDebugCommand } from "./debugCommand.ts";
import {
  collectComposerContextReferences,
  plainContextText,
  projectComposerContextForProvider,
} from "./composerContextReferences.ts";

it("keeps only the user's text and a Debug chip in the message, expanding the workflow only for the provider", () => {
  const expanded = expandDebugCommand("  /debug stale phone\nmissed event");
  expect(plainContextText(expanded.text)).toBe("Debug stale phone missed event");
  expect(expanded.context?.records).toEqual([
    { version: 1, kind: "debug", contextId: "debug_workflow", label: "Debug" },
  ]);
  expect(expanded.text).not.toContain("Debug workflow:");
  expect(JSON.stringify(expanded.context)).not.toContain("hypotheses");
  const projected = projectComposerContextForProvider({
    text: expanded.text,
    records: expanded.context?.records ?? [],
  });
  for (const step of [
    "hypotheses",
    "debug_log",
    "preview browser console",
    "sshcode-debug",
    "ask_user",
    "Reproduce it now, then pick Done",
    "important=true",
    "read the events",
    "Verify",
    "Remove all instrumentation",
    "grep",
  ])
    expect(projected).toContain(step);
  expect(expandDebugCommand(expanded.text, expanded.context)).toEqual(expanded);
  for (const plain of [
    "/debugger bug",
    "please /debug bug",
    "```\n/debug bug\n```",
    "normal message",
  ])
    expect(expandDebugCommand(plain)).toEqual({ text: plain, context: undefined });
});

it("preserves other records and avoids id collisions and duplicate debug references", () => {
  const context: OrchestrationMessageContext = {
    version: 1,
    records: [
      {
        version: 1,
        kind: "mention",
        contextId: ComposerContextId.make("debug_workflow"),
        label: "index.ts",
        path: "index.ts",
      },
    ],
  };
  const expanded = expandDebugCommand("/debug missed event", context);
  expect(expanded.context?.records[0]).toEqual(context.records[0]);
  expect(collectComposerContextReferences(expanded.text)[0]?.contextId).toBe("debug_workflow_1");
  const repeated = expandDebugCommand(`/debug ${expanded.text}`, expanded.context);
  expect(repeated).toEqual(expanded);
});

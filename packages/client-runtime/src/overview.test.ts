import {
  EnvironmentId,
  ComposerContextId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  currentOverviewThread,
  makeOverviewThreadId,
  overviewEntries,
  overviewIsWorking,
  overviewMessageText,
  overviewModelSelection,
  OVERVIEW_MODEL_SELECTION,
} from "./overview.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function message(
  id: string,
  role: OrchestrationV2ConversationMessage["role"],
  text: string,
  runId: string | null,
  streaming = false,
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId: ThreadId.make("overview-1"),
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming,
    createdBy: "user",
    creationSource: "web",
    createdAt: at("2026-10-18T10:00:00.000Z"),
    updatedAt: at("2026-10-18T10:00:00.000Z"),
  };
}

describe("Overview", () => {
  it("continues the newest Overview conversation that is still around", () => {
    const older = {
      ...v2ThreadShell,
      id: makeOverviewThreadId("a"),
      createdAt: at("2026-10-18T09:00:00.000Z"),
    };
    const newer = {
      ...older,
      id: makeOverviewThreadId("b"),
      createdAt: at("2026-10-18T10:00:00.000Z"),
    };
    const deleted = {
      ...older,
      id: makeOverviewThreadId("c"),
      createdAt: at("2026-10-18T11:00:00.000Z"),
      deletedAt: at("2026-10-18T11:30:00.000Z"),
    };
    const chat = { ...v2ThreadShell, createdAt: at("2026-10-18T12:00:00.000Z") };
    expect(currentOverviewThread([older, chat, newer, deleted])?.id).toBe("overview-b");
    expect(currentOverviewThread([chat])).toBeNull();
  });

  it("shows each question and only the latest words of each answer", () => {
    const entries = overviewEntries({
      messages: [
        message("m1", "user", "What's going on?", "run-1"),
        message("m2", "assistant", "Let me look at that chat.", "run-1"),
        message("m3", "assistant", "Two chats are working.", "run-1"),
        message("m4", "system", "internal", "run-1"),
        message("m5", "user", "Anything need me?", "run-2"),
        message("m6", "assistant", "No", "run-2", true),
      ],
    });
    expect(entries).toEqual([
      { id: "m1", role: "user", text: "What's going on?", streaming: false },
      { id: "m3", role: "assistant", text: "Two chats are working.", streaming: false },
      { id: "m5", role: "user", text: "Anything need me?", streaming: false },
      { id: "m6", role: "assistant", text: "No", streaming: true },
    ]);
  });

  it("is working while any run is active", () => {
    const run = (status: OrchestrationV2Run["status"]) => ({ status }) as OrchestrationV2Run;
    expect(overviewIsWorking({ runs: [run("completed"), run("running")] })).toBe(true);
    expect(overviewIsWorking({ runs: [run("completed"), run("failed")] })).toBe(false);
  });
});

it("displays structured chat mentions as openable thread links on every Overview client", () => {
  const context = {
    version: 1 as const,
    records: [
      {
        version: 1 as const,
        kind: "thread" as const,
        contextId: ComposerContextId.make("thread_abc"),
        label: "Fix login flow",
        title: "Fix login flow",
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("abc"),
      },
    ],
  };
  const text = "How is [Fix login flow](t3-context://v1/thread/thread_abc) going?";
  expect(overviewMessageText(text, context)).toBe(
    "How is [Fix login flow](t3-thread://v1/abc) going?",
  );
  expect(overviewMessageText(text)).toBe(text);
  const entry = overviewEntries({
    messages: [{ ...message("m1", "user", text, "r1"), context }],
  })[0];
  expect(entry?.text).toBe("How is [Fix login flow](t3-thread://v1/abc) going?");
});

describe("overviewModelSelection", () => {
  const ready = (instanceId: string, driver: string, slugs: ReadonlyArray<string>) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }) as unknown as ServerProvider;

  it("runs on Claude Haiku when Claude has it, else a ready provider's cheap default", () => {
    expect(
      overviewModelSelection([ready("claudeAgent", "claudeAgent", ["claude-haiku-5-5"])]),
    ).toEqual(OVERVIEW_MODEL_SELECTION);
    expect(overviewModelSelection([ready("grok", "grok", ["grok-build", "grok-fast"])])).toEqual({
      instanceId: "grok",
      model: "grok-build",
    });
    expect(overviewModelSelection(null)).toEqual(OVERVIEW_MODEL_SELECTION);
  });
});

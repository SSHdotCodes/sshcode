import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ThreadFeedMessage } from "../../lib/threadActivity";
import {
  canForkMessage,
  editMessageConfirmationText,
  editMessageTarget,
  forkMessageInput,
  mergeRewoundPrompt,
  revertMessageInput,
  rollbackSettled,
} from "./messageWorkflows";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("source");
const runId = RunId.make("run");
const messageId = MessageId.make("prompt");
const commandId = CommandId.make("command");
const message = {
  id: messageId,
  role: "user",
  text: "hello",
  attachments: [],
  runId,
  inputIntent: "turn_start",
  visibility: "local",
  sourceThreadId: threadId,
} as unknown as ThreadFeedMessage;
const projection = {
  thread: {},
  runs: [{ id: runId, ordinal: 1, status: "completed" }],
  checkpoints: [
    { id: "start", status: "ready", ordinalWithinScope: 0, appRunOrdinal: null },
    { id: "end", runId, status: "ready", appRunOrdinal: 1, files: [] },
  ],
  turnItems: [],
  visibleTurnItems: [],
  providerThreads: [],
  providerSessions: [],
} as unknown as OrchestrationV2ThreadProjection;
const input = {
  message,
  projection,
  threadId,
  canOperate: true,
  supportsRollback: true,
  active: false,
};

describe("message workflow availability", () => {
  it("offers editing only with a usable source and target checkpoint", () => {
    expect(editMessageTarget(input)).toEqual({
      turnCount: 0,
      canRestoreFiles: true,
      stoppedLatestRun: false,
      startsNewSession: false,
      skipConfirmation: false,
    });
    expect(
      editMessageTarget({ ...input, projection: { ...projection, checkpoints: [] } }),
    ).toBeNull();
    expect(
      editMessageTarget({
        ...input,
        projection: {
          ...projection,
          checkpoints: projection.checkpoints.map((checkpoint) =>
            checkpoint.id === "start" ? { ...checkpoint, status: "stale" as const } : checkpoint,
          ),
        },
      }),
    ).toBeNull();
  });
  it("says the agent forgets the chat when its rewind starts a new session", () => {
    const plan = {
      turnCount: 0,
      canRestoreFiles: true,
      stoppedLatestRun: false,
      startsNewSession: false,
      skipConfirmation: false,
    };
    const notice =
      "This agent cannot rewind a chat: it starts a new session and forgets the earlier conversation.";
    expect(editMessageConfirmationText(plan)).not.toContain(notice);
    expect(editMessageConfirmationText({ ...plan, canRestoreFiles: false })).toBe(
      "Remove this message and everything after it, and put it back in the composer to edit? Files are left as they are.",
    );
    for (const canRestoreFiles of [true, false]) {
      expect(
        editMessageConfirmationText({ ...plan, canRestoreFiles, startsNewSession: true }),
      ).toBe(`${editMessageConfirmationText({ ...plan, canRestoreFiles })} ${notice}`);
    }
  });
  it("only offers a completed, supported assistant reply as a fork", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId, status: "completed" },
    } as never;
    const fork = {
      projectedItem,
      capabilities: undefined,
      runStatus: "completed" as const,
      canOperate: true,
    };
    expect(canForkMessage(fork)).toBe(true);
    expect(canForkMessage({ ...fork, runStatus: "running" })).toBe(false);
    expect(canForkMessage({ ...fork, canOperate: false })).toBe(false);
    expect(
      canForkMessage({
        ...fork,
        capabilities: {
          threads: { canForkThread: false, canForkFromTurn: false },
          identity: { nativeThreadIds: "none" },
          context: { supportsFullThreadHandoff: false },
        } as never,
      }),
    ).toBe(false);
  });
  it("keeps prompts with attachments and context eligible for restoration", () => {
    expect(
      editMessageTarget({
        ...input,
        message: {
          ...message,
          attachments: [{ type: "image" } as never],
          context: { version: 1, records: [{} as never] },
        },
      }),
    ).toMatchObject({ turnCount: 0 });
  });
  it("offers a conversation-only edit when the folder has no git checkpoints", () => {
    const missing = {
      ...projection,
      checkpoints: projection.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        status: "missing" as const,
      })),
    };
    expect(editMessageTarget({ ...input, projection: missing })).toEqual({
      turnCount: 0,
      canRestoreFiles: false,
      stoppedLatestRun: false,
      startsNewSession: false,
      skipConfirmation: false,
    });
    // Stopped right away with nothing on disk changed: one tap, pencil shown.
    expect(
      editMessageTarget({
        ...input,
        projection: {
          ...missing,
          runs: [{ ...projection.runs[0]!, status: "interrupted" }],
        },
      }),
    ).toEqual({
      turnCount: 0,
      canRestoreFiles: false,
      stoppedLatestRun: true,
      startsNewSession: false,
      skipConfirmation: true,
    });
  });
  it("blocks active runs, disconnected clients, unsupported providers, and inherited messages", () => {
    expect(editMessageTarget({ ...input, active: true })).toBeNull();
    expect(editMessageTarget({ ...input, canOperate: false })).toBeNull();
    expect(editMessageTarget({ ...input, supportsRollback: false })).toBeNull();
    expect(
      editMessageTarget({ ...input, message: { ...message, visibility: "inherited" } }),
    ).toBeNull();
    expect(
      editMessageTarget({
        ...input,
        projection: {
          ...projection,
          runs: [
            ...projection.runs,
            { ...projection.runs[0]!, id: RunId.make("active"), status: "running" },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("message workflow commands", () => {
  it("forks the selected run into a new mobile thread", () => {
    expect(
      forkMessageInput(environmentId, threadId, ThreadId.make("target"), runId, "Chat"),
    ).toEqual({
      environmentId,
      input: {
        sourceThreadId: threadId,
        targetThreadId: "target",
        runId,
        title: "Chat fork",
        creationSource: "mobile",
      },
    });
  });
  it("requests the previous checkpoint with the selected file restore choice", () => {
    expect(revertMessageInput(environmentId, threadId, 0, commandId, false)).toEqual({
      environmentId,
      input: { threadId, turnCount: 0, commandId, restoreFiles: false },
    });
    expect(revertMessageInput(environmentId, threadId, 0, commandId, true).input.restoreFiles).toBe(
      true,
    );
  });
  it("preserves the existing draft and restores prompt context and attachments", () => {
    const oldAttachment = { id: "existing" } as never;
    const restoredAttachment = { id: "restored" } as never;
    const draft = {
      text: "unfinished",
      attachments: [oldAttachment],
      context: { version: 1, records: [{ contextId: "old" }] },
    } as never;
    const prompt: ThreadFeedMessage = {
      ...message,
      text: "previous prompt",
      context: { version: 1, records: [{ contextId: "new" } as never] },
    };
    expect(mergeRewoundPrompt(draft, prompt, [oldAttachment, restoredAttachment])).toEqual({
      text: "unfinished\n\nprevious prompt",
      context: { version: 1, records: [{ contextId: "old" }, { contextId: "new" }] },
      attachments: [restoredAttachment],
      duplicates: [oldAttachment],
    });
  });
  it("waits for a completed rollback and recognizes its correlated failure", () => {
    expect(rollbackSettled(projection, runId, 0, commandId)).toBe("pending");
    expect(
      rollbackSettled(
        { ...projection, runs: [{ ...projection.runs[0]!, status: "rolled_back" }] },
        runId,
        0,
        commandId,
      ),
    ).toBe("complete");
    expect(
      rollbackSettled(
        {
          ...projection,
          thread: {
            ...projection.thread,
            rollbackFailure: { requestId: commandId, message: "failed" },
          },
        },
        runId,
        0,
        commandId,
      ),
    ).toBe("failed");
  });
});

it("fork and rewind inputs use original identities and prompt text even when the display is hidden or rewritten", async () => {
  const { createCasualVoiceStore } = await import("@t3tools/client-runtime/casualVoice");
  const { segmentCasualMessage, parseCasualDecisions } =
    await import("@t3tools/shared/casualVoice");
  const original = "The Original request stays exact. Hope this helps.";
  const display = parseCasualDecisions(
    segmentCasualMessage(original, "final"),
    "1 say: the original request stays exact.\n2 hide: filler",
  )!;
  const store = createCasualVoiceStore();
  const backend = { kind: "local", url: "https://example.invalid/v1/", model: "test" } as const;
  await store.load("env\nsource", threadId, async () => ({ enabled: true, backend, models: [] }));
  await store.rewrite(
    "env\nsource",
    threadId,
    messageId,
    async () => ({ enabled: true, backend, display }),
    runId,
  );
  const source = Object.freeze({ ...message, text: original });
  const restored = mergeRewoundPrompt({ text: "Follow-up", attachments: [] }, source, []);
  expect(restored.text).toBe(`Follow-up\n\n${original}`);
  expect(
    forkMessageInput(environmentId, threadId, ThreadId.make("target"), runId, "Original title")
      .input,
  ).toMatchObject({ sourceThreadId: threadId, runId, title: "Original title fork" });
  expect(revertMessageInput(environmentId, threadId, 0, commandId, false).input).not.toHaveProperty(
    "display",
  );
  expect(source.text).toBe(original);
});

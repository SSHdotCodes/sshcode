import {
  MessageId,
  NodeId,
  OrchestrationV2BackgroundToolCallError,
  OrchestrationV2BackgroundToolCallInput,
  OrchestrationV2BackgroundToolCallResult,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deriveSteerWait,
  formatSteerWaitElapsed,
  sameSteerWait,
  sendSteerNow,
} from "./steerWait.ts";

const threadId = ThreadId.make("thread");
const runId = RunId.make("run");
const claude = ProviderDriverKind.make("claudeAgent");
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 22, 12) + second * 1000);

const base = (id: string, ordinal: number, second: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at(second),
  completedAt: at(second),
  updatedAt: at(second),
});

const prompt = (
  id: string,
  ordinal: number,
  inputIntent: "turn_start" | "steer" | "promoted_queued_to_steer" = "turn_start",
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, ordinal),
  type: "user_message",
  messageId: MessageId.make(id),
  text: `Prompt ${id}`,
  attachments: [],
  inputIntent,
  createdBy: "user",
  creationSource: "web",
});

const command = (
  id: string,
  ordinal: number,
  input: string,
  options: { readonly running?: boolean; readonly nativeId?: string | null } = {},
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, ordinal),
  type: "command_execution",
  input,
  status: options.running === false ? "completed" : "running",
  completedAt: options.running === false ? at(ordinal) : null,
  nativeItemRef:
    options.nativeId === null
      ? null
      : { driver: claude, nativeId: options.nativeId ?? `toolu_${id}`, strength: "strong" },
});

const answer = (id: string, ordinal: number): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, ordinal),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text: `Answer ${id}`,
  streaming: false,
});

describe("deriveSteerWait", () => {
  it("names the running command a steer waits behind", () => {
    const wait = deriveSteerWait([
      prompt("start", 1),
      command("sync", 2, "./sync_to_pi.sh --all\necho done"),
      prompt("steer", 3, "steer"),
    ]);
    expect(wait).toEqual({
      messageId: MessageId.make("steer"),
      toolCount: 1,
      label: "./sync_to_pi.sh --all",
      isCommand: true,
      startedAtMs: DateTime.toEpochMillis(at(2)),
      sendNowToolItemIds: [TurnItemId.make("sync")],
    });
  });

  it("counts both Claude commands until the parallel batch returns and times the earliest start", () => {
    const tests = command("tests", 2, "pnpm test");
    const cat = { ...command("cat", 3, "cat fixture.txt"), startedAt: at(3.4) };
    const steer = { ...prompt("steer", 4, "steer"), startedAt: at(66.4) };
    const wait = deriveSteerWait([prompt("start", 1), cat, tests, steer]);
    expect(wait).toEqual({
      messageId: MessageId.make("steer"),
      toolCount: 2,
      label: "2 commands",
      isCommand: false,
      startedAtMs: DateTime.toEpochMillis(at(2)),
      sendNowToolItemIds: [cat.id, tests.id],
    });
    expect(wait && formatSteerWaitElapsed(DateTime.toEpochMillis(at(80)) - wait.startedAtMs)).toBe(
      "1:18",
    );
    expect(
      deriveSteerWait([
        prompt("start", 1),
        { ...tests, status: "completed", completedAt: at(124) },
        { ...cat, status: "completed", completedAt: at(124.057) },
        steer,
      ]),
    ).toBeNull();
  });

  it("uses a neutral count for mixed calls and only targets calls Claude can background", () => {
    const tests = command("tests", 3, "pnpm test");
    expect(
      deriveSteerWait([
        prompt("start", 1),
        { ...base("search", 2, 2), type: "file_search", status: "running", completedAt: null },
        tests,
        { ...command("nested", 4, "ls"), parentItemId: tests.id },
        prompt("steer", 5, "steer"),
      ]),
    ).toMatchObject({
      label: "2 tool calls",
      startedAtMs: DateTime.toEpochMillis(at(2)),
      sendNowToolItemIds: [tests.id],
    });
  });

  it("clears once the agent produces anything after the steer", () => {
    expect(
      deriveSteerWait([
        prompt("start", 1),
        command("sync", 2, "./sync_to_pi.sh"),
        prompt("steer", 3, "steer"),
        answer("reply", 4),
      ]),
    ).toBeNull();
  });

  it("ignores finished commands and plain turn starts", () => {
    expect(
      deriveSteerWait([
        prompt("start", 1),
        command("ls", 2, "ls", { running: false }),
        prompt("steer", 3, "steer"),
      ]),
    ).toBeNull();
    expect(deriveSteerWait([prompt("start", 1), command("sync", 2, "./sync_to_pi.sh")])).toBeNull();
  });

  it("counts a queued message promoted to a steer", () => {
    expect(
      deriveSteerWait([
        prompt("start", 1),
        command("build", 2, "bun run build"),
        prompt("queued", 3, "promoted_queued_to_steer"),
      ])?.messageId,
    ).toBe(MessageId.make("queued"));
  });

  it("only offers Send now when Claude can background the call", () => {
    const codexCommand: OrchestrationV2TurnItem = {
      ...command("build", 2, "bun run build"),
      nativeItemRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "call_1",
        strength: "strong",
      },
    };
    expect(
      deriveSteerWait([prompt("start", 1), codexCommand, prompt("steer", 3, "steer")])
        ?.sendNowToolItemIds,
    ).toEqual([]);
    expect(
      deriveSteerWait([
        prompt("start", 1),
        command("build", 2, "bun run build", { nativeId: null }),
        prompt("steer", 3, "steer"),
      ])?.sendNowToolItemIds,
    ).toEqual([]);
  });

  it("labels subagents by title and shortens long commands", () => {
    const subagent: OrchestrationV2TurnItem = {
      ...base("agent", 2, 2),
      type: "subagent",
      status: "running",
      title: "Explore the repo",
      nativeItemRef: { driver: claude, nativeId: "toolu_agent", strength: "strong" },
      subagentId: NodeId.make("agent-node"),
      origin: "provider_native",
      driver: claude,
      providerInstanceId: ProviderInstanceId.make("claude"),
      childThreadId: null,
      prompt: "Explore",
      result: null,
    };
    expect(
      deriveSteerWait([prompt("start", 1), subagent, prompt("steer", 3, "steer")]),
    ).toMatchObject({
      label: "Explore the repo",
      isCommand: false,
      sendNowToolItemIds: [subagent.id],
    });

    // A subagent the app runs in the background does not hold the steer: the agent reads
    // it at its next step, not when a 90-minute audit ends.
    const background: OrchestrationV2TurnItem = {
      ...subagent,
      title: "Audit the gaps",
      nativeItemRef: null,
      origin: "app_owned",
      childThreadId: ThreadId.make("child"),
    };
    expect(
      deriveSteerWait([prompt("start", 1), background, prompt("steer", 3, "steer")]),
    ).toBeNull();
    // It does not hide a command that really holds it.
    expect(
      deriveSteerWait([
        prompt("start", 1),
        command("sync", 2, "./sync_to_pi.sh"),
        { ...background, ...base("audit", 3, 3), status: "running" } as OrchestrationV2TurnItem,
        prompt("steer", 4, "steer"),
      ])?.label,
    ).toBe("./sync_to_pi.sh");

    const label = deriveSteerWait([
      prompt("start", 1),
      command("long", 2, `python3 train.py ${"--flag ".repeat(20)}`),
      prompt("steer", 3, "steer"),
    ])?.label;
    expect(label?.length).toBeLessThanOrEqual(60);
    expect(label?.endsWith("…")).toBe(true);
  });
});

describe("sendSteerNow", () => {
  const cat = TurnItemId.make("cat");
  const tests = TurnItemId.make("tests");
  const batch = { threadId, turnItemId: cat, additionalTurnItemIds: [tests] };
  const testsOnly = { threadId, turnItemId: tests };
  const legacyInput = Schema.toCodecJson(
    Schema.Struct({ threadId: ThreadId, turnItemId: TurnItemId }),
  );
  const legacySuccess = Schema.toCodecJson(Schema.Void);
  const currentInput = Schema.toCodecJson(OrchestrationV2BackgroundToolCallInput);
  const currentSuccess = Schema.toCodecJson(OrchestrationV2BackgroundToolCallResult);
  const alreadyFinished = new OrchestrationV2BackgroundToolCallError({
    threadId,
    turnItemId: cat,
    reason: "not-running",
  });
  const batchFailure = new OrchestrationV2BackgroundToolCallError({
    ...testsOnly,
    reason: "failed",
    handledBatch: true,
  });
  const failed = (error: OrchestrationV2BackgroundToolCallError) =>
    AsyncResult.failure<
      OrchestrationV2BackgroundToolCallResult,
      OrchestrationV2BackgroundToolCallError
    >(Cause.fail(error));

  it("uses one request when the server acknowledges the batch", async () => {
    const result = Schema.decodeSync(currentSuccess)(
      Schema.encodeSync(currentSuccess)({ handledBatch: true }),
    );
    const backgroundToolCall = vi.fn(async () => AsyncResult.success(result));
    expect(await sendSteerNow(threadId, [cat, tests], backgroundToolCall)).toBeUndefined();
    expect(backgroundToolCall.mock.calls).toEqual([[batch]]);
  });

  it("reports the batch's failure without retrying calls", async () => {
    const codec = Schema.toCodecJson(OrchestrationV2BackgroundToolCallError);
    const error = Schema.decodeSync(codec)(Schema.encodeSync(codec)(batchFailure));
    const backgroundToolCall = vi.fn(async () => failed(error));
    expect(await sendSteerNow(threadId, [cat, tests], backgroundToolCall)).toBe(error);
    expect(backgroundToolCall.mock.calls).toEqual([[batch]]);
  });

  it("keeps the single-ID request and void response compatible with older clients", () => {
    expect(Schema.decodeSync(currentInput)(Schema.encodeSync(legacyInput)(testsOnly))).toEqual(
      testsOnly,
    );
    expect(
      Schema.decodeSync(legacySuccess)(Schema.encodeSync(currentSuccess)(undefined)),
    ).toBeUndefined();
  });

  it.each(["finished", "moved"] as const)(
    "sends the remaining IDs on a legacy server when the first call %s",
    async (state) => {
      const encode = Schema.encodeSync(currentInput);
      const decodeLegacy = Schema.decodeSync(legacyInput);
      const encodeLegacySuccess = Schema.encodeSync(legacySuccess);
      const decodeSuccess = Schema.decodeSync(currentSuccess);
      const backgroundToolCall = vi.fn(async (request: OrchestrationV2BackgroundToolCallInput) => {
        const { turnItemId } = decodeLegacy(encode(request));
        return turnItemId === cat && state === "finished"
          ? failed(alreadyFinished)
          : AsyncResult.success(decodeSuccess(encodeLegacySuccess(undefined)));
      });
      expect(await sendSteerNow(threadId, [cat, tests], backgroundToolCall)).toBeUndefined();
      expect(backgroundToolCall.mock.calls).toEqual([[batch], [testsOnly]]);
    },
  );

  it("keeps a genuine legacy failure when the other call has finished", async () => {
    const failure = new OrchestrationV2BackgroundToolCallError({ ...testsOnly, reason: "failed" });
    const backgroundToolCall = vi.fn(
      async ({ turnItemId }: OrchestrationV2BackgroundToolCallInput) =>
        failed(turnItemId === cat ? alreadyFinished : failure),
    );
    expect(await sendSteerNow(threadId, [cat, tests], backgroundToolCall)).toBe(failure);
    expect(backgroundToolCall.mock.calls).toEqual([[batch], [testsOnly]]);
  });
});

describe("formatSteerWaitElapsed", () => {
  it("formats minutes and hours", () => {
    expect(formatSteerWaitElapsed(-5)).toBe("0:00");
    expect(formatSteerWaitElapsed(42_000)).toBe("0:42");
    expect(formatSteerWaitElapsed(201_000)).toBe("3:21");
    expect(formatSteerWaitElapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("sameSteerWait", () => {
  it("matches structurally identical waits across streaming item array rebuilds", () => {
    const items = [
      prompt("start", 1),
      command("run", 2, "pnpm test", { nativeId: "toolu_1" }),
      prompt("steer", 3, "steer"),
    ];
    const first = deriveSteerWait(items);
    const second = deriveSteerWait([...items]);
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(sameSteerWait(first, second)).toBe(true);
    expect(sameSteerWait(null, null)).toBe(true);
    expect(sameSteerWait(first, null)).toBe(false);
    expect(sameSteerWait(first, { ...second!, label: "other" })).toBe(false);
    expect(sameSteerWait(first, { ...second!, sendNowToolItemIds: [] })).toBe(false);
  });
});

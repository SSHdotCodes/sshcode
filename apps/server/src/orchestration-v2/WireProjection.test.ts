import {
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  PlanId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2RpcSchemas,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { restoreThreadTextAppends } from "../../../../packages/client-runtime/src/state/threadTextAppends.ts";

import { coalesceLiveToolUpdatedEvents } from "./ThreadLiveEventCoalescer.ts";
import {
  boundCommandOutputForStorage,
  boundStreamingReasoningForStorage,
  boundToolOutputForStorage,
  makeLiveBodyDeduper,
  makeStreamingThoughtFilter,
  STREAMING_REASONING_ELISION,
  STREAMING_REASONING_LIVE_INTERVAL_MS,
  STREAMING_REASONING_STORED_CHARS,
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import { MAX_TOOL_OUTPUT_IMAGES, toolOutputImages } from "@t3tools/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("shows a historical Antigravity checklist as a snapshot with unfinished steps", () => {
    const item = {
      ...base,
      type: "todo_list" as const,
      title: null,
      status: "running" as const,
      completedAt: null,
      nativeItemRef: {
        driver: ProviderDriverKind.make("antigravity"),
        nativeId: "turn:plan:default",
        strength: "weak" as const,
      },
      planId: PlanId.make("plan:acp"),
      steps: [{ id: "acp-step-1", text: "Check the rollout", status: "running" as const }],
    };
    const snapshot = { ...item, status: "completed", completedAt: item.updatedAt };
    expect(projectTurnItemForWire(item)).toEqual(snapshot);
    expect(projectTurnItemForDetail(item)).toEqual(snapshot);
  });
  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("projects bounded tool image metadata without sending image bytes", () => {
    const output = Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 2 }, (_, index) => ({
      type: "image",
      mimeType: index === 1 ? "image/jpeg" : "image/png",
      data: `PRIVATE_IMAGE_${index}`,
      ...(index === 0 ? { imageUnavailable: true } : {}),
    }));
    const projected = projectTurnItemForWire({ ...base, output });
    expect(projected.type).toBe("dynamic_tool");
    if (projected.type !== "dynamic_tool") throw new Error("unexpected item type");
    expect(projected.outputImages).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
    expect(projected.outputImages?.slice(0, 2)).toEqual([
      { mimeType: "image/png", unavailable: true },
      { mimeType: "image/jpeg" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_IMAGE");
    expect(decodeTurnItem(decodeTurnItemJson(encodeTurnItemJson(projected)))).toEqual(projected);
    expect(projectTurnItemForWire(projected)).toEqual(projected);
  });

  it("preserves provider notices in bounded items and live events", () => {
    const item = {
      ...base,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    expect(projectTurnItemForWire(item)).toEqual(item);
    const event = {
      id: EventId.make("notice-wire-event"),
      type: "turn-item.updated" as const,
      threadId: item.threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
    expect(projectDomainEventForWire(event)).toEqual(event);
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected).not.toHaveProperty("output");
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it.each([
    [" \t\r\n\n  first\t line  \r\n" + "x\n".repeat(10_000), "first line"],
    [" \n".repeat(10_000), "Large tool output"],
    ["a".repeat(160) + "\n" + "x".repeat(20_000), "a".repeat(160)],
    ["a".repeat(161) + "\n" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["a".repeat(159) + "\t b" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["  café\u00a0\u2003😀 \t\r\n" + "x".repeat(20_000), "café 😀"],
  ])("preserves bounded input summary normalization for case %#", (input, summary) => {
    const projected = projectTurnItemForWire({ ...base, input });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary,
      truncated: true,
    });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("serializes an oversized structured input only once for its summary", () => {
    let serializations = 0;
    const input = {
      toJSON() {
        serializations += 1;
        return { text: "x".repeat(100_000) };
      },
    };
    const projected = projectTurnItemForWire({ ...base, input });
    expect(serializations).toBe(1);
    expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
      truncated: true,
    });
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const progress = "a".repeat(32_767) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect code",
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(32_767) + "\n… output truncated for transport",
    );
    expect(item.progress).toBe(progress);
  });

  it("does not attach a finished task's commits to the result of a later child turn", () => {
    const followupStarted = DateTime.toEpochMillis(base.completedAt) + 1_000;
    const task = {
      id: NodeId.make("subagent"),
      threadId: base.threadId,
      runId: null,
      parentNodeId: NodeId.make("parent"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: null,
      childThreadId: ThreadId.make("child"),
      nativeTaskRef: null,
      prompt: "Initial task",
      title: "Worker",
      model: "gpt-5.4",
      status: "completed",
      result: "Initial result",
      seen: { commits: ["123abcd"], files: 3 },
      startedAt: base.startedAt,
      completedAt: base.completedAt,
      updatedAt: base.updatedAt,
    } satisfies OrchestrationV2Subagent;
    const resumed = {
      ...task,
      childActivity: {
        runId: RunId.make("run:follow-up"),
        status: "failed" as const,
        result: "Follow-up failed",
        startedAt: followupStarted,
        completedAt: followupStarted + 1_000,
      },
    };
    const event = {
      id: EventId.make("subagent-followup"),
      type: "subagent.updated" as const,
      threadId: task.threadId,
      occurredAt: task.updatedAt,
      payload: resumed,
    };
    const display = { status: "failed", result: "Follow-up failed", seen: undefined };
    expect(projectDomainEventForWire(event).payload).toMatchObject(display);
    expect(
      projectThreadProjectionForWire({
        subagents: [resumed],
        contextHandoffs: [],
        turnItems: [],
        visibleTurnItems: [],
      } as unknown as OrchestrationV2ThreadProjection).subagents[0],
    ).toMatchObject(display);
    expect(projectDomainEventForWire({ ...event, payload: task }).payload).toEqual(task);
    expect(
      projectDomainEventForWire({
        ...event,
        payload: {
          ...resumed,
          childActivity: {
            ...resumed.childActivity,
            startedAt: DateTime.toEpochMillis(base.startedAt),
          },
        },
      }).payload,
    ).toMatchObject({ seen: task.seen });
    expect(resumed.seen).toBe(task.seen);
  });

  it.each(["", "small output", "x".repeat(1_048_576)])(
    "omits command output of every size, case %#",
    (output) => {
      const item = { ...base, type: "command_execution" as const, input: "test", output };
      const projected = projectTurnItemForWire(item);
      expect(projected).not.toHaveProperty("output");
      expect(projected).toMatchObject({ input: "test", status: "completed" });
      // Clients fetch withheld output on demand, so they need to know it exists.
      expect(projected.type === "command_execution" ? projected.outputOmitted : null).toBe(
        output ? true : undefined,
      );
      expect(item.output).toBe(output);
    },
  );

  it.each([
    ["echo ok", "echo ok"],
    ["a".repeat(262_143) + "😀", "a".repeat(262_143) + "\n… output truncated for transport"],
  ])("bounds fetched command input without changing persistence, case %#", (input, expected) => {
    const item = { ...base, type: "command_execution" as const, input, output: "ok" };
    const projected = projectTurnItemForDetail(item);
    expect(projected).toMatchObject({ input: expected, output: "ok" });
    expect(item.input).toBe(input);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3-code__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    // The truncated text block plus a fixed number of markers, however many images there are.
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    // A failed edit keeps the provider's error so expanding the row can show it.
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("does not serialize raw dynamic output to discard it", () => {
    const output = {
      toJSON: () => {
        throw new Error("Raw output must not be serialized");
      },
    };
    expect(projectTurnItemForWire({ ...base, output })).not.toHaveProperty("output");
  });
});

describe("live body deduper", () => {
  const at = base.updatedAt;
  const messageId = MessageId.make("message-live");
  const event = (
    sequence: number,
    rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
  ): Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> => ({
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      threadId: base.threadId,
      occurredAt: at,
      ...rest,
    } as OrchestrationV2DomainEvent,
  });
  const message = (sequence: number, text: string) =>
    event(sequence, {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId: base.threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
  const reply = (sequence: number, text: string) =>
    event(sequence, {
      type: "turn-item.updated",
      payload: {
        ...base,
        status: "running",
        type: "assistant_message",
        messageId,
        text,
        streaming: true,
      },
    });
  const payloadOf = (item: OrchestrationV2ThreadStreamItem) =>
    item.kind === "event" ? item.event.payload : undefined;

  it.effect(
    "sends text suffixes only to opted-in clients and restores identical events before reduction",
    () =>
      Effect.gen(function* () {
        const source = [
          message(1, "a".repeat(1024)),
          reply(2, "a".repeat(1024)),
          message(3, "a".repeat(1024) + "🦊 next"),
          reply(4, "a".repeat(1024) + "🦊 next"),
          message(5, "replacement"),
          message(6, "replacement" + "b".repeat(1024)),
          message(7, "replacement" + "b".repeat(1024)),
        ];
        const legacy = source.map(makeLiveBodyDeduper());
        const compact = source.map(makeLiveBodyDeduper({ textAppends: true }));
        expect(compact[0]).not.toHaveProperty("textAppendFrom");
        expect(compact[2]).toMatchObject({
          textAppendFrom: 1024,
          event: { payload: { text: "🦊 next" } },
        });
        expect(compact[4]).not.toHaveProperty("textAppendFrom");
        expect(compact[6]).toMatchObject({
          textAppendFrom: 1035,
          event: { payload: { text: "" } },
        });
        const codec = Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output);
        const delivered = compact.map((item) =>
          Schema.decodeSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(item)))),
        );
        expect(
          yield* restoreThreadTextAppends(Stream.fromIterable(delivered)).pipe(Stream.runCollect),
        ).toEqual(
          legacy.map((item) =>
            Schema.decodeSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(item)))),
          ),
        );
        // A reconnect starts another subscription and must never reference text
        // that only the previous subscription delivered.
        expect(makeLiveBodyDeduper({ textAppends: true })(source[2]!)).not.toHaveProperty(
          "textAppendFrom",
        );
      }),
  );

  it("blanks a reply that repeats the message delivered before it, after coalescing", () => {
    const delivered = coalesceLiveToolUpdatedEvents([
      message(1, "a"),
      reply(2, "a"),
      message(3, "ab"),
      reply(4, "ab"),
    ]).map(makeLiveBodyDeduper());

    expect(
      delivered.map((item) => [item.kind === "event" && item.sequence, payloadOf(item)]),
    ).toEqual([
      [1, message(1, "a").event.payload],
      [2, { ...reply(2, "a").event.payload, text: "", textOmitted: true }],
      [3, message(3, "ab").event.payload],
      [4, { ...reply(4, "ab").event.payload, text: "", textOmitted: true }],
    ]);
  });

  it("ships a reply whole when its message arrives after it", () => {
    const first = reply(1, "a");
    expect([first, message(2, "a")].map(makeLiveBodyDeduper())[0]).toBe(first);
  });
});

describe("streaming thoughts in storage", () => {
  const thought = (text: string, streaming = true) =>
    ({
      ...base,
      id: TurnItemId.make("thought-1"),
      type: "reasoning",
      title: "Thinking",
      text,
      streaming,
      status: streaming ? "running" : "completed",
    }) as unknown as OrchestrationV2TurnItem;
  const textOf = (item: OrchestrationV2TurnItem) => (item as { readonly text: string }).text;
  const long = (lines: number) =>
    Array.from({ length: lines }, (_, index) => `Line ${index} of the thought.`).join("\n");

  it("keeps only the opening of other chats' streaming thoughts", () => {
    const item = thought(long(400));
    expect(textOf(boundStreamingReasoningForStorage(item))).toBe(
      textOf(item).slice(0, STREAMING_REASONING_STORED_CHARS),
    );
    expect(boundStreamingReasoningForStorage(thought(long(400), false))).toEqual(
      thought(long(400), false),
    );
  });

  it("keeps a live thought's opening and its latest lines", () => {
    const full = long(400);
    const stored = textOf(boundStreamingReasoningForStorage(thought(full), { liveTail: true }));
    const [opening, tail] = stored.split(STREAMING_REASONING_ELISION);
    expect(opening).toBe(full.slice(0, STREAMING_REASONING_STORED_CHARS));
    expect(full.endsWith(tail!)).toBe(true);
    expect(tail!.startsWith("Line ")).toBe(true);
    expect(tail!.endsWith("Line 399 of the thought.")).toBe(true);
    expect(stored.length).toBeLessThan(full.length);
    // Short of a full tail, the whole thought is kept.
    const short = full.slice(0, STREAMING_REASONING_STORED_CHARS + 200);
    expect(textOf(boundStreamingReasoningForStorage(thought(short), { liveTail: true }))).toBe(
      short,
    );
  });

  it("writes a live thought past its opening at most once per interval", () => {
    const isNew = makeStreamingThoughtFilter();
    const full = long(400);
    const at = (text: string, nowMs: number) =>
      isNew(boundStreamingReasoningForStorage(thought(text), { liveTail: true }), nowMs);
    expect(at(full.slice(0, 500), 0)).toBe(true);
    expect(at(full.slice(0, 500), 10)).toBe(false);
    expect(at(full.slice(0, 900), 20)).toBe(true);
    expect(at(full.slice(0, 6_000), 30)).toBe(true);
    expect(at(full.slice(0, 6_100), 40)).toBe(false);
    expect(at(full.slice(0, 6_200), 30 + STREAMING_REASONING_LIVE_INTERVAL_MS)).toBe(true);
    // The finished thought is always written.
    expect(isNew(thought(full, false), 50 + STREAMING_REASONING_LIVE_INTERVAL_MS)).toBe(true);
  });
});

describe("stored output bounds", () => {
  const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

  it("keeps both ends of a long multi-byte command output within its byte budget", () => {
    const output = `first line\n${"日本語".repeat(100_000)}${"😀".repeat(50_000)}\nlast line`;
    const item = { ...base, type: "command_execution" as const, input: "make", output };
    const stored = boundCommandOutputForStorage(item);
    const text = stored.type === "command_execution" ? (stored.output ?? "") : "";
    expect(utf8Bytes(text)).toBeLessThanOrEqual(256 * 1024);
    expect(utf8Bytes(text)).toBeGreaterThan(120 * 1024);
    expect(text.startsWith("first line\n日本語")).toBe(true);
    expect(text.endsWith("😀\nlast line")).toBe(true);
    expect(text).toMatch(/\n… \d+ characters of output omitted …\n/u);
    // Cuts fall between characters, never inside one.
    expect(text).not.toContain("\uFFFD");
    const short = { ...item, output: "ok\n" };
    expect(boundCommandOutputForStorage(short)).toBe(short);
  });

  it("bounds every text in a tool output and leaves its images whole", () => {
    const screenshot = Buffer.alloc(400_000, 7).toString("base64");
    const output = {
      content: [
        { type: "text", text: `head ${"a".repeat(1_000_000)} tail` },
        { type: "image", data: screenshot, mimeType: "image/png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
      ],
      structuredContent: { tree: "b".repeat(600_000), note: "small" },
    };
    const item = { ...base, output };
    const boundedItem = boundToolOutputForStorage(item);
    const bounded = boundedItem.type === "dynamic_tool" ? boundedItem.output : undefined;
    expect(bounded).toMatchObject({
      content: [{ type: "text" }, output.content[1], output.content[2]],
      structuredContent: { note: "small" },
    });
    const stored = bounded as {
      readonly content: ReadonlyArray<{ readonly text?: string }>;
      readonly structuredContent: { readonly tree: string };
    };
    const text = stored.content[0]?.text ?? "";
    expect(utf8Bytes(text)).toBeLessThanOrEqual(256 * 1024);
    expect(text).toMatch(/^head a+\n… \d+ characters of output omitted …\na+ tail$/u);
    expect(utf8Bytes(stored.structuredContent.tree)).toBeLessThanOrEqual(256 * 1024);
    // The asset route serves images by index from the stored output.
    expect(toolOutputImages(bounded)).toEqual(toolOutputImages(output));
    expect(toolOutputImages(bounded)[0]?.data).toBe(screenshot);
    expect(item.output).toBe(output);

    const plain = { ...base, output: `x${"y".repeat(400_000)}z` };
    const plainStored = boundToolOutputForStorage(plain);
    expect(plainStored.type === "dynamic_tool" ? plainStored.output : null).toMatch(
      /^xy+\n… \d+ characters of output omitted …\ny+z$/u,
    );
    const small = { ...base, output: { content: [{ type: "text", text: "fine" }] } };
    expect(boundToolOutputForStorage(small)).toBe(small);
  });
});

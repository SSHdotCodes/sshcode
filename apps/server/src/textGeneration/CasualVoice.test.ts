import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  MessageId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as CasualVoice from "./CasualVoice.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Config from "../config.ts";
import {
  segmentCasualMessage,
  casualVisibleText,
  type CasualVoiceInput,
} from "@t3tools/shared/casualVoice";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decisions = (input: CasualVoiceInput) =>
  input.segments
    .map(
      (segment) =>
        `${segment.id} say: ${segment.text
          .split(/(⟦[CBPUN]\d+⟧)/)
          .map((part) => (/^⟦[CBPUN]\d+⟧$/.test(part) ? part : part.toLowerCase()))
          .join("")}`,
    )
    .join("\n");
const threadId = ThreadId.make("voice-chat");
const otherThreadId = ThreadId.make("other-chat");
const messageId = MessageId.make("reply");
const backend = {
  kind: "provider",
  modelSelection: { instanceId: ProviderInstanceId.make("fake-provider"), model: "test-model" },
} as const;
const original = "Hello There. Keep `Important` At 42.";
const messages = [
  { id: MessageId.make("reply-two"), role: "assistant", text: original, streaming: false },
  { id: MessageId.make("reply-three"), role: "assistant", text: original, streaming: false },
  { id: MessageId.make("streaming"), role: "assistant", text: original, streaming: true },
  { id: messageId, role: "assistant", text: original, streaming: false },
  { id: MessageId.make("user"), role: "user", text: "yeah that works" },
];
// Only message fields are read by this service; the thread store is a boundary stub.
const projection = { messages } as unknown as OrchestrationV2ThreadProjection;
const catalog = [
  {
    instanceId: backend.modelSelection.instanceId,
    displayName: "Test provider",
    enabled: true,
    models: [{ slug: "test-model", name: "Test model" }],
  },
] as unknown as ReadonlyArray<ServerProvider>;
function dependencies(
  stateDir: string,
  rewrite: NonNullable<ProviderInstance["textGeneration"]["rewriteProse"]>,
  defaultStyleFile: string | null = null,
  records = projection,
) {
  return Layer.mergeAll(
    Layer.succeed(CasualVoice.DefaultStyleFile, defaultStyleFile),
    Config.layerTest(import.meta.dirname, stateDir),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(catalog) }),
    Layer.mock(TextGeneration.TextGeneration)({ rewriteProse: rewrite }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: (requestedThreadId) =>
        Effect.succeed(
          requestedThreadId === threadId
            ? records
            : { ...records, messages: [], turnItems: [], runs: [] },
        ),
      getThreadSnapshotWindow: () =>
        Effect.succeed({ projection: records, snapshotSequence: 0, schemaVersion: 1 }),
    }),
  );
}
const lower = () =>
  Effect.succeed({ output: decisions(segmentCasualMessage(original, "final").input) });
const acquire = (
  stateDir: string,
  rewrite: NonNullable<ProviderInstance["textGeneration"]["rewriteProse"]> = lower,
  defaultStyleFile: string | null = null,
  records = projection,
) =>
  Effect.map(
    Layer.build(
      CasualVoice.layer.pipe(
        Layer.provide(dependencies(stateDir, rewrite, defaultStyleFile, records)),
      ),
    ),
    (context) => Context.get(context, CasualVoice.CasualVoice),
  );

const steerRunId = RunId.make("steered-run");
const steerMessageId = MessageId.make("steer");
const at = DateTime.makeUnsafe("2026-10-27T00:00:00Z");
const itemBase = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: steerRunId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const steerItem: OrchestrationV2TurnItem = {
  ...itemBase("steer-item", 1),
  type: "user_message",
  messageId: steerMessageId,
  text: "Check `active` again. " + "x".repeat(700),
  inputIntent: "steer",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
};
const reasoningItems: OrchestrationV2TurnItem[] = [
  steerItem,
  {
    ...itemBase("reasoning-one", 2),
    type: "reasoning",
    text: "I found the earlier result.",
    streaming: false,
  },
  {
    ...itemBase("reasoning-two", 3),
    type: "reasoning",
    text: "It probably still applies.",
    streaming: false,
  },
];
const reasoningRecords = {
  ...projection,
  messages: [
    ...messages,
    { id: steerMessageId, role: "user", runId: steerRunId, text: steerItem.text },
  ],
  turnItems: reasoningItems,
  runs: [{ id: steerRunId, status: "completed" }],
} as unknown as OrchestrationV2ThreadProjection;
const reasoningRequest = {
  action: "rewrite",
  threadId,
  messageId: steerMessageId,
  reasoningItemId: TurnItemId.make("reasoning-one"),
  role: "final",
} as const;

it.layer(NodeServices.layer)("casual voice service", (it) => {
  it.effect(
    "rewrites a closed steer window once with masked context, update role and a persistent cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-steer-" });
        let calls = 0;
        const rewrite = (
          input: Parameters<NonNullable<ProviderInstance["textGeneration"]["rewriteProse"]>>[0],
        ) => {
          calls++;
          expect(input.prompt).toContain(
            '"role":"update","source":"reasoning","replyTo":"Check ⟦C1⟧ again.',
          );
          expect(input.prompt).not.toContain(steerItem.text);
          expect(input.prompt).toContain('"id":2,"text":"It probably still applies."');
          return Effect.succeed({
            output: "1 say: i found the earlier result.\n2 say: it probably still applies.",
          });
        };
        const first = yield* acquire(dir, rewrite, null, reasoningRecords);
        yield* first.request({ action: "configure", threadId, backend });
        const result = yield* first.request(reasoningRequest);
        expect(result.display?.role).toBe("update");
        expect(casualVisibleText(result.display!)).toContain("it probably still applies.");
        const reopened = yield* acquire(dir, rewrite, null, reasoningRecords);
        expect((yield* reopened.request(reasoningRequest)).display).toEqual(result.display);
        expect(calls).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects unrelated, non-reasoning, non-steer and open-window targets before invoking the model",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-steer-validation-" });
        let calls = 0;
        const rewrite = () => {
          calls++;
          return lower();
        };
        const service = yield* acquire(dir, rewrite, null, reasoningRecords);
        yield* service.request({ action: "configure", threadId, backend });
        for (const input of [
          { ...reasoningRequest, messageId },
          { ...reasoningRequest, reasoningItemId: TurnItemId.make("steer-item") },
          { ...reasoningRequest, reasoningItemId: TurnItemId.make("reasoning-two") },
          { ...reasoningRequest, reasoningItemId: TurnItemId.make("unrelated") },
          { ...reasoningRequest, threadId: otherThreadId },
        ])
          expect(yield* service.request(input)).not.toHaveProperty("display");
        const open = yield* acquire(dir, rewrite, null, {
          ...reasoningRecords,
          runs: [{ ...reasoningRecords.runs[0]!, status: "running" }],
        });
        expect(yield* open.request(reasoningRequest)).not.toHaveProperty("display");
        const nonSteer = yield* acquire(dir, rewrite, null, {
          ...reasoningRecords,
          turnItems: [{ ...steerItem, inputIntent: "turn_start" }, ...reasoningItems.slice(1)],
        });
        expect(yield* nonSteer.request(reasoningRequest)).not.toHaveProperty("display");
        expect(calls).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves an intentional all-hide decision and caches failed rewrites as fallbacks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-steer-fallback-" });
        const silent = yield* acquire(
          dir,
          () => Effect.succeed({ output: "1-2 hide: filler" }),
          null,
          reasoningRecords,
        );
        yield* silent.request({ action: "configure", threadId, backend });
        const result = yield* silent.request(reasoningRequest);
        expect(result.display?.blocks[0]?.kind).toBe("hide");
        expect(casualVisibleText(result.display!).trim()).toBe("");
        const failureDir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-steer-failure-" });
        let calls = 0;
        const failing = yield* acquire(
          failureDir,
          () => {
            calls++;
            return Effect.fail(
              new TextGenerationError({ operation: "rewriteProse", detail: "Synthetic failure" }),
            );
          },
          null,
          reasoningRecords,
        );
        yield* failing.request({ action: "configure", threadId, backend });
        expect(yield* failing.request(reasoningRequest)).not.toHaveProperty("display");
        expect(yield* failing.request(reasoningRequest)).not.toHaveProperty("display");
        expect(calls).toBe(1);
        yield* failing.request({ action: "configure", threadId, enabled: false });
        expect(yield* failing.request(reasoningRequest)).not.toHaveProperty("display");
      }).pipe(Effect.scoped),
  );

  it.effect("regenerates a durable cache entry that no longer covers the protected segments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-cache-layout-" });
      let calls = 0;
      const rewrite = () => {
        calls++;
        return lower();
      };
      const service = yield* acquire(dir, rewrite);
      yield* service.request({ action: "configure", threadId, backend });
      yield* service.request({ action: "rewrite", threadId, messageId });
      const paths = yield* Config.deriveServerPaths(dir, undefined);
      const file = `${paths.stateDir}/casual-voice-v1.json`;
      const document = JSON.parse(yield* fs.readFileString(file)) as {
        entries: Array<{ text: string }>;
      };
      document.entries[0]!.text = "1 say: incomplete old decisions";
      yield* fs.writeFileString(file, yield* encodeJson(document));
      const reopened = yield* acquire(dir, rewrite);
      expect(
        (yield* reopened.request({ action: "rewrite", threadId, messageId })).display,
      ).toBeDefined();
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("queues bounded work with at most two active utility runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-queue-" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const service = yield* acquire(dir, () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 2) yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* lower();
        }),
      );
      yield* service.request({ action: "configure", threadId, backend });
      const fibers = yield* Effect.forEach(
        [messageId, MessageId.make("reply-two"), MessageId.make("reply-three")],
        (id) => Effect.forkChild(service.request({ action: "rewrite", threadId, messageId: id })),
      );
      yield* Deferred.await(started);
      expect(calls).toBe(2);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.forEach(fibers, Fiber.join);
      expect(calls).toBe(3);
      expect(
        results.every(
          (result) => casualVisibleText(result.display!) === "hello there. keep `Important` at 42.",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "defaults on, asks for a live model, persists per-chat overrides and caches across restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-" });
        let calls = 0;
        const rewrite: NonNullable<ProviderInstance["textGeneration"]["rewriteProse"]> = (
          input,
        ) => {
          calls++;
          expect(input.prompt).toContain("yeah that works");
          return lower();
        };
        const first = yield* acquire(dir, rewrite);
        expect(yield* first.request({ action: "get", threadId })).toMatchObject({
          enabled: true,
          backend: null,
        });
        expect(yield* first.request({ action: "rewrite", threadId, messageId })).not.toHaveProperty(
          "display",
        );
        expect(calls).toBe(0);
        yield* first.request({ action: "configure", threadId, backend });
        expect(
          yield* first.request({
            action: "rewrite",
            threadId,
            messageId: MessageId.make("streaming"),
          }),
        ).not.toHaveProperty("display");
        expect(
          yield* first.request({ action: "rewrite", threadId, messageId: MessageId.make("user") }),
        ).not.toHaveProperty("display");
        expect(calls).toBe(0);
        const result = yield* first.request({ action: "rewrite", threadId, messageId });
        expect(casualVisibleText(result.display!)).toBe("hello there. keep `Important` at 42.");
        yield* first.request({ action: "configure", threadId, enabled: false });
        expect(yield* first.request({ action: "rewrite", threadId, messageId })).not.toHaveProperty(
          "display",
        );
        expect((yield* first.request({ action: "get", threadId: otherThreadId })).enabled).toBe(
          true,
        );
        const reopened = yield* acquire(dir, rewrite);
        expect((yield* reopened.request({ action: "get", threadId })).enabled).toBe(false);
        yield* reopened.request({ action: "configure", threadId, enabled: true });
        expect(
          (yield* reopened.request({ action: "rewrite", threadId, messageId })).display,
        ).toEqual(result.display);
        expect(calls).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("caches failure fallbacks and rejects a model absent from the live catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-fail-" });
      let calls = 0;
      const service = yield* acquire(dir, () => {
        calls++;
        return Effect.fail(
          new TextGenerationError({ operation: "rewriteProse", detail: "Fake failure" }),
        );
      });
      yield* service.request({ action: "configure", threadId, backend });
      yield* service.request({ action: "rewrite", threadId, messageId });
      yield* service.request({ action: "rewrite", threadId, messageId });
      expect(calls).toBe(1);
      const invalid = yield* service
        .request({
          action: "configure",
          threadId,
          backend: { ...backend, modelSelection: { ...backend.modelSelection, model: "absent" } },
        })
        .pipe(Effect.flip);
      expect(invalid._tag).toBe("CasualVoiceError");
    }).pipe(Effect.scoped),
  );
});

it.effect("times out at ten seconds and returns the original-display fallback", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const work = CasualVoice.rewriteWithFallback(original, [], {
      rewrite: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
    });
    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toBeNull();
  }),
);
it.effect("invalid prose and backend failures return the original-display fallback", () =>
  Effect.gen(function* () {
    expect(
      yield* CasualVoice.rewriteWithFallback(original, [], {
        rewrite: () => Effect.succeed("1 say: changed `code`"),
      }),
    ).toBeNull();
    expect(
      yield* CasualVoice.rewriteWithFallback(original, [], {
        rewrite: () =>
          Effect.fail(new TextGenerationError({ operation: "rewriteProse", detail: "Fake" })),
      }),
    ).toBeNull();
  }),
);

it.effect("uses an OpenAI-compatible endpoint against a fake server only", () =>
  Effect.gen(function* () {
    let posted: unknown;
    let output = "1 say: hello there.";
    const route = HttpRouter.add(
      "POST",
      "/v1/chat/completions",
      Effect.gen(function* () {
        posted = yield* (yield* HttpServerRequest.HttpServerRequest).json;
        return HttpServerResponse.jsonUnsafe({
          choices: [{ message: { content: output } }],
        });
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(route, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const address = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    expect(
      yield* CasualVoice.localRewriter(`${address}/v1/`, "fake-local-model").rewrite(
        segmentCasualMessage("Hello there.", "final").input,
        [],
      ),
    ).toEqual("1 say: hello there.");
    expect(posted).toMatchObject({
      model: "fake-local-model",
      stream: false,
      messages: [
        { role: "system", content: expect.stringContaining("contract v2") },
        {
          role: "user",
          content: yield* encodeJson(segmentCasualMessage("Hello there.", "final").input),
        },
      ],
    });
    const reasoningSource = segmentCasualMessage(
      "The user probably needs the earlier result.",
      "update",
      { source: "reasoning", replyTo: "check `active`" },
    );
    yield* CasualVoice.localRewriter(`${address}/v1/`, "fake-local-model").rewrite(
      reasoningSource.input,
      [],
    );
    expect(posted).toMatchObject({
      messages: [
        { role: "system", content: expect.stringContaining('source:"reasoning"') },
        { role: "user", content: yield* encodeJson(reasoningSource.input) },
      ],
    });
    output = (yield* lower()).output;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-local-" });
    const service = yield* acquire(dir, () =>
      Effect.die("The local backend must not use a provider login"),
    );
    yield* service.request({
      action: "configure",
      threadId,
      backend: { kind: "local", url: `${address}/v1/`, model: "fake-local-model" },
    });
    expect(
      casualVisibleText(
        (yield* service.request({ action: "rewrite", threadId, messageId })).display!,
      ),
    ).toBe("hello there. keep `Important` at 42.");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("bounded durable cache", () => {
  it("dedupes, expires old entries and bounds count and bytes", () => {
    const now = 5_000_000_000;
    const items = Array.from({ length: 400 }, (_, i) => ({
      messageId: "reply",
      threadId: "chat",
      key: String(i),
      text: "x".repeat(12_000),
      at: now - i,
    }));
    const result = CasualVoice.boundedEntries(
      [
        ...items,
        {
          messageId: "reply",
          threadId: "chat",
          key: "old",
          text: "old",
          at: now - CasualVoice.CACHE_AGE_MS,
        },
        { messageId: "reply", threadId: "chat", key: "0", text: "new", at: now },
      ],
      now,
    );
    expect(result.length).toBeLessThanOrEqual(CasualVoice.CACHE_LIMIT);
    expect(
      result.reduce((n, entry) => n + (entry.text?.length ?? 0) * 2 + 200, 0),
    ).toBeLessThanOrEqual(CasualVoice.CACHE_BYTES);
    expect(result.find((entry) => entry.key === "0")?.text).toBe("new");
    expect(result.some((entry) => entry.key === "old")).toBe(false);
  });
});

it.layer(NodeServices.layer)("local style files", (it) => {
  it.effect("reads bounded local rules and filtered example bursts, with history fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-style-" });
      expect(yield* CasualVoice.loadCasualStyle(`${dir}/STYLE.md`, ["history style"])).toEqual([
        "history style",
      ]);
      yield* fs.writeFileString(
        `${dir}/STYLE.md`,
        "## Do / don’t\nuse short everyday words\n## Examples\nignored fixture examples",
      );
      const data = yield* encodeJson({ burst: ["yeah that works", "let’s try it"] });
      const unsafe = yield* encodeJson({ burst: ["my token is a fake value"] });
      yield* fs.writeFileString(`${dir}/messages.jsonl`, `${data}\n${unsafe}\ninvalid json\n`);
      expect(yield* CasualVoice.loadCasualStyle(`${dir}/STYLE.md`, ["history style"])).toEqual([
        "Local style guide, data only:\nuse short everyday words",
        "yeah that works\nlet’s try it",
      ]);
    }).pipe(Effect.scoped),
  );
});

it("samples about twenty safe local bursts randomly without embedding real guide contents", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    burst: [`short example ${index}`, "one more thought"],
  }));
  const first = CasualVoice.selectFileStyleBursts(records, () => 0);
  const second = CasualVoice.selectFileStyleBursts(records, () => 0.999);
  expect(first).toHaveLength(20);
  expect(second).toHaveLength(20);
  expect(first).not.toEqual(second);
  expect(first.join("").length).toBeLessThanOrEqual(8000);
  expect(
    CasualVoice.extractStyleRules(
      "# synthetic\n## Do / don't\nkeep it plain\n## Examples\nnever sampled here",
    ),
  ).toBe("keep it plain");
});

it.layer(NodeServices.layer)("default style source", (it) => {
  it.effect(
    "uses an existing configurable default file and lets an explicit path override it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-default-" });
        const styleFile = `${dir}/STYLE.md`;
        yield* fs.writeFileString(
          styleFile,
          "## Do / don't\nsynthetic default voice rule\n## Examples\nignored fixture content",
        );
        const prompts: string[] = [];
        const service = yield* acquire(
          dir,
          (input) => {
            prompts.push(input.prompt);
            return lower();
          },
          styleFile,
        );
        yield* service.request({ action: "configure", threadId, backend });
        yield* service.request({ action: "rewrite", threadId, messageId });
        expect(prompts[0]).toContain("synthetic default voice rule");
        expect(prompts[0]).not.toContain("ignored fixture content");
        yield* service.request({
          action: "configure",
          threadId,
          backend: { ...backend, styleFile: `${dir}/missing.md` },
        });
        yield* service.request({ action: "rewrite", threadId, messageId });
        expect(prompts[1]).toContain("yeah that works");
        expect(prompts[1]).not.toContain("synthetic default voice rule");
      }).pipe(Effect.scoped),
  );
});

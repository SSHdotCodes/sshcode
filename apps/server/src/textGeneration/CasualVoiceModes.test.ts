import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  MessageId,
  ThreadId,
  RunId,
  TurnItemId,
  ProviderInstanceId,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { segmentCasualMessage } from "@t3tools/shared/casualVoice";
import * as CasualVoice from "./CasualVoice.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Config from "../config.ts";

const threadId = ThreadId.make("voice-chat");
const messageId = MessageId.make("reply");
const pathMessageId = MessageId.make("path-reply");
const badMessageId = MessageId.make("bad-reply");
const instanceId = ProviderInstanceId.make("fake-provider");
const original = "Hello There. Keep `Important` At 42.";
const pathOriginal = "Look at /tmp/secret-voice-path.ts now.";
const thinkingLevel = {
  id: "thinkingLevel",
  label: "Thinking level",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
  ],
};
const defaultOnly = {
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};
const providerBackend = {
  kind: "provider" as const,
  modelSelection: { instanceId, model: "test-model" },
};
const catalog = [
  {
    instanceId,
    displayName: "Test provider",
    enabled: true,
    models: [
      { slug: "test-model", name: "Test model" },
      {
        slug: "effort-model",
        name: "Effort model",
        capabilities: { optionDescriptors: [thinkingLevel] },
      },
      {
        slug: "default-model",
        name: "Default model",
        capabilities: { optionDescriptors: [defaultOnly] },
      },
      { slug: "plain-model", name: "Plain model", capabilities: { optionDescriptors: [] } },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;
const messages = [
  { id: messageId, role: "assistant", text: original, streaming: false },
  { id: pathMessageId, role: "assistant", text: pathOriginal, streaming: false },
  { id: badMessageId, role: "assistant", text: "Hello there.", streaming: false },
  { id: MessageId.make("user"), role: "user", text: "yeah that works" },
];
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
  text: "Check the style rule again.",
  inputIntent: "steer",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
};
const records = {
  messages: [
    ...messages,
    { id: steerMessageId, role: "user", runId: steerRunId, text: steerItem.text },
  ],
  turnItems: [
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
  ],
  runs: [{ id: steerRunId, status: "completed" }],
} as unknown as OrchestrationV2ThreadProjection;
const decisions = (text: string, role: "final" | "update" = "final") => {
  const source = segmentCasualMessage(text, role);
  return source.input.segments
    .map(
      (segment) =>
        `${segment.id} say: ${segment.text
          .split(/(⟦[CBPUN]\d+⟧)/)
          .map((part) => (/^⟦[CBPUN]\d+⟧$/.test(part) ? part : part.toLowerCase()))
          .join("")}`,
    )
    .join("\n");
};
type Rewrite = NonNullable<ProviderInstance["textGeneration"]["rewriteProse"]>;
function acquire(stateDir: string, rewrite: Rewrite, rows = records) {
  return Effect.map(
    Layer.build(
      CasualVoice.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CasualVoice.DefaultStyleFile, null),
            Config.layerTest(import.meta.dirname, stateDir),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(catalog),
            }),
            Layer.mock(TextGeneration.TextGeneration)({ rewriteProse: rewrite }),
            Layer.mock(Threads.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(rows),
              getThreadSnapshotWindow: () =>
                Effect.succeed({ projection: rows, snapshotSequence: 0, schemaVersion: 1 }),
            }),
          ),
        ),
      ),
    ),
    (context) => Context.get(context, CasualVoice.CasualVoice),
  );
}
const localBackend = (url: string, styleFile: string) => ({
  kind: "local" as const,
  url,
  model: "local-model",
  styleFile,
});
const cloudBackend = (model: string, styleFile?: string) => ({
  kind: "provider" as const,
  ...(styleFile === undefined ? {} : { styleFile }),
  modelSelection: { instanceId, model },
});
const discordBits = ["use the secret style rule", "unique jsonl burst", "yeah that works"];
function localPost(body: unknown) {
  const record = body && typeof body === "object" ? body : {};
  const model = "model" in record && typeof record.model === "string" ? record.model : undefined;
  const messages = "messages" in record && Array.isArray(record.messages) ? record.messages : [];
  const first = messages[0];
  const content =
    first && typeof first === "object" && "content" in first && typeof first.content === "string"
      ? first.content
      : "";
  return { model, content };
}
const steerRequest = {
  action: "rewrite" as const,
  threadId,
  messageId: steerMessageId,
  reasoningItemId: TurnItemId.make("reasoning-one"),
};

describe("casual voice routing", () => {
  const local = { kind: "local" as const, url: "http://127.0.0.1:9/v1/", model: "local-model" };
  const cloud = cloudBackend("cloud-model");
  it("sends each mode and source to the backend that should see it", () => {
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "local" },
        "message",
      ),
    ).toEqual({
      backend: local,
      omitExamples: false,
      mode: "local",
    });
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "local" },
        "reasoning",
      ),
    ).toEqual({
      backend: local,
      omitExamples: false,
      mode: "local",
    });
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "hybrid" },
        "message",
      ),
    ).toEqual({
      backend: local,
      omitExamples: false,
      mode: "hybrid",
    });
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "hybrid" },
        "reasoning",
      ),
    ).toEqual({
      backend: cloud,
      omitExamples: true,
      mode: "hybrid",
    });
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "cloud" },
        "message",
      ),
    ).toEqual({
      backend: cloud,
      omitExamples: false,
      mode: "cloud",
    });
    expect(
      CasualVoice.routeCasualVoice(
        { backend: local, cloudBackend: cloud, mode: "cloud" },
        "reasoning",
      ),
    ).toEqual({
      backend: cloud,
      omitExamples: false,
      mode: "cloud",
    });
    expect(
      CasualVoice.routeCasualVoice({ backend: local, cloudBackend: cloud }, "reasoning"),
    ).toMatchObject({
      backend: cloud,
      omitExamples: true,
      mode: "hybrid",
    });
    expect(CasualVoice.routeCasualVoice({ backend: cloud }, "message")).toMatchObject({
      backend: cloud,
      omitExamples: false,
      mode: "cloud",
    });
    expect(CasualVoice.routeCasualVoice({ backend: local }, "reasoning")).toMatchObject({
      backend: local,
      omitExamples: false,
      mode: "local",
    });
    expect(
      CasualVoice.routeCasualVoice({ backend: null, cloudBackend: cloud }, "message"),
    ).toMatchObject({
      backend: cloud,
      omitExamples: false,
      mode: "cloud",
    });
    expect(
      CasualVoice.routeCasualVoice({ backend: cloud, mode: "local" }, "message").backend,
    ).toBeNull();
    expect(
      CasualVoice.routeCasualVoice({ backend: local, mode: "cloud" }, "reasoning").backend,
    ).toBeNull();
    expect(
      CasualVoice.routeCasualVoice({ backend: local, mode: "hybrid" }, "reasoning").backend,
    ).toBeNull();
    expect(CasualVoice.presentedCasualVoiceMode({ backend: local })).toBe("local");
    expect(CasualVoice.presentedCasualVoiceMode({ backend: cloud })).toBe("cloud");
    expect(CasualVoice.presentedCasualVoiceMode({ backend: local, cloudBackend: cloud })).toBe(
      "hybrid",
    );
    expect(CasualVoice.presentedCasualVoiceMode({ backend: cloud, mode: "local" })).toBe("local");
  });
  it("rotates dataset parts and drops the oldest until the cap fits", () => {
    expect(
      CasualVoice.planDatasetAppend(
        [
          { name: "000001.jsonl", bytes: 100 },
          { name: "000002.jsonl", bytes: 100 },
          { name: "notes.txt", bytes: 9999 },
        ],
        50,
        { fileBytes: 80, totalBytes: 140 },
      ),
    ).toEqual({ file: "000003.jsonl", remove: ["000001.jsonl", "000002.jsonl"] });
    expect(
      CasualVoice.planDatasetAppend([{ name: "000001.jsonl", bytes: 10 }], 20, {
        fileBytes: 80,
        totalBytes: 140,
      }),
    ).toEqual({ file: "000001.jsonl", remove: [] });
    expect(
      CasualVoice.planDatasetAppend(
        [
          { name: "000001.jsonl", bytes: 100 },
          { name: "000002.jsonl", bytes: 30 },
        ],
        20,
        { fileBytes: 80, totalBytes: 60 },
      ),
    ).toEqual({ file: "000002.jsonl", remove: ["000001.jsonl"] });
  });
});

it.layer(NodeServices.layer)("casual voice mode service", (it) => {
  it.effect("routes live rewrites and keeps discord text out of hybrid steer calls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "voice-modes-" });
      const styleDir = `${root}/style`;
      yield* fs.makeDirectory(styleDir);
      yield* fs.writeFileString(
        `${styleDir}/STYLE.md`,
        "## Do / don't\nuse the secret style rule\n",
      );
      yield* fs.writeFileString(
        `${styleDir}/messages.jsonl`,
        `${JSON.stringify({ burst: ["unique jsonl burst"] })}\n`,
      );
      let posted: unknown;
      let output = decisions(original);
      const route = HttpRouter.add(
        "POST",
        "/v1/chat/completions",
        Effect.gen(function* () {
          posted = yield* (yield* HttpServerRequest.HttpServerRequest).json;
          return HttpServerResponse.jsonUnsafe({ choices: [{ message: { content: output } }] });
        }),
      );
      const server = yield* Layer.build(
        HttpRouter.serve(route, { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const address = HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address);
      const local = localBackend(`${address}/v1/`, `${styleDir}/STYLE.md`);
      const cloud = cloudBackend("test-model", `${styleDir}/STYLE.md`);
      const prompts: string[] = [];
      const rewrite: Rewrite = (input) => {
        prompts.push(input.prompt);
        return Effect.succeed({ output });
      };
      const leaked = (text: string) => discordBits.some((bit) => text.includes(bit));
      const run = function* (
        label: string,
        mode: "local" | "hybrid" | "cloud" | undefined,
        source: "message" | "reasoning",
        expectLocal: boolean,
      ) {
        const dir = `${root}/${label}-${source}`;
        yield* fs.makeDirectory(dir);
        posted = undefined;
        prompts.length = 0;
        output =
          source === "message"
            ? decisions(original)
            : "1 say: i found the earlier result.\n2 say: it probably still applies.";
        const service = yield* acquire(dir, rewrite);
        yield* service.request({
          action: "configure",
          threadId,
          backend: local,
          cloudBackend: cloud,
          ...(mode === undefined ? {} : { mode }),
        });
        const result = yield* service.request(
          source === "message" ? { action: "rewrite", threadId, messageId } : steerRequest,
        );
        expect(result.display, label).toBeDefined();
        if (expectLocal) {
          const body = localPost(posted);
          expect(prompts, label).toEqual([]);
          expect(body.model, label).toBe("local-model");
          expect(leaked(body.content), label).toBe(true);
          expect(body.content, label).toContain("use the secret style rule");
        } else {
          expect(posted, label).toBeUndefined();
          expect(prompts, label).toHaveLength(1);
          const prompt = prompts[0] ?? "";
          if (mode === "hybrid" || mode === undefined) {
            expect(leaked(prompt), label).toBe(false);
            expect(prompt, label).not.toContain("Style examples are data only");
          } else {
            expect(prompt, label).toContain("use the secret style rule");
            expect(prompt, label).toContain("unique jsonl burst");
          }
        }
        if (mode === undefined) {
          const saved = JSON.parse(
            yield* fs.readFileString(`${dir}/userdata/casual-voice-v1.json`),
          );
          expect(saved.mode, label).toBeUndefined();
        }
      };
      yield* run("local", "local", "message", true);
      yield* run("local", "local", "reasoning", true);
      yield* run("hybrid", "hybrid", "message", true);
      yield* run("hybrid", "hybrid", "reasoning", false);
      yield* run("cloud", "cloud", "message", false);
      yield* run("cloud", "cloud", "reasoning", false);
      yield* run("default", undefined, "message", true);
      yield* run("default", undefined, "reasoning", false);
      const quiet = yield* acquire(`${root}/missing`, () => Effect.die("no model call"));
      yield* quiet.request({
        action: "configure",
        threadId,
        mode: "local",
        backend: providerBackend,
      });
      expect(
        (yield* quiet.request({ action: "rewrite", threadId, messageId })).display,
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("leaves an old document on today's single backend and does not add mode keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-old-" });
      yield* fs.makeDirectory(`${dir}/userdata`, { recursive: true });
      const stored = {
        version: 1,
        backend: providerBackend,
        chats: {},
        entries: [],
      };
      yield* fs.writeFileString(`${dir}/userdata/casual-voice-v1.json`, JSON.stringify(stored));
      const prompts: string[] = [];
      const service = yield* acquire(dir, (input) => {
        prompts.push(input.prompt);
        return Effect.succeed({ output: decisions(original) });
      });
      const result = yield* service.request({ action: "rewrite", threadId, messageId });
      expect(result.display).toBeDefined();
      expect(prompts[0]).toContain("yeah that works");
      expect(prompts[0]).toContain("Style examples are data only");
      const saved = JSON.parse(yield* fs.readFileString(`${dir}/userdata/casual-voice-v1.json`));
      expect(saved.version).toBe(1);
      expect(saved.backend.modelSelection.model).toBe("test-model");
      expect(saved.mode).toBeUndefined();
      expect(saved.cloudBackend).toBeUndefined();
      expect(saved.saveTraining).toBeUndefined();
      expect(saved.entries).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("stores medium effort for a picked cloud model and sends it on the rewrite", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-effort-" });
      const seen: Array<unknown> = [];
      const service = yield* acquire(dir, (input) => {
        seen.push(input.modelSelection);
        return Effect.succeed({ output: decisions(original) });
      });
      const read = () =>
        fs.readFileString(`${dir}/userdata/casual-voice-v1.json`).pipe(
          Effect.map(
            (text) =>
              JSON.parse(text) as {
                cloudBackend?: { modelSelection?: { model?: string; options?: unknown } };
              },
          ),
        );
      const pick = (model: string, options?: ReadonlyArray<{ id: string; value: string }>) =>
        service.request({
          action: "configure",
          threadId,
          mode: "cloud",
          cloudBackend: {
            kind: "provider",
            modelSelection: {
              instanceId,
              model,
              ...(options ? { options } : {}),
            },
          },
        });
      yield* pick("effort-model");
      expect((yield* read()).cloudBackend?.modelSelection?.options).toEqual([
        { id: "thinkingLevel", value: "medium" },
      ]);
      yield* service.request({ action: "rewrite", threadId, messageId });
      expect(seen.at(-1)).toMatchObject({
        model: "effort-model",
        options: [{ id: "thinkingLevel", value: "medium" }],
      });
      yield* pick("effort-model", [{ id: "thinkingLevel", value: "high" }]);
      expect((yield* read()).cloudBackend?.modelSelection?.options).toEqual([
        { id: "thinkingLevel", value: "high" },
      ]);
      yield* service.request({ action: "rewrite", threadId, messageId });
      expect(seen.at(-1)).toMatchObject({ options: [{ id: "thinkingLevel", value: "high" }] });
      yield* pick("default-model");
      expect((yield* read()).cloudBackend?.modelSelection?.options).toEqual([
        { id: "reasoningEffort", value: "high" },
      ]);
      yield* pick("plain-model");
      expect((yield* read()).cloudBackend?.modelSelection?.options).toBeUndefined();
      yield* service.request({ action: "rewrite", threadId, messageId });
      expect(seen.at(-1)).toMatchObject({ model: "plain-model" });
      expect((seen.at(-1) as { options?: unknown }).options).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a private cloud dataset with feedback, a cap, and a training switch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-dataset-" });
      let output = decisions(pathOriginal);
      const service = yield* acquire(dir, () => Effect.succeed({ output }));
      yield* service.request({
        action: "configure",
        threadId,
        mode: "cloud",
        backend: null,
        cloudBackend: cloudBackend("test-model"),
      });
      const accepted = yield* service.request({
        action: "rewrite",
        threadId,
        messageId: pathMessageId,
      });
      output = "not a decision";
      yield* service.request({ action: "rewrite", threadId, messageId: badMessageId });
      yield* service.request({ action: "rewrite", threadId, messageId: pathMessageId });
      expect(accepted.inputHash).toMatch(/^[0-9a-f]{64}$/);
      yield* service.request({ action: "feedback", threadId, inputHash: accepted.inputHash! });
      const dataset = `${dir}/userdata/${CasualVoice.DATASET_DIRECTORY}`;
      expect((yield* fs.stat(dataset)).mode & 0o777).toBe(0o700);
      const file = `${dataset}/000001.jsonl`;
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      const lines = (yield* fs.readFileString(file))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(3);
      const [kept, rejected, feedback] = lines;
      expect(Object.keys(kept).sort()).toEqual([
        "at",
        "input",
        "kind",
        "mode",
        "model",
        "output",
        "provider",
        "verdict",
      ]);
      expect(kept).toMatchObject({
        kind: "rewrite",
        mode: "cloud",
        provider: instanceId,
        model: "test-model",
        verdict: { accepted: true },
      });
      expect(kept.output).toContain("⟦P");
      expect(kept.input).toContain("⟦P");
      expect(kept.input).not.toContain("secret-voice-path");
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(kept.input));
      const hashed = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      expect(hashed).toBe(accepted.inputHash);
      expect(rejected.verdict.accepted).toBe(false);
      expect(typeof rejected.verdict.reason).toBe("string");
      expect(rejected.output).toBe("not a decision");
      expect(feedback).toMatchObject({
        kind: "feedback",
        event: "show-original",
        inputHash: accepted.inputHash,
        mode: "cloud",
        provider: instanceId,
        model: "test-model",
      });
      expect(JSON.stringify(feedback)).not.toContain("Look");
      expect(JSON.stringify(feedback)).not.toContain("secret-voice-path");
      expect(yield* fs.readFileString(file)).not.toContain("secret-voice-path");

      const offDir = yield* fs.makeTempDirectoryScoped({ prefix: "voice-dataset-off-" });
      const off = yield* acquire(offDir, () => Effect.succeed({ output: decisions(original) }));
      yield* off.request({
        action: "configure",
        threadId,
        mode: "cloud",
        cloudBackend: cloudBackend("test-model"),
        saveTraining: false,
      });
      const hidden = yield* off.request({ action: "rewrite", threadId, messageId });
      expect(hidden.inputHash).toBeUndefined();
      yield* off.request({ action: "feedback", threadId, inputHash: "ab".repeat(32) });
      expect(yield* fs.exists(`${offDir}/userdata/${CasualVoice.DATASET_DIRECTORY}`)).toBe(false);

      const scratch = `${dir}/scratch`;
      yield* fs.makeDirectory(scratch);
      const limits = { fileBytes: 1, totalBytes: 180 };
      for (let index = 0; index < 8; index++)
        yield* CasualVoice.appendCasualDataset(
          scratch,
          { kind: "rewrite", index, pad: "x".repeat(30) },
          limits,
        );
      const names = (yield* fs.readDirectory(`${scratch}/${CasualVoice.DATASET_DIRECTORY}`))
        .filter((name) => name.endsWith(".jsonl"))
        .toSorted();
      expect(names.length).toBeGreaterThan(1);
      expect(names).not.toContain("000001.jsonl");
      const bytes = yield* Effect.forEach(
        names,
        (name) =>
          fs
            .stat(`${scratch}/${CasualVoice.DATASET_DIRECTORY}/${name}`)
            .pipe(Effect.map((stat) => Number(stat.size))),
        { concurrency: 1 },
      );
      expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(limits.totalBytes);
    }).pipe(Effect.scoped),
  );

  it.effect("follows a steer's parsed decision when the wording guard rejects it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "voice-decision-" });
      const run = function* (
        name: string,
        output: string,
        request:
          | typeof steerRequest
          | { action: "rewrite"; threadId: typeof threadId; messageId: MessageId },
      ) {
        let calls = 0;
        const service = yield* acquire(`${root}/${name}`, () => {
          calls++;
          return Effect.succeed({ output });
        });
        yield* service.request({
          action: "configure",
          threadId,
          mode: "cloud",
          cloudBackend: cloudBackend("test-model"),
        });
        const first = yield* service.request(request);
        const second = yield* service.request(request);
        const line = JSON.parse(
          (yield* fs.readFileString(
            `${root}/${name}/userdata/${CasualVoice.DATASET_DIRECTORY}/000001.jsonl`,
          ))
            .trim()
            .split("\n")[0]!,
        );
        return { first, second, calls, line };
      };
      const sent = yield* run(
        "send",
        "1 say: I found the earlier result.\n2 hide: filler",
        steerRequest,
      );
      expect(sent.first.display).toBeUndefined();
      expect(sent.first.decision).toEqual({ kind: "send", segments: [1] });
      expect(sent.second.decision).toEqual(sent.first.decision);
      expect(sent.calls).toBe(1);
      expect(sent.line).toMatchObject({
        verdict: { accepted: false, reason: "case" },
        decision: { kind: "send", segments: [1] },
      });
      const quiet = yield* run("quiet", "1 status: Checking now.\n2 hide: filler", steerRequest);
      expect(quiet.first.display).toBeUndefined();
      expect(quiet.first.decision).toEqual({ kind: "quiet" });
      expect(quiet.line.decision).toEqual({ kind: "quiet" });
      const broken = yield* run("broken", "not a decision", steerRequest);
      expect(broken.first.display).toBeUndefined();
      expect(broken.first.decision).toBeUndefined();
      expect(broken.line.decision).toBeUndefined();
      expect(broken.line.verdict.accepted).toBe(false);
      const kept = yield* run("message", decisions("Hello there."), {
        action: "rewrite",
        threadId,
        messageId: badMessageId,
      });
      expect(kept.first.display).toBeDefined();
      expect(kept.first.decision).toBeUndefined();
      const guarded = yield* run("message-guard", "1 say: Hello There.", {
        action: "rewrite",
        threadId,
        messageId: badMessageId,
      });
      expect(guarded.first.display).toBeUndefined();
      expect(guarded.first.decision).toBeUndefined();
      expect(guarded.line.decision).toBeUndefined();
      expect(guarded.line.verdict).toMatchObject({ accepted: false });
    }).pipe(Effect.scoped),
  );
});

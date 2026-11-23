// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UsageDay,
  type UsageSource,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import { totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as UsageService from "./UsageService.ts";
import { aggregateThreadUsage } from "./threadUsageAggregation.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: NodePath.join(home, "claude") },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
        },
      },
    },
  };
});

const layerCursorUsageAccounts = <E, R>(
  reader: Layer.Layer<CursorAccountReader.CursorAccountReader, E, R>,
) => Layer.fresh(CursorUsageAccounts.layer).pipe(Layer.provide(reader));

/**
 * A service with its own Cursor account caches over `read`, as a fresh server
 * process has. `awaitPersisted` also waits for the account cache writes.
 */
const makeWithCursor = (read: CursorAccountReader.CursorAccountReader["Service"]["read"]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layerCursorUsageAccounts(Layer.succeed(CursorAccountReader.CursorAccountReader, { read })),
    );
    const accounts = Context.get(context, CursorUsageAccounts.CursorUsageAccounts);
    const service = yield* UsageService.make.pipe(Effect.provideContext(context));
    return {
      ...service,
      awaitPersisted: Effect.andThen(service.awaitPersisted, accounts.awaitPersisted),
    };
  });

const layerService = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}) =>
  layerCursorUsageAccounts(
    CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer)),
  ).pipe(
    Layer.provideMerge(AntigravityUsage.layer),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), NodePath.join(input.home, input.prefix)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, input.platform ?? "linux")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
        PI_CODING_AGENT_DIR: NodePath.join(input.home, "pi"),
        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(input.home, "antigravity"),
        VIBE_HOME: NodePath.join(input.home, "vibe"),
        XDG_DATA_HOME: NodePath.join(input.home, "data"),
        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

/** Outside `NARROW_WINDOW`, inside `WINDOW`. Seconds, as `utimes` takes them. */
const BEFORE_NARROW_WINDOW = Date.parse("2026-08-01T10:00:00Z") / 1000;
const NARROW_WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
};

/**
 * A FIFO named like a transcript. A scan's read of it waits in `open` until
 * `openGate`, then fails at once, so a gate holds that scan's directory reads
 * in flight. Each waiting gate holds one libuv pool thread; keep at most three.
 */
const makeGate = (path: string, lastWriteSeconds?: number) =>
  Effect.promise(async () => {
    NodeChildProcess.execFileSync("mkfifo", [path]);
    if (lastWriteSeconds !== undefined) {
      await NodeFSP.utimes(path, lastWriteSeconds, lastWriteSeconds);
    }
  });

/**
 * Returns once a scan has opened the gate. A scan opens every file of a
 * directory at once, so it then holds the directory's transcripts open too.
 */
const openGate = (path: string) =>
  Effect.promise(async () => (await NodeFSP.open(path, "w")).close());

/** Replaces a file by rename, so a scan holding the old one keeps reading it. */
const replaceFile = (path: string, content: string) =>
  Effect.promise(async () => {
    await NodeFSP.writeFile(path + ".next", content);
    await NodeFSP.rename(path + ".next", path);
  });

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

/** Inside `WINDOW`: the time Cursor tests run at. */
const CURSOR_NOW = Date.parse("2026-08-02T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
/** The service's cache retention, which the Cursor account cache always covers. */
const CURSOR_RETENTION_MS = 92 * 24 * HOUR_MS;

/**
 * Stands in for Cursor's dashboard API. Each read returns the account's events
 * in its range, keyed like the real reader: occurrences count within one read.
 * While `gate` is set, reads wait for it.
 */
function makeFakeCursor() {
  const state = {
    accountKey: "account-a",
    events: [] as { readonly timestampMs: number; readonly outputTokens: number }[],
    error: null as string | null,
    gate: undefined as Deferred.Deferred<void> | undefined,
    calls: [] as { readonly sinceMs: number; readonly untilMs: number }[],
  };
  const read = (_credential: unknown, sinceMs: number, untilMs: number) =>
    Effect.gen(function* () {
      state.calls.push({ sinceMs, untilMs });
      if (state.gate !== undefined) yield* Deferred.await(state.gate);
      const { accountKey, error } = state;
      if (error !== null) return { accountKey, records: [], missing: false, error };
      const occurrences = new Map<string, number>();
      const records = state.events
        .filter(({ timestampMs }) => timestampMs >= sinceMs && timestampMs <= untilMs)
        .map(({ timestampMs, outputTokens }): UsageRecord => {
          const key = `${timestampMs}:${outputTokens}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          return {
            provider: "cursor",
            timestampMs,
            model: "claude-fable-5",
            sessionId: "conversation-1",
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens,
              reasoningTokens: 0,
            },
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
          };
        });
      return { accountKey, records, missing: false, error: null };
    });
  return { state, read };
}

const writeCursorLogin = (home: string) =>
  Effect.promise(async () => {
    const authPath = NodePath.join(home, "config", "cursor", "auth.json");
    await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
    await NodeFSP.writeFile(authPath, "{}");
  });

function cursorSource(summary: { readonly sources: readonly UsageSource[] }) {
  return summary.sources.find((source) => source.fingerprint.provider === "cursor");
}

describe("UsageService", () => {
  it.live("splits shared Claude history by the account on each historical run", () =>
    Effect.gen(function* () {
      const { home, transcript, settings } = yield* setup;
      const secondHome = NodePath.join(home, "claude-second");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(secondHome);
        await NodeFSP.symlink(
          NodePath.join(home, "claude", "projects"),
          NodePath.join(secondHome, "projects"),
        );
        const line = (id: number, output: number, session: string, hour: string) =>
          JSON.stringify({
            type: "assistant",
            requestId: `req_${id}`,
            sessionId: session,
            message: {
              id: `msg_${id}`,
              model: "claude-fable-5",
              usage: { input_tokens: 10, output_tokens: output },
            },
            timestamp: `2026-08-01T${hour}:00:00Z`,
            costUSD: output,
          }) + "\n";
        await NodeFSP.writeFile(
          transcript,
          [
            line(1, 10, "shared", "09"),
            line(2, 20, "shared", "11"),
            line(3, 30, "second-only", "11"),
            line(4, 40, "outside-app", "11"),
          ].join(""),
        );
        const writeSidechain = async (session: string, records: string) => {
          const dir = NodePath.join(NodePath.dirname(transcript), session, "subagents");
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(dir, "agent-child.jsonl"), records);
        };
        await writeSidechain("shared", line(5, 5, "shared", "09") + line(6, 7, "shared", "11"));
        await writeSidechain("second-only", line(7, 4, "second-only", "11"));
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [nativeId, instanceId, hour] of [
          ["shared", "claudeAgent", "08"],
          ["shared", "claude-second", "10"],
          ["second-only", "claude-second", "10"],
        ]) {
          const id = `${nativeId}-${instanceId}`;
          const startedAt = `2026-08-01T${hour}:00:00Z`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, provider, provider_instance_id, status, updated_at, payload_json)
          VALUES (${id}, 'claudeAgent', ${instanceId}, 'ready', ${startedAt},
          ${JSON.stringify({ nativeThreadRef: { nativeId: nativeId === "shared" ? "later-native-session" : nativeId }, createdAt: startedAt })})`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, payload_json)
          VALUES (${id}, ${id}, 1, 'claudeAgent', ${instanceId}, ${id}, 'completed', ${startedAt},
          ${JSON.stringify({ startedAt })})`;
          if (nativeId === "shared") {
            // A provider thread's current ref can change after resume. Attempts
            // retain both the account and native session that actually ran.
            yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
              (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, provider_instance_id, status, payload_json)
              VALUES (${id}, ${id}, ${id}, 1, ${id}, 'claudeAgent', ${id}, ${instanceId}, 'completed',
                ${JSON.stringify({ nativeThreadId: nativeId, startedAt })})`;
          }
        }
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        const merged = mergeUsage(
          [{ environmentId: EnvironmentId.make("test"), label: "Test", summary }],
          USAGE_CONTRACT_VERSION,
        );
        assert.strictEqual(merged.costUsd, 116);
        assert.deepStrictEqual(
          Object.fromEntries(
            merged.instances.map((instance) => [instance.instanceId, instance.costUsd]),
          ),
          { claudeAgent: 62, "claude-second": 54 },
        );
        assert.strictEqual(
          summary.sources.filter((source) => source.fingerprint.provider === "claude").length,
          1,
        );
        const threadId = ThreadId.make("second-only-claude-second");
        const instanceId = ProviderInstanceId.make("claude-second");
        const usage = aggregateThreadUsage({
          ...(yield* service.readThreadRecords),
          threadId,
          bindings: [
            {
              threadId,
              instanceId,
              title: "Second account",
              sessionId: "second-only",
              parentThreadId: null,
            },
          ],
          accountInstanceIds: [instanceId],
          timeZone: "UTC",
          now: CURSOR_NOW,
          weeklyStartMs: Date.parse("2026-08-01T00:00:00Z"),
          weeklyEndMs: CURSOR_NOW,
        });
        assert.strictEqual(usage.allTime.tokens.outputTokens, 34);
        assert.strictEqual(usage.allTime.costUsd, 34);
        assert.strictEqual(usage.subagentRuns, 1);
        assert.strictEqual(usage.weeklyShare?.percent, (100 * 34) / 54);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-shared-accounts",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claude-second")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: secondHome },
                  displayName: "Max 2",
                },
              },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refetches cached rates early for a model they do not list", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-02T00:00:00Z"));
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeLine(1, 5, "claude-new-model") + claudeLine(2, 5, "claude-unknown-model"),
        ),
      );
      let requests = 0;
      // Read at each fetch, so adding a model here is LiteLLM listing it later.
      const ratesDocument: Record<string, unknown> = {
        "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
      };
      const serviceLayer = layerService({
        prefix: "usage-service-unlisted-model-test",
        home,
        settings,
        onRatesFetch: () => requests++,
        ratesDocument,
      });
      const newModelCost = (summary: {
        readonly buckets: ReadonlyArray<{ readonly model: string; readonly costUsd: number }>;
      }) => summary.buckets.find((bucket) => bucket.model === "claude-new-model")?.costUsd;

      // Rates fetched for this scan are fresh: no second request for the models they lack.
      const first = yield* (yield* UsageService.make.pipe(
        Effect.provide(serviceLayer),
      )).readSummary(WINDOW);
      assert.strictEqual(newModelCost(first), 0);
      assert.strictEqual(requests, 1);

      // An hour later LiteLLM lists the new model; a restarted server starts from the cached table.
      ratesDocument["claude-new-model"] = {
        input_cost_per_token: 2e-5,
        output_cost_per_token: 1e-4,
      };
      yield* TestClock.adjust(Duration.hours(1));
      const service = yield* UsageService.make.pipe(Effect.provide(serviceLayer));
      const refreshed = yield* service.readSummary(WINDOW);
      assert.strictEqual(refreshed.pricing.status, "fresh");
      assert.closeTo(newModelCost(refreshed) ?? -1, 10 * 2e-5 + 5 * 1e-4, 1e-12);
      assert.strictEqual(requests, 2);

      // A model the fresh table still lacks does not refetch again before the TTL.
      yield* TestClock.adjust(Duration.hours(1));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(requests, 2);
    }).pipe(Effect.scoped),
  );

  it.live("includes keep-warm tokens under a distinct source across scans and restarts", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const dir = NodePath.join(config.stateDir, "claude-keep-warm");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "usage.jsonl"),
            encodeUnknownJsonString({
              type: "assistant",
              timestamp: "2026-08-01T10:00:00Z",
              sessionId: "keep-warm:test",
              message: {
                id: "warm-1",
                model: "claude-sonnet-4-6",
                usage: {
                  input_tokens: 2,
                  cache_read_input_tokens: 120000,
                  cache_creation_input_tokens: 500,
                  output_tokens: 1,
                },
              },
            }) + "\n",
          );
        });
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        const source = first.sources.find((item) => item.displayName === "Claude keep-warm");
        assert.isDefined(source);
        assert.equal(
          first.buckets.reduce((total, bucket) => total + totalTokens(bucket.totals), 0),
          120503,
        );
        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        const again = yield* restarted.readSummary(WINDOW);
        assert.deepEqual(again.buckets, first.buckets);
        assert.equal(
          again.sources.find((item) => item.displayName === "Claude keep-warm")?.distinctSessions,
          1,
        );
      }).pipe(Effect.provide(layerService({ prefix: "keep-warm-usage", home, settings })));
    }).pipe(Effect.scoped),
  );

  it.live(
    "attributes scoped registry history to named instances through warm scans and restarts",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const instances = [
          {
            id: "qwen-custom",
            agentId: "qwen-code",
            name: "Qwen4 · Qwen Code",
            variable: "QWEN_HOME",
            directory: "qwen",
            file: "projects/project/chats/session.jsonl",
            entry: {
              type: "assistant",
              uuid: "qwen-request",
              sessionId: "qwen-session",
              timestamp: "2026-08-01T10:00:00Z",
              model: "unknown-model",
              usageMetadata: {
                promptTokenCount: 100,
                cachedContentTokenCount: 70,
                candidatesTokenCount: 10,
                thoughtsTokenCount: 5,
              },
            },
          },
          ...["one", "two"].map((suffix) => ({
            id: `kimi-${suffix}`,
            agentId: "kimi",
            name: `Kimi ${suffix}`,
            variable: "KIMI_SHARE_DIR",
            directory: `kimi-${suffix}`,
            file: `sessions/project/session-${suffix}/agents/main/wire.jsonl`,
            entry: {
              type: "usage.record",
              agentId: "main",
              model: "kimi-model",
              time: Date.parse("2026-08-01T11:00:00Z"),
              usage: { inputOther: 10, inputCacheRead: 20, output: 5 },
            },
          })),
        ];
        for (const instance of instances) {
          const file = NodePath.join(home, instance.directory, instance.file);
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
            await NodeFSP.writeFile(file, encodeUnknownJsonString(instance.entry) + "\n");
          });
        }
        const namedSettings = {
          ...settings,
          providerInstances: {
            ...settings.providerInstances,
            ...Object.fromEntries(
              instances.map((instance) => [
                instance.id,
                {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  displayName: instance.name,
                  config: { agentId: instance.agentId },
                  environment: [
                    {
                      name: instance.variable,
                      value: NodePath.join(home, instance.directory),
                      sensitive: false,
                    },
                  ],
                },
              ]),
            ),
          },
        };
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          const registry = first.sources.filter(
            (source) =>
              source.fingerprint.provider === "kimi" || source.fingerprint.provider === "qwen-code",
          );
          assert.deepStrictEqual(
            registry.map((source) => [
              source.instanceId,
              source.displayName,
              source.distinctSessions,
            ]),
            [
              ["qwen-custom", "Qwen4 · Qwen Code", 1],
              ["kimi-one", "Kimi one", 1],
              ["kimi-two", "Kimi two", 1],
            ],
          );
          assert.strictEqual(
            first.sources.some((source) => source.fingerprint.provider === "vibe"),
            false,
          );
          const buckets = first.buckets.filter(
            (bucket) => bucket.provider === "kimi" || bucket.provider === "qwen-code",
          );
          assert.strictEqual(
            buckets.reduce((sum, bucket) => sum + totalTokens(bucket.totals), 0),
            185,
          );
          assert.strictEqual(
            buckets.every((bucket) => bucket.costSource === "unpriced"),
            true,
          );
          assert.strictEqual(
            buckets.every((bucket) => bucket.sourcePath !== undefined),
            true,
          );
          const warm = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(warm.buckets, first.buckets);
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          const restored = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, first.buckets);
          assert.deepStrictEqual(
            restored.sources.filter(
              (source) =>
                source.instanceId?.startsWith("kimi-") || source.instanceId === "qwen-custom",
            ),
            registry,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({ prefix: "usage-registry-named", home, settings: namedSettings }),
          ),
        );
      }).pipe(Effect.scoped),
  );
  it.live(
    "reads Pi per-model usage and auxiliary costs once across forks and repeated entries",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, "pi", "sessions", "project");
        const usage = {
          input: 10,
          output: 5,
          cacheRead: 20,
          cacheWrite: 3,
          reasoning: 2,
          totalTokens: 38,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        };
        const parent = {
          type: "message",
          id: "a123abcd",
          parentId: null,
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "requested-model",
            responseModel: "actual-model",
            usage,
          },
        };
        const auxiliary = [
          {
            type: "message",
            id: "tool",
            message: { role: "toolResult", toolName: "classify", usage },
          },
          {
            type: "message",
            id: "image",
            message: {
              role: "toolResult",
              toolName: "image",
              usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
          { type: "compaction", id: "compact", usage },
          { type: "branch_summary", id: "summary", usage },
        ].map((entry) => ({ ...entry, timestamp: "2026-08-01T11:00:00Z" }));
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "parent.jsonl"),
            [
              { type: "session", id: "parent" },
              parent,
              ...auxiliary,
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T12:00:00Z",
                kind: "cache_warm",
                provider: "openai",
                model: "actual-model",
                usage: { ...usage, cost: { ...usage.cost, total: 0 } },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(dir, "fork.jsonl"),
            [
              { type: "session", id: "fork", parentSession: NodePath.join(dir, "parent.jsonl") },
              { ...parent, parentId: "relinked" },
              parent,
              ...auxiliary,
              {
                ...parent,
                timestamp: "2026-08-01T13:00:00Z",
                message: { ...parent.message, provider: "openai", responseModel: "another-model" },
              },
              { type: "get_session_stats", usage: { ...usage, cost: { total: 1000 } } },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          const pi = first.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(
            pi.reduce((total, bucket) => total + bucket.costUsd, 0),
            44,
          );
          assert.strictEqual(
            pi.reduce((total, bucket) => total + totalTokens(bucket.totals), 0),
            228,
          );
          assert.deepStrictEqual(pi.map((bucket) => bucket.model).sort(), [
            "Tools/summaries",
            "anthropic/actual-model",
            "openai/actual-model",
            "openai/another-model",
          ]);
          const assistant = pi.find((bucket) => bucket.model === "anthropic/actual-model");
          assert.deepStrictEqual(assistant?.totals, {
            uncachedInputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 20,
            cacheCreationTokens: 3,
            reasoningTokens: 2,
          });
          assert.strictEqual(assistant?.costSource, "providerReported");
          assert.approximately(assistant?.categoryCostUsd?.input ?? NaN, 10 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheRead ?? NaN, 2 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheWrite ?? NaN, 6 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.output ?? NaN, 20 / 38, 1e-6);
          assert.strictEqual(assistant?.cacheSavingsUsd, 18);
          const warm = pi.find((bucket) => bucket.model === "openai/actual-model");
          assert.strictEqual(warm?.costSource, "modelPriced");
          assert.strictEqual(warm?.costUsd, 38);
          assert.deepStrictEqual(warm?.categoryCostUsd, {
            input: 10,
            cacheRead: 2,
            cacheWrite: 6,
            output: 20,
          });
          assert.strictEqual(warm?.cacheSavingsUsd, 18);
          assert.strictEqual(
            first.sources.filter((source) => source.fingerprint.provider === "pi").length,
            1,
          );
          // Warm scans retain header state and only charge appended entries.
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(dir, "fork.jsonl"),
              encodeUnknownJsonString({
                ...parent,
                id: "new",
                timestamp: "2026-08-01T14:00:00Z",
                message: { ...parent.message, responseModel: "latest-model" },
              }) + "\n",
            ),
          );
          const grown = yield* service.readSummary(WINDOW);
          assert.strictEqual(
            grown.buckets
              .filter((bucket) => bucket.provider === "pi")
              .reduce((total, bucket) => total + bucket.costUsd, 0),
            45,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, grown.buckets);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-fork",
              home,
              ratesDocument: {
                "actual-model": {
                  input_cost_per_token: 1,
                  output_cost_per_token: 4,
                  cache_read_input_token_cost: 0.1,
                  cache_creation_input_token_cost: 2,
                },
              },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("pi-extra")]: {
                    driver: ProviderDriverKind.make("pi"),
                    enabled: false,
                    environment: [
                      {
                        name: "PI_CODING_AGENT_DIR",
                        value: NodePath.join(home, "pi"),
                        sensitive: false,
                      },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reports missing Pi history and skips malformed records without losing valid usage", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const missing = yield* service.readSummary(WINDOW);
        assert.strictEqual(
          missing.sources.find((source) => source.fingerprint.provider === "pi")?.status,
          "missing",
        );
        const dir = NodePath.join(home, "pi", "sessions");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              "{broken",
              "null",
              encodeUnknownJsonString({ type: "session", id: "valid" }),
              encodeUnknownJsonString({
                type: "message",
                id: "bad",
                timestamp: "invalid",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: { input: 100 },
                },
              }),
              encodeUnknownJsonString({
                type: "message",
                id: "valid",
                timestamp: "2026-08-01T10:00:00Z",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: {
                    input: -1,
                    cacheRead: "100",
                    output: 7,
                    reasoning: 50,
                    cost: { total: -1 },
                  },
                },
              }),
            ].join("\n") + "\n",
          );
        });
        const summary = yield* service.readSummary(WINDOW);
        const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
        assert.strictEqual(pi.length, 1);
        assert.strictEqual(pi[0] && totalTokens(pi[0].totals), 7);
        assert.strictEqual(pi[0]?.totals.reasoningTokens, 7);
        assert.strictEqual(pi[0]?.costSource, "unpriced");
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-pi-malformed", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("discovers Pi history in its default home and directory overrides", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      for (const [agentDir, sessionDir, relativeDir] of [
        [undefined, undefined, ".pi/agent/sessions"],
        ["~/custom-pi", undefined, "custom-pi/sessions"],
        ["~/ignored-pi", "~/custom-sessions", "custom-sessions"],
        ["~/ignored-pi", NodePath.join(home, "absolute-sessions"), "absolute-sessions"],
      ] as const) {
        const dir = NodePath.join(home, relativeDir);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              { type: "session", id: relativeDir },
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T10:00:00Z",
                provider: "openai",
                model: "model",
                usage: { input: 7 },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(pi.length, 1);
          assert.strictEqual(pi[0]?.totals.uncachedInputTokens, 7);
          assert.strictEqual(
            summary.sources.find((source) => source.fingerprint.provider === "pi")?.fingerprint
              .resolvedHomePath,
            dir,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-" + relativeDir.replaceAll("/", "-"),
              home,
              settings,
              environment: {
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: sessionDir,
              },
            }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads shared managed default and disabled extra account history once", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const summary = yield* Effect.gen(function* () {
        for (const [id, output] of [
          ["codex", 17],
          ["codex-personal", 23],
        ] as const) {
          const sessions = NodePath.join(home, "shared-codex", "sessions");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(sessions, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(sessions, `${id}-rollout.jsonl`),
              [
                { type: "session_meta", payload: { id } },
                { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
                {
                  type: "event_msg",
                  timestamp: "2026-08-01T10:00:00Z",
                  payload: {
                    type: "token_count",
                    info: { last_token_usage: { input_tokens: 10, output_tokens: output } },
                  },
                },
              ]
                .map((line) => encodeUnknownJsonString(line))
                .join("\n") + "\n",
            );
          });
        }
        const service = yield* UsageService.make;
        return yield* service.readSummary(WINDOW);
      }).pipe(
        // Scoped inside the state directory, so pending cache writes land
        // before it is removed.
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-managed-accounts",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                  },
                },
                [ProviderInstanceId.make("codex-personal")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: false,
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                    shadowHomePath: NodePath.join(home, "personal-shadow"),
                  },
                  environment: [
                    {
                      name: "CODEX_HOME",
                      value: NodePath.join(home, "ignored-environment"),
                      sensitive: false,
                    },
                  ],
                },
              },
            },
          }),
        ),
      );
      assert.strictEqual(totalOutputTokens(summary), 40);
      assert.strictEqual(
        summary.sources.filter(
          (source) => source.fingerprint.provider === "codex" && source.status === "ok",
        ).length,
        1,
      );
    }).pipe(Effect.scoped),
  );
  it.live("omits Cursor account usage when no file login is saved", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      for (const platform of ["linux", "win32", "darwin"] as const) {
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: `usage-service-cursor-no-login-${platform}`,
              home,
              settings,
              platform,
              environment: { AGENT_CLI_CREDENTIAL_STORE: "file" },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.isFalse(summary.sources.some((source) => source.fingerprint.provider === "cursor"));
      }
    }).pipe(Effect.scoped),
  );

  it.live("keeps Cursor credential errors visible when a saved login cannot be read", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const authPath = NodePath.join(home, "config", "cursor", "auth.json");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
        await NodeFSP.writeFile(authPath, "invalid json");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-cursor-invalid-login", home, settings }),
        ),
      );
      const summary = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.message, "Cursor credentials could not be read.");
    }).pipe(Effect.scoped),
  );

  it.live("answers Cursor from its cache while one shared refresh runs", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const cursor = makeFakeCursor();
      cursor.state.events = [{ timestampMs: CURSOR_NOW - 2 * HOUR_MS, outputTokens: 5 }];
      const gate = yield* Deferred.make<void>();
      cursor.state.gate = gate;
      yield* Effect.gen(function* () {
        const service = yield* makeWithCursor(cursor.read);
        // Cold: nothing cached yet, so Cursor answers empty while it refreshes.
        const cold = yield* service.readSummary(WINDOW);
        assert.strictEqual(cursorSource(cold)?.refreshing, true);
        assert.strictEqual(cursorSource(cold)?.status, "ok");
        assert.strictEqual(totalOutputTokens(cold), 0);
        // A second reader joins the refresh in flight.
        const joined = yield* service.readSummary(WINDOW);
        assert.strictEqual(cursorSource(joined)?.refreshing, true);

        const waited = yield* service
          .readSummary({ ...WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(gate, undefined);
        const refreshed = yield* Fiber.join(waited);
        assert.isFalse(refreshed.sources.some((source) => source.refreshing));
        assert.strictEqual(cursorSource(refreshed)?.status, "ok");
        assert.strictEqual(totalOutputTokens(refreshed), 5);
        assert.strictEqual(cursor.state.calls.length, 1);

        // Inside the TTL a plain read answers from the cache without refreshing.
        yield* TestClock.adjust(Duration.seconds(30));
        const cached = yield* service.readSummary(WINDOW);
        assert.isUndefined(cursorSource(cached)?.refreshing);
        assert.strictEqual(totalOutputTokens(cached), 5);
        assert.strictEqual(cursor.state.calls.length, 1);

        // Past it, a plain read answers from the stale cache and refreshes.
        yield* TestClock.adjust(Duration.seconds(31));
        cursor.state.events.push({ timestampMs: CURSOR_NOW, outputTokens: 7 });
        const stale = yield* service.readSummary(WINDOW);
        assert.strictEqual(cursorSource(stale)?.refreshing, true);
        assert.strictEqual(totalOutputTokens(stale), 5);
        const fresh = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.isUndefined(cursorSource(fresh)?.refreshing);
        assert.strictEqual(totalOutputTokens(fresh), 12);
        assert.strictEqual(cursor.state.calls.length, 2);
      }).pipe(Effect.provide(layerService({ prefix: "usage-service-cursor-swr", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("caches Cursor's whole retention and then refetches only the newest edge", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const cursor = makeFakeCursor();
      // Two identical billed rows inside the refetched hour must both survive it, once each.
      cursor.state.events = [
        { timestampMs: Date.parse("2026-07-10T10:00:00Z"), outputTokens: 17 },
        { timestampMs: CURSOR_NOW - 24 * HOUR_MS, outputTokens: 5 },
        { timestampMs: CURSOR_NOW - HOUR_MS / 2, outputTokens: 7 },
        { timestampMs: CURSOR_NOW - HOUR_MS / 2, outputTokens: 7 },
      ];
      yield* Effect.gen(function* () {
        const service = yield* makeWithCursor(cursor.read);
        const read = (input: UsageSummaryInput) =>
          service.readSummary({ ...input, awaitRefresh: true });
        assert.strictEqual(totalOutputTokens(yield* read(WINDOW)), 19);
        assert.deepStrictEqual(cursor.state.calls, [
          { sinceMs: CURSOR_NOW - CURSOR_RETENTION_MS, untilMs: CURSOR_NOW },
        ]);

        // A wider window is answered from the same cache.
        const wide = { ...WINDOW, sinceDay: UsageDay.make("2026-07-01") };
        assert.strictEqual(totalOutputTokens(yield* read(wide)), 36);
        assert.strictEqual(cursor.state.calls.length, 1);

        // An event finalized late, inside the overlap, and a new one.
        cursor.state.events.push(
          { timestampMs: CURSOR_NOW - HOUR_MS / 6, outputTokens: 11 },
          { timestampMs: CURSOR_NOW + HOUR_MS, outputTokens: 13 },
        );
        yield* TestClock.adjust(Duration.hours(2));
        assert.strictEqual(totalOutputTokens(yield* read(WINDOW)), 43);
        assert.deepStrictEqual(cursor.state.calls[1], {
          sinceMs: CURSOR_NOW - HOUR_MS,
          untilMs: CURSOR_NOW + 2 * HOUR_MS,
        });

        // Another login replaces the cached account's history instead of adding to it.
        cursor.state.accountKey = "account-b";
        yield* TestClock.adjust(Duration.minutes(2));
        assert.strictEqual(totalOutputTokens(yield* read(wide)), 60);
        assert.strictEqual(cursor.state.calls.length, 4);
        assert.strictEqual(cursorSource(yield* read(wide))?.fingerprint.volumeId, "account-b");
      }).pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-cursor-incremental", home, settings }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("reports a failed Cursor refresh from its cache without refreshing", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const cursor = makeFakeCursor();
      cursor.state.events = [{ timestampMs: CURSOR_NOW - HOUR_MS * 3, outputTokens: 5 }];
      yield* Effect.gen(function* () {
        const service = yield* makeWithCursor(cursor.read);
        yield* service.readSummary({ ...WINDOW, awaitRefresh: true });

        yield* TestClock.adjust(Duration.minutes(2));
        cursor.state.error = "Sign in to Cursor again to read account usage.";
        const failed = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(cursorSource(failed)?.status, "partial");
        assert.strictEqual(cursorSource(failed)?.message, cursor.state.error);
        assert.isUndefined(cursorSource(failed)?.refreshing);
        assert.strictEqual(totalOutputTokens(failed), 5);

        // The failure stands for the TTL; a plain read does not retry it.
        const again = yield* service.readSummary(WINDOW);
        assert.strictEqual(cursorSource(again)?.status, "partial");
        assert.isUndefined(cursorSource(again)?.refreshing);
        assert.strictEqual(cursor.state.calls.length, 2);

        // A failing read of another login drops the previous account's history.
        yield* TestClock.adjust(Duration.minutes(2));
        cursor.state.accountKey = "account-b";
        const switched = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(cursorSource(switched)?.status, "missing");
        assert.strictEqual(cursorSource(switched)?.message, cursor.state.error);
        assert.strictEqual(totalOutputTokens(switched), 0);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-cursor-failure", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("restores the Cursor account cache after a restart", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const before = makeFakeCursor();
      before.state.events = [
        { timestampMs: CURSOR_NOW - 30 * HOUR_MS, outputTokens: 5 },
        { timestampMs: CURSOR_NOW - 3 * HOUR_MS, outputTokens: 7 },
      ];
      yield* Effect.gen(function* () {
        const first = yield* makeWithCursor(before.read);
        const original = yield* first.readSummary({ ...WINDOW, awaitRefresh: true });
        yield* first.awaitPersisted;

        const after = makeFakeCursor();
        after.state.events = before.state.events;
        const restarted = yield* makeWithCursor(after.read);
        const restored = yield* restarted.readSummary(WINDOW);
        assert.isUndefined(cursorSource(restored)?.refreshing);
        assert.deepStrictEqual(restored.buckets, original.buckets);
        assert.deepStrictEqual(cursorSource(restored), cursorSource(original));
        assert.strictEqual(after.state.calls.length, 0);

        // Once stale, the restored cache refreshes only its newest edge.
        yield* TestClock.adjust(Duration.minutes(2));
        const refreshed = yield* restarted.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.deepStrictEqual(refreshed.buckets, original.buckets);
        assert.deepStrictEqual(after.state.calls, [
          { sinceMs: CURSOR_NOW - HOUR_MS, untilMs: CURSOR_NOW + 2 * 60 * 1000 },
        ]);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-cursor-restart", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not read the macOS Cursor Keychain before account usage is enabled", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cursor-keychain-disabled",
            home,
            settings,
            platform: "darwin",
            environment: {},
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.status, "missing");
      assert.strictEqual(cursor?.action, "enableCursorKeychain");
    }).pipe(Effect.scoped),
  );

  it.live("ignores stale Cursor file logins when the active credential store differs", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      for (const [index, testCase] of [
        {
          platform: "darwin" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: [".cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: ["config", "cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { CURSOR_API_KEY: "different-account" },
          authPath: ["config", "cursor", "auth.json"],
        },
      ].entries()) {
        const authPath = NodePath.join(home, ...testCase.authPath);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
          await NodeFSP.writeFile(
            authPath,
            encodeUnknownJsonString({ accessToken: "stale-token" }),
          );
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: `usage-service-cursor-store-${index}`,
              home,
              settings,
              platform: testCase.platform,
              environment: testCase.environment,
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
        assert.strictEqual(cursor?.status, "missing");
        assert.include(cursor?.message ?? "", "Cursor CLI login");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "includes OpenCode history but does not substitute desktop usage for an unavailable Cursor account",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const root = NodePath.join(home, "opencode");
        const message = yield* encodeUnknownJson({
          id: "msg_1",
          sessionID: "session-1",
          role: "assistant",
          modelID: "example-model",
          time: { created: Date.parse("2026-08-01T10:00:00Z") },
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
        });
        const bubble = yield* encodeUnknownJson({
          type: 2,
          createdAt: "2026-08-01T10:00:00Z",
          modelInfo: { modelName: "example-model" },
          tokenCount: { inputTokens: 100, outputTokens: 20 },
        });
        yield* Effect.promise(async () => {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "msg_1.json"), message);
          const desktop = NodePath.join(home, "config", "Cursor", "User", "globalStorage");
          await NodeFSP.mkdir(desktop, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(NodePath.join(desktop, "state.vscdb"));
          try {
            db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
            db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
              "bubbleId:session:assistant",
              bubble,
            );
          } finally {
            db.close();
          }
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(layerService({ prefix: "usage-service-opencode", home, settings })),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.buckets[0]?.provider, "opencode");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
        assert.isFalse(summary.sources.some((source) => source.fingerprint.provider === "cursor"));
        assert.strictEqual(
          summary.buckets[0]?.sourcePath,
          yield* Effect.promise(() => NodeFSP.realpath(root)),
        );
        assert.strictEqual(summary.buckets[0]?.totals.outputTokens, 7);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "opencode")
            ?.distinctSessions,
          1,
        );
      }).pipe(Effect.scoped),
  );

  it.live("counts aliased OpenCode and Antigravity directories once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const opencode = NodePath.join(home, "opencode-store");
      const opencodeAlias = NodePath.join(home, "opencode-alias");
      const conversations = NodePath.join(home, "antigravity-conversations");
      const antigravityA = NodePath.join(home, "antigravity-a");
      const antigravityB = NodePath.join(home, "antigravity-b");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(opencode);
        await NodeFSP.symlink(opencode, opencodeAlias, "junction");
        await NodeFSP.mkdir(conversations);
        await NodeFSP.mkdir(antigravityA);
        await NodeFSP.mkdir(antigravityB);
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityA, "conversations"),
          "junction",
        );
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityB, "conversations"),
          "junction",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-aliased-roots-test",
            home,
            settings,
            environment: {
              OPENCODE_DATA_DIR: `${opencode},${opencodeAlias}`,
              ANTIGRAVITY_DATA_DIR: `${antigravityA},${antigravityB}`,
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sourcesFor = (provider: "opencode" | "antigravity") =>
        summary.sources.filter((source) => source.fingerprint.provider === provider);
      assert.strictEqual(sourcesFor("opencode").length, 1);
      assert.strictEqual(sourcesFor("antigravity").length, 1);
      assert.strictEqual(
        sourcesFor("opencode")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(opencode)),
      );
      assert.strictEqual(
        sourcesFor("antigravity")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(conversations)),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reads Antigravity history from each instance's data directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const first = NodePath.join(home, "antigravity-first");
      const second = NodePath.join(home, "antigravity-second");
      yield* Effect.promise(async () => {
        for (const [dir, outputTokens] of [
          [first, 7],
          [second, 11],
        ] as const) {
          await NodeFSP.mkdir(dir);
          const db = new NodeSqlite.DatabaseSync(
            NodePath.join(dir, `${NodePath.basename(dir)}.db`),
          );
          try {
            db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
            // Step protobuf: 100 input tokens, distinct output tokens, and 2026-08-01T10:00Z.
            const metadata = new Uint8Array([
              0x4a,
              4,
              0x10,
              100,
              0x18,
              outputTokens,
              ...Buffer.from("420608a087b7d306", "hex"),
            ]);
            db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, metadata);
          } finally {
            db.close();
          }
        }
      });
      const instance = (dataDir: string) => ({
        driver: ProviderDriverKind.make("antigravity"),
        environment: [{ name: "ANTIGRAVITY_DATA_DIR", value: dataDir, sensitive: false }],
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-antigravity-instances-test",
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("antigravity-first")]: instance(first),
                [ProviderInstanceId.make("antigravity-second")]: instance(` ${second}, `),
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const roots = summary.sources
        .filter((source) => source.fingerprint.provider === "antigravity")
        .map((source) => source.fingerprint.resolvedHomePath);
      for (const [dir, outputTokens] of [
        [first, 7],
        [second, 11],
      ] as const) {
        const root = yield* Effect.promise(() => NodeFSP.realpath(dir));
        assert.include(roots, root);
        assert.strictEqual(
          summary.buckets
            .filter((bucket) => bucket.provider === "antigravity" && bucket.sourcePath === root)
            .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
          outputTokens,
        );
        // Each instance's own data folder counts toward that instance's plan.
        assert.strictEqual(
          summary.sources.find(
            (source) =>
              source.fingerprint.provider === "antigravity" &&
              source.fingerprint.resolvedHomePath === root,
          )?.instanceId,
          dir === first ? "antigravity-first" : "antigravity-second",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      const grokSecond = NodePath.join(home, "grok-second");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            // A-B-A at one timestamp must preserve both equal A events.
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.mkdir(grokSecond);
        await NodeFSP.symlink(
          NodePath.join(grokHome, "sessions"),
          NodePath.join(grokSecond, "sessions"),
          "junction",
        );
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                usage: { inputTokens: 10, outputTokens: 13, costUsdTicks: 10_000_000_000 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provideContext(
          yield* Layer.build(
            layerService({
              prefix: "usage-service-accounts-test",
              home,
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("claude-work")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: false,
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false },
                    ],
                  },
                  [ProviderInstanceId.make("codex-work")]: {
                    driver: ProviderDriverKind.make("codex"),
                    environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                  },
                  [ProviderInstanceId.make("codex-alias")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: { homePath: alias },
                  },
                  [ProviderInstanceId.make("codex-shadow")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                    environment: [
                      {
                        name: "CODEX_HOME",
                        value: NodePath.join(home, "ignored"),
                        sensitive: false,
                      },
                    ],
                  },
                  [ProviderInstanceId.make("grok-second")]: {
                    driver: ProviderDriverKind.make("grok"),
                    config: { homePath: grokSecond, shareMainFolder: true },
                    environment: [
                      {
                        name: "GROK_HOME",
                        value: NodePath.join(home, "ignored"),
                        sensitive: false,
                      },
                    ],
                  },
                  [ProviderInstanceId.make("grok-work")]: {
                    driver: ProviderDriverKind.make("grok"),
                    // An undecodable config must not hide history Grok reads by home alone.
                    config: { customModels: "not-a-list" },
                    environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                  },
                },
              },
            }),
          ),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      const grokBuckets = summary.buckets.filter((bucket) => bucket.provider === "grok");
      assert.strictEqual(
        grokBuckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
        13,
      );
      assert.strictEqual(
        grokBuckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
        1,
      );

      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 4);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and default homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          const configuredProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(configured, "projects")),
          );
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            configuredProjects,
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              ...settings.providerInstances,
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          const environmentProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(environmentHome, "projects")),
          );
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            environmentProjects,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: NodePath.join(home, "inherited-codex"),
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "inherited-codex", "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "reports unreadable transcripts as partial and recovers once they can be read",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const unreadable = NodePath.join(NodePath.dirname(transcript), "other.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 5));
          await NodeFSP.writeFile(unreadable, claudeLine(2, 7));
          await NodeFSP.chmod(unreadable, 0);
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const partial = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(partial), 5);
          assert.strictEqual(partial.sources[0]?.status, "partial");

          yield* Effect.promise(() => NodeFSP.chmod(unreadable, 0o600));
          const healthy = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(healthy), 12);
          assert.strictEqual(healthy.sources[0]?.status, "ok");
          assert.isNull(healthy.sources[0]?.message);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-unreadable", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "retains split response timing through unfinished tails, warm reads, resumes and restart",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const trigger =
          encodeUnknownJsonString({
            type: "user",
            uuid: "u",
            parentUuid: null,
            timestamp: "2026-08-01T10:00:00Z",
          }) + "\n";
        const response = (uuid: string, parentUuid: string, seconds: number) =>
          encodeUnknownJsonString({
            type: "assistant",
            uuid,
            parentUuid,
            timestamp: `2026-08-01T10:00:0${seconds}Z`,
            sessionId: "s",
            message: {
              id: "m",
              model: "claude-fable-5",
              usage: { input_tokens: 10, output_tokens: 100 },
            },
          });
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, trigger));
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          assert.strictEqual((yield* service.readSummary(WINDOW)).buckets.length, 0);
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, response("a", "u", 2) + "\n"));
          assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets[0]?.timing, {
            outputTokens: 100,
            seconds: 2,
            responses: 1,
          });
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, response("b", "a", 5)));
          const tail = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(tail.buckets[0]?.timing, {
            outputTokens: 100,
            seconds: 5,
            responses: 1,
          });
          assert.strictEqual(totalOutputTokens(tail), 100);
          assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets, tail.buckets);
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, tail.buckets);
          yield* restarted.awaitPersisted;
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, "\n"));
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, tail.buckets);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-response-timing", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps large-record totals and costs exact through append, dedupe, restart and cleanup",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const large = claudeLine(1, 9900).replace(
          '"message":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
        );
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, large));
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 9900);
          assert.closeTo(
            first.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            0.4951,
            1e-12,
          );
          const warm = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(warm.buckets, first.buckets);
          // The repeated content block has the same message/request identity.
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, large + claudeLine(2, 100)));
          const appended = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(appended), 10000);
          assert.strictEqual(
            appended.buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0),
            20,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          const restored = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, appended.buckets);
          yield* restarted.awaitPersisted;
          yield* Effect.promise(() => NodeFSP.rm(transcript));
          const afterCleanup = yield* UsageService.make;
          assert.deepStrictEqual(
            (yield* afterCleanup.readSummary(WINDOW)).buckets,
            appended.buckets,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-large-record-test",
              home,
              settings,
              ratesDocument: {
                "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "upgrades a v4 cache: reprices live Codex tiers, keeps deleted rollouts, leaves v4 intact",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rollout = (sessionId: string, outputTokens: number) =>
          [
            { type: "session_meta", payload: { id: sessionId } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              payload: {
                type: "thread_settings_applied",
                thread_settings: { service_tier: "ultrafast" },
              },
            },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 0, output_tokens: outputTokens } },
              },
            },
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n";
        const live = NodePath.join(sessions, "live.jsonl");
        const deleted = NodePath.join(sessions, "deleted.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(live, rollout("live", 10));
          await NodeFSP.writeFile(deleted, rollout("deleted", 20));
        });

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, "usage-scan-cache-v6.json");
          const legacyPath = NodePath.join(stateDir, "usage-scan-cache.json");
          const first = yield* UsageService.make;
          yield* first.readSummary(WINDOW);
          yield* first.awaitPersisted;

          // Rewrite the cache as a v4 server left it: every Codex record at
          // speed 0 (standard), and no tier in the reducer state.
          const legacy = yield* Effect.promise(async () => {
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, { r: unknown[][]; cs: { speed?: unknown } }>;
            };
            for (const file of Object.values(document.files)) {
              file.r = file.r.map((row) => [...row.slice(0, 10), 0]);
              delete file.cs.speed;
            }
            const text = encodeUnknownJsonString({ ...document, version: 4 });
            await NodeFSP.writeFile(legacyPath, text);
            await NodeFSP.rm(cachePath);
            await NodeFSP.rm(deleted);
            return text;
          });

          const summary = yield* (yield* UsageService.make).readSummary(WINDOW);
          // The live rollout re-parses at the ultrafast rate (10 x 6); the
          // deleted one keeps its saved v4 usage at the standard rate (20 x 1).
          assert.strictEqual(totalOutputTokens(summary), 30);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            80,
          );
          // A v4 server sharing this state directory still finds its own cache.
          assert.strictEqual(
            yield* Effect.promise(() => NodeFSP.readFile(legacyPath, "utf8")),
            legacy,
          );
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-v4-upgrade-test",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.deepStrictEqual(deleted.sources, first.sources);

        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, first.sources);

        // A moved transcript must not count the saved usage twice.
        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(moved.sources[0]?.distinctSessions, 1);
        yield* restarted.awaitPersisted;

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingRoot.sources[0]?.distinctSessions, 1);
        assert.strictEqual(missingRoot.sources[0]?.status, "ok");
        assert.deepStrictEqual(missingRoot.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(recreated.sources[0]?.fingerprint, first.sources[0]?.fingerprint);

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        // Scoped inside the state directory, so pending cache writes land
        // before it is removed.
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-service-cleanup-test",
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: alias },
                },
              },
            },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("retains older Claude usage when a transcript is rewritten during a 30-day scan", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const recent = claudeLine(2, 7).replace("2026-08-01", "2026-10-01");
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5) + recent));
      yield* Effect.gen(function* () {
        const wide = { ...WINDOW, untilDay: UsageDay.make("2026-10-16") };
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(wide)), 12);

        // A cleanup/rewrite removes the older exchange from the same path.
        yield* replaceFile(transcript, recent);
        const narrow = yield* service.readSummary({
          ...wide,
          sinceDay: UsageDay.make("2026-09-16"),
        });
        assert.strictEqual(totalOutputTokens(narrow), 7);
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(wide)), 12);
        yield* service.awaitPersisted;

        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(wide)), 12);
        // Fresh data for the same event must replace its saved version.
        yield* replaceFile(transcript, recent.replace('"output_tokens":7', '"output_tokens":8'));
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(wide)), 13);
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(3, 3)));
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(wide)), 16);
        yield* Effect.promise(() => NodeFSP.rm(transcript));
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(wide)), 16);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-service-rewrite-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "merges saved usage from another server instead of overwriting it with a stale cache",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const historical = transcript + ".historical.jsonl";
        const trigger = transcript + ".trigger.jsonl";
        const recent = claudeLine(2, 7).replace("2026-08-01", "2026-10-01");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, recent));
        yield* Effect.gen(function* () {
          const wide = { ...WINDOW, untilDay: UsageDay.make("2026-10-16") };
          const narrow = { ...wide, sinceDay: UsageDay.make("2026-09-16") };
          const stale = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* stale.readSummary(narrow)), 7);
          yield* stale.awaitPersisted;

          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(historical, claudeLine(1, 5));
            const lastWrite = (await NodeFSP.stat(transcript)).mtimeMs / 1000 - 60 * 24 * 60 * 60;
            await NodeFSP.utimes(historical, lastWrite, lastWrite);
            await NodeFSP.appendFile(
              transcript,
              claudeLine(3, 3).replace("2026-08-01", "2026-10-01"),
            );
          });
          const other = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* other.readSummary(wide)), 15);
          yield* other.awaitPersisted;

          // The older server never saw this history. Its next dirty save must
          // preserve both the missing file and the newer read of the shared file.
          yield* Effect.promise(async () => {
            await NodeFSP.rm(historical);
            await NodeFSP.rm(transcript);
            await NodeFSP.writeFile(trigger, claudeLine(4, 2).replace("2026-08-01", "2026-10-01"));
          });
          yield* stale.readSummary(narrow);
          yield* stale.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(wide)), 17);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({ prefix: "usage-service-shared-cache-test", home, settings }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("credits the same copy of a duplicate after its transcripts are deleted", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const dir = NodePath.dirname(transcript);
      // The walk-first file is the original, padded so it finishes parsing
      // after the small fork copy that repeats its record under a new session.
      const [first = "", second = ""] = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(dir, "a.jsonl"), "");
        await NodeFSP.writeFile(NodePath.join(dir, "b.jsonl"), "");
        return (await NodeFSP.readdir(dir)).map((name) => NodePath.join(dir, name));
      });
      const forked = (line: string) => line.replace('"session-1"', '"session-2"');
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          first,
          claudeLine(1, 5).replace(
            '"message":',
            '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
          ),
        );
        await NodeFSP.writeFile(second, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const live = yield* service.readSummary(WINDOW);
        assert.strictEqual(live.buckets[0]?.sessions, 2);

        yield* Effect.promise(() => Promise.all([NodeFSP.rm(first), NodeFSP.rm(second)]));
        const saved = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(saved.buckets, live.buckets);
        assert.deepStrictEqual(saved.sources, live.sources);
        yield* service.awaitPersisted;
        const restored = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, live.buckets);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-copy-order-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps a newer cached read when a slower scan of another window finishes later",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const dir = NodePath.dirname(transcript);
        const probe = NodePath.join(dir, "probe.jsonl");
        const hold = NodePath.join(dir, "hold.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* makeGate(probe, BEFORE_NARROW_WINDOW);
        yield* makeGate(hold, BEFORE_NARROW_WINDOW);
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const wide = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* openGate(probe);
          yield* replaceFile(transcript, claudeLine(1, 5) + claudeLine(2, 7));
          // The narrow scan caches the newer read while the wide one waits.
          yield* service.readSummary(NARROW_WINDOW);
          yield* openGate(hold);
          yield* Fiber.join(wide);

          yield* Effect.promise(() =>
            Promise.all([transcript, probe, hold].map((path) => NodeFSP.rm(path))),
          );
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-stale-read-test", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps the later read when a scan that read earlier finishes first",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const dir = NodePath.dirname(transcript);
        const gate = (name: string) => NodePath.join(dir, `${name}.jsonl`);
        const wideProbe = gate("wide-probe");
        const wideHold = gate("wide-hold");
        const narrowProbe = gate("narrow-probe");
        const narrowHold = gate("narrow-hold");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* makeGate(wideProbe, BEFORE_NARROW_WINDOW);
        yield* makeGate(wideHold, BEFORE_NARROW_WINDOW);
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const wide = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* openGate(wideProbe);
          yield* replaceFile(transcript, claudeLine(1, 5) + claudeLine(2, 7));
          // Made after the wide scan's walk, so only the narrow scan waits on them.
          yield* makeGate(narrowProbe);
          yield* makeGate(narrowHold);
          const narrow = yield* service.readSummary(NARROW_WINDOW).pipe(Effect.forkChild);
          yield* openGate(narrowProbe);
          // Both scans started from an empty cache entry; the earlier read lands first.
          yield* openGate(wideHold);
          yield* Fiber.join(wide);
          yield* openGate(narrowHold);
          yield* Fiber.join(narrow);

          yield* Effect.promise(() =>
            Promise.all(
              [transcript, wideProbe, wideHold, narrowProbe, narrowHold].map((path) =>
                NodeFSP.rm(path),
              ),
            ),
          );
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-late-read-test", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("reports saved usage of a removed directory only for windows it reaches", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-05T00:00:00Z"));
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        const lastWrite = Date.parse("2026-08-01T10:00:00Z") / 1000;
        await NodeFSP.utimes(transcript, lastWrite, lastWrite);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-saved-window-test", home, settings })),
      );
      const first = yield* service.readSummary(WINDOW);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );

      const reached = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(reached.buckets, first.buckets);
      assert.strictEqual(reached.sources[0]?.status, "ok");

      // A missing source cannot claim this directory from another environment
      // that still reads it, so it adds nothing to a window after its last write.
      const later = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-10"),
        untilDay: UsageDay.make("2026-08-12"),
      });
      assert.deepStrictEqual(later.buckets, []);
      assert.strictEqual(later.sources[0]?.status, "missing");
      assert.strictEqual(later.sources[0]?.scannedFiles, 0);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));
      const transcriptDir = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
      );

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== transcriptDir) return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(secondScanStarted);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-interruption-test", home, settings })),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});

/** An aged corpus answers at once and is replaced in the background: wait for the replacement. */
const readRefreshedThreadRecords = <A, E>(
  service: {
    readonly readThreadRecords: Effect.Effect<A, E>;
    readonly awaitThreadRecordsRefreshed: Effect.Effect<void>;
  },
  stale: A,
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.millis(UsageService.THREAD_RECORDS_FRESH_MS + 1_000));
    assert.strictEqual(
      yield* service.readThreadRecords,
      stale,
      "an aged corpus still answers while it refreshes",
    );
    yield* service.awaitThreadRecordsRefreshed;
    const next = yield* service.readThreadRecords;
    assert.notStrictEqual(next, stale);
    return next;
  });

it.effect(
  "shares the chat corpus scan, answers from it while it ages, and refreshes appended session usage",
  () =>
    Effect.gen(function* () {
      const { home, transcript, settings } = yield* setup;
      const compact = (timestamp: string) =>
        encodeUnknownJsonString({
          type: "system",
          subtype: "compact_boundary",
          timestamp,
          sessionId: "session-1",
          compactMetadata: { preTokens: 167000, postTokens: 25000 },
        }) + "\n";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeLine(1, 50) + compact("2026-08-01T10:00:00Z")),
      );
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const [first, concurrent] = yield* Effect.all(
          [service.readThreadRecords, service.readThreadRecords],
          { concurrency: 2 },
        );
        assert.strictEqual(first, concurrent);
        assert.equal(
          first.sources
            .flatMap((source) => source.files ?? [])
            .flatMap((file) => file.records)
            .filter((record) => record.sessionId === "session-1").length,
          1,
        );
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 75)));
        assert.strictEqual(yield* service.readThreadRecords, first);
        yield* TestClock.adjust("61 seconds");
        assert.strictEqual(yield* service.readThreadRecords, first);
        const refreshed = yield* readRefreshedThreadRecords(service, first);
        assert.equal(
          refreshed.sources
            .flatMap((source) => source.files ?? [])
            .flatMap((file) => file.details ?? [])
            .filter((detail) => detail.kind === "compaction").length,
          1,
        );
        assert.equal(
          refreshed.sources
            .flatMap((source) => source.files ?? [])
            .flatMap((file) => file.records)
            .filter((record) => record.sessionId === "session-1").length,
          2,
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(transcript, claudeLine(3, 25) + compact("2026-08-01T10:01:00Z")),
        );
        const rewritten = yield* readRefreshedThreadRecords(service, refreshed);
        assert.equal(
          rewritten.sources
            .flatMap((source) => source.files ?? [])
            .flatMap((file) => file.details ?? [])
            .filter((detail) => detail.kind === "compaction").length,
          2,
        );
      }).pipe(Effect.provide(layerService({ prefix: "chat-corpus-cache", home, settings })));
    }).pipe(Effect.scoped),
);

/** A made-up Codex session, named the way Codex names rollout files. */
const ROLLOUT_SESSION = "01a20000-0000-7000-8000-00000000c0de";
const ROLLOUT_NAME = `rollout-2026-08-01T09-59-58-${ROLLOUT_SESSION}`;

/** A rollout's opening lines, shaped like Codex writes them. */
function rolloutHead(): string {
  return [
    {
      timestamp: "2026-08-01T09:59:58.000Z",
      type: "session_meta",
      payload: {
        id: ROLLOUT_SESSION,
        timestamp: "2026-08-01T09:59:58.000Z",
        cwd: "/work/project",
        originator: "codex_cli_rs",
        cli_version: "0.200.0",
        source: "cli",
        model_provider: "openai",
      },
    },
    {
      timestamp: "2026-08-01T09:59:59.000Z",
      type: "turn_context",
      payload: { cwd: "/work/project", approval_policy: "never", model: "gpt-5.6-sol" },
    },
  ]
    .map((line) => encodeUnknownJsonString(line) + "\n")
    .join("");
}

/** One user turn per output, each ending in Codex's `token_count` event. */
function rolloutTurns(outputs: readonly number[], firstMinute = 0): string {
  return outputs
    .flatMap((output, index) => {
      const at = (seconds: number) =>
        `2026-08-01T10:${String(firstMinute + index).padStart(2, "0")}:0${seconds}.000Z`;
      const usage = {
        input_tokens: 1000,
        cached_input_tokens: 600,
        cache_write_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: 1000 + output,
      };
      return [
        {
          timestamp: at(0),
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] },
        },
        {
          timestamp: at(4),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
        {
          timestamp: at(5),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 1e6 },
            rate_limits: null,
          },
        },
      ];
    })
    .map((line) => encodeUnknownJsonString(line) + "\n")
    .join("");
}

let lastRolloutWrite = 0;

/** Stamps each write a later whole second, so a copied mtime matches the original exactly. */
async function writeRollout(path: string, content: string, append = false) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await (append ? NodeFSP.appendFile(path, content) : NodeFSP.writeFile(path, content));
  const { mtimeMs } = await NodeFSP.stat(path);
  lastRolloutWrite = Math.max(Math.floor(mtimeMs / 1000), lastRolloutWrite) + 1;
  await NodeFSP.utimes(path, lastRolloutWrite, lastRolloutWrite);
}

/** Moves a rollout as Codex does: same bytes and mtime, compressed when `to` is `.zst`. */
async function moveRollout(from: string, to: string) {
  await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
  if (!to.endsWith(".zst")) return NodeFSP.rename(from, to);
  const { mtimeMs } = await NodeFSP.stat(from);
  await NodeFSP.writeFile(to, NodeZlib.zstdCompressSync(await NodeFSP.readFile(from)));
  await NodeFSP.utimes(to, mtimeMs / 1000, mtimeMs / 1000);
  await NodeFSP.rm(from);
}

const codexSessionCount = (summary: { readonly sources: readonly UsageSource[] }) =>
  summary.sources
    .filter((source) => source.fingerprint.provider === "codex")
    .reduce((sum, source) => sum + source.distinctSessions, 0);

/** The persisted cache's Codex entries, relative to the Codex home. */
const persistedCodexFiles = (codexHome: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* Effect.promise(async () => {
      const home = await NodeFSP.realpath(codexHome);
      const document = decodeUnknownJsonString(
        await NodeFSP.readFile(NodePath.join(stateDir, "usage-scan-cache-v6.json"), "utf8"),
      ) as { files: Record<string, { p: string; gl: number }> };
      return Object.fromEntries(
        Object.entries(document.files)
          .filter(([, file]) => file.p === "codex")
          .map(([path, file]) => [NodePath.relative(home, path), file] as const),
      );
    });
  });

describe("UsageService Codex rollouts that move", () => {
  const codexPaths = (home: string) => {
    const codexHome = NodePath.join(home, "codex");
    return {
      codexHome,
      live: NodePath.join(codexHome, "sessions", "2026", "08", "01", `${ROLLOUT_NAME}.jsonl`),
      archived: NodePath.join(codexHome, "archived_sessions", `${ROLLOUT_NAME}.jsonl`),
    };
  };

  it.live("counts a rollout once as Codex archives it and later compresses it", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const { codexHome, live, archived } = codexPaths(home);
      yield* Effect.promise(() => writeRollout(live, rolloutHead() + rolloutTurns([5, 7])));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        // Saved under the live path, which a later persist must not bring back.
        yield* service.awaitPersisted;

        yield* Effect.promise(() => moveRollout(live, archived));
        const moved = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(moved), 12);
        assert.strictEqual(codexSessionCount(moved), 1);

        yield* Effect.promise(() => moveRollout(archived, archived + ".zst"));
        const compressed = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(compressed), 12);
        assert.strictEqual(codexSessionCount(compressed), 1);
        yield* service.awaitPersisted;
        const persisted = yield* persistedCodexFiles(codexHome);
        assert.deepStrictEqual(Object.keys(persisted), [
          NodePath.join("archived_sessions", `${ROLLOUT_NAME}.jsonl.zst`),
        ]);
        // Unchanged by compression, the saved parse is reused rather than
        // decompressing the archive, which keeps the plain file's guard.
        assert.isAbove(Object.values(persisted)[0]?.gl ?? 0, 0);

        const restarted = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(restarted), 12);
        assert.strictEqual(codexSessionCount(restarted), 1);
      }).pipe(Effect.provide(layerService({ prefix: "codex-archive", home, settings })));
    }).pipe(Effect.scoped),
  );

  it.live.each([
    { compressed: false, name: "plain" },
    { compressed: true, name: "compressed" },
  ])("adds the turns a rollout gained before it was archived, $name", ({ compressed }) =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const { live, archived } = codexPaths(home);
      const target = compressed ? archived + ".zst" : archived;
      yield* Effect.promise(() => writeRollout(live, rolloutHead() + rolloutTurns([5, 7])));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        yield* service.awaitPersisted;

        // The last turn lands after the scan, then Codex archives the rollout.
        yield* Effect.promise(async () => {
          await writeRollout(live, rolloutTurns([11], 2), true);
          await moveRollout(live, target);
        });
        const archivedSummary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(archivedSummary), 23);
        assert.strictEqual(codexSessionCount(archivedSummary), 1);
        yield* service.awaitPersisted;

        const restarted = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(restarted), 23);
        assert.strictEqual(codexSessionCount(restarted), 1);
      }).pipe(
        Effect.provide(
          layerService({ prefix: `codex-archive-tail-${compressed}`, home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts a rollout present in both homes at once once", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const { live, archived } = codexPaths(home);
      yield* Effect.promise(() => writeRollout(live, rolloutHead() + rolloutTurns([5, 7])));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);

        // A copy holding one more turn appears while the original is still there.
        yield* Effect.promise(() =>
          writeRollout(archived, rolloutHead() + rolloutTurns([5, 7]) + rolloutTurns([11], 2)),
        );
        const both = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(both), 23);
        assert.strictEqual(codexSessionCount(both), 1);

        yield* Effect.promise(() => NodeFSP.rm(live));
        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(original), 23);
        assert.strictEqual(codexSessionCount(original), 1);
        yield* service.awaitPersisted;

        const restarted = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(restarted), 23);
        assert.strictEqual(codexSessionCount(restarted), 1);
      }).pipe(Effect.provide(layerService({ prefix: "codex-both-homes", home, settings })));
    }).pipe(Effect.scoped),
  );
});

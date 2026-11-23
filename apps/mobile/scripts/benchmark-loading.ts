// Run from the repository root: bun apps/mobile/scripts/benchmark-loading.ts
// Synthetic data only. These are host JS timings, not iPhone launch timings.
import * as NodeAssert from "node:assert";
import * as NodeZlib from "node:zlib";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  type Persistence,
} from "@t3tools/client-runtime/platform";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  BoundedThreadSnapshotLoader,
  ThreadSnapshotLoader,
} from "@t3tools/client-runtime/state/threads";
import {
  applyShellStreamEvent,
  applyShellStreamEvents,
  type ShellStreamEvent,
} from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { buildBoundedThreadStreamSnapshot } from "../../server/src/orchestration-v2/ThreadStream.ts";
import {
  decodeStoredShellSnapshot,
  decodeStoredShellPreview,
  firstScreenShellSnapshot,
  encodeStoredShellPreview,
} from "../src/connection/shell-cache-decoding.ts";
import { homeMachineSummaries } from "../src/lib/thread-summaries.ts";
import { workspaceThreadCounts } from "../src/state/shell-preview.ts";
import { createLoadMarkJournal } from "../src/lib/load-mark-journal.ts";
import { cachedConfigFixture } from "../src/connection/server-config-cache.test-fixtures.ts";
import {
  StoredServerConfig,
  decodeStoredServerConfig,
  encodeStoredServerConfig,
} from "../src/connection/server-config-cache.ts";
import {
  decodeStoredThreadSnapshot,
  encodeStoredThreadSnapshot,
} from "../src/connection/thread-cache-encoding.ts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
} from "../src/features/threads/threadListV2.ts";

const environmentId = EnvironmentId.make("benchmark-environment");
const samples = 15;
async function measure(
  name: string,
  run: () => unknown | Promise<unknown>,
  cleanup?: () => Promise<unknown>,
) {
  for (let i = 0; i < 3; i++) {
    await run();
    await cleanup?.();
  }
  const durations: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
    await cleanup?.();
  }
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      name,
      medianMs: Number(durations[Math.floor(samples / 2)]!.toFixed(2)),
      p95Ms: Number(durations[Math.floor(samples * 0.95)]!.toFixed(2)),
    }),
  );
}
function sizes(name: string, payload: string) {
  console.log(
    JSON.stringify({
      name,
      bytes: Buffer.byteLength(payload),
      gzipBytes: NodeZlib.gzipSync(payload).byteLength,
    }),
  );
}

const configJson = await Effect.runPromise(
  encodeStoredServerConfig({
    schemaVersion: 1,
    environmentId,
    config: cachedConfigFixture(14, 3),
  }),
);
const decodeLegacyConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredServerConfig));
sizes("cached provider configuration", configJson);
NodeAssert.deepStrictEqual(
  await Effect.runPromise(decodeStoredServerConfig(configJson)),
  await Effect.runPromise(decodeLegacyConfig(configJson)),
);
await measure("previous repeated workspace catalog cache decode", () =>
  Effect.runPromise(decodeLegacyConfig(configJson)),
);
await measure("shared workspace catalog cache decode", () =>
  Effect.runPromise(decodeStoredServerConfig(configJson)),
);
for (const workspaces of [0, 3]) {
  const fixture = cachedConfigFixture(14, workspaces);
  const config = {
    ...fixture,
    providers: fixture.providers.map((provider) => ({
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots?.map((snapshot) => ({
        ...snapshot,
        skills: [],
      })),
    })),
  };
  const raw = await Effect.runPromise(
    encodeStoredServerConfig({ schemaVersion: 1, environmentId, config }),
  );
  const name = workspaces === 0 ? "no workspace catalogs" : "distinct workspace catalogs";
  NodeAssert.deepStrictEqual(
    await Effect.runPromise(decodeStoredServerConfig(raw)),
    await Effect.runPromise(decodeLegacyConfig(raw)),
  );
  await measure(`previous cache decode with ${name}`, () =>
    Effect.runPromise(decodeLegacyConfig(raw)),
  );
  await measure(`current cache decode with ${name}`, () =>
    Effect.runPromise(decodeStoredServerConfig(raw)),
  );
}

const shell: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  threads: Array.from({ length: 5_000 }, (_, index) => ({
    ...v2ThreadShell,
    id: ThreadId.make(`thread-${index}`),
    title: `Investigate workspace ${index} and its loading performance`,
  })),
};
const shellJson = Schema.encodeSync(Schema.fromJsonString(StoredOrchestrationShellSnapshot))({
  schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
  environmentId,
  snapshot: shell,
});
sizes("5,000 chat shell cache", shellJson);
await measure("hydrate 5,000 cached chat shells", () =>
  Effect.runPromise(decodeStoredShellSnapshot(shellJson)),
);
const threads = shell.threads.map((thread) => presentThreadShell(environmentId, thread));
await measure("derive 5,000 mobile list rows", () =>
  buildThreadListV2ListItems({
    layout: buildThreadListV2Items({ threads, searchQuery: "", now: "2026-10-26T12:00:00.000Z" }),
    pendingTasks: [],
  }),
);
const previewJson = await Effect.runPromise(
  encodeStoredShellPreview({
    schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
    environmentId,
    snapshot: firstScreenShellSnapshot(shell, environmentId),
  }),
);
sizes("64-chat first-screen shell cache", previewJson);
await measure("prepare preview with full-snapshot counts at save time", () =>
  firstScreenShellSnapshot(shell, environmentId),
);
for (const preview of [false, true]) {
  await measure(
    preview ? "preview cache to first mobile list rows" : "full cache to first mobile list rows",
    async () => {
      const stored = await Effect.runPromise(
        preview ? decodeStoredShellPreview(previewJson) : decodeStoredShellSnapshot(shellJson),
      );
      const threads = stored.snapshot.threads.map((thread) =>
        presentThreadShell(environmentId, thread),
      );
      const metadata: Persistence.EnvironmentShellPreview = stored.snapshot;
      const counts = preview
        ? new Map([[environmentId, metadata.previewCounts ?? null]])
        : new Map();
      homeMachineSummaries(threads, counts);
      workspaceThreadCounts(threads, counts);
      return buildThreadListV2ListItems({
        layout: buildThreadListV2Items({
          threads,
          searchQuery: "",
          now: "2026-10-26T12:00:00.000Z",
        }),
        pendingTasks: [],
      });
    },
  );
}

const diagnosticDirectory = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "mobile-load-marks-"),
);
try {
  const file = NodePath.join(diagnosticDirectory, "marks.jsonl");
  NodeFS.writeFileSync(
    file,
    Array.from({ length: 4_000 }, (_, index) =>
      JSON.stringify({
        name: "shell.cached",
        atMs: index,
        wallMs: 1_000_000 + index,
        threads: 5_000,
      }),
    ).join("\n"),
  );
  await measure("previous diagnostic startup read and split 4,000 lines", () =>
    NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-4_000),
  );
  let journal: ReturnType<typeof createLoadMarkJournal>;
  await measure(
    "deferred diagnostic startup registration",
    () => {
      journal = createLoadMarkJournal({
        read: () => NodeFS.promises.readFile(file, "utf8"),
        write: (text) => NodeFS.promises.writeFile(file, text),
      });
      journal.record(JSON.stringify({ name: "app.launch", atMs: 100, wallMs: 1_004_001 }));
    },
    () => journal.flush(),
  );
} finally {
  NodeFS.rmSync(diagnosticDirectory, { recursive: true, force: true });
}
const events: ShellStreamEvent[] = Array.from({ length: 500 }, (_, index) => ({
  kind: "thread.updated",
  sequence: index + 1,
  location: "active",
  thread: { ...shell.threads[index * 7]!, title: `Updated chat ${index}` },
}));
const replay = () =>
  events.reduce((current, event) => applyShellStreamEvent(current, event), shell);
NodeAssert.deepStrictEqual(replay().threads.length, 5_000);
await measure("replay 500 changes across 5,000 chats", replay);
NodeAssert.deepStrictEqual(applyShellStreamEvents(shell, events), replay());
await measure("batch replay 500 changes across 5,000 chats", () =>
  applyShellStreamEvents(shell, events),
);
for (const chunkSize of [16, 64]) {
  const replayChunks = () => {
    let current = shell;
    for (let index = 0; index < events.length; index += chunkSize) {
      current = applyShellStreamEvents(current, events.slice(index, index + chunkSize));
    }
    return current;
  };
  NodeAssert.deepStrictEqual(replayChunks(), replay());
  await measure(`replay 500 changes in ${chunkSize}-event chunks across 5,000 chats`, replayChunks);
}

const base = v2Projection;
const messages = Array.from({ length: 200 }, (_, index) => ({
  id: MessageId.make(`message-${index}`),
  threadId: base.thread.id,
  runId: null,
  nodeId: null,
  role: "user" as const,
  text: `Request ${index}: ${"A long message with context and source examples. ".repeat(100)}`,
  attachments: [],
  streaming: false,
  createdBy: "user" as const,
  creationSource: "mobile" as const,
  createdAt: base.updatedAt,
  updatedAt: base.updatedAt,
}));
const items = messages.map((message, index) => ({
  id: TurnItemId.make(`item-${index}`),
  threadId: base.thread.id,
  runId: null,
  type: "user_message" as const,
  ordinal: index,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed" as const,
  title: null,
  startedAt: base.updatedAt,
  completedAt: base.updatedAt,
  inputIntent: "turn_start" as const,
  messageId: message.id,
  text: message.text,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "mobile" as const,
  createdAt: base.updatedAt,
  updatedAt: base.updatedAt,
}));
const projection: OrchestrationV2ThreadProjection = {
  ...base,
  messages,
  turnItems: items,
  visibleTurnItems: items.map((item, position) => ({
    sourceThreadId: base.thread.id,
    sourceItemId: item.id,
    visibility: "local" as const,
    position,
    item,
  })),
};
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(StoredOrchestrationThreadSnapshot));
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);
async function measureThreadCache(name: string, projection: OrchestrationV2ThreadProjection) {
  const stored = {
    schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
    environmentId,
    threadId: projection.thread.id,
    snapshot: { snapshotSequence: 500, projection },
  };
  const full = await Effect.runPromise(encodeThread(stored));
  const compact = await Effect.runPromise(encodeStoredThreadSnapshot(stored));
  if (compact === undefined) {
    console.log(`${name}: projection exceeds mobile cache budget`);
    return;
  }
  // Ignore absent optional keys vs keys whose value is undefined.
  NodeAssert.deepStrictEqual(
    JSON.parse(
      JSON.stringify((await Effect.runPromise(decodeStoredThreadSnapshot(compact))).snapshot),
    ),
    JSON.parse(JSON.stringify((await Effect.runPromise(decodeThread(full))).snapshot)),
  );
  sizes(`${name} full cache`, full);
  sizes(`${name} compact cache`, compact);
  await measure(`encode ${name} full cache`, () => Effect.runPromise(encodeThread(stored)));
  await measure(`encode ${name} compact cache`, () =>
    Effect.runPromise(encodeStoredThreadSnapshot(stored)),
  );
  await measure(`hydrate ${name} full cache`, () => Effect.runPromise(decodeThread(full)));
  await measure(`hydrate ${name} compact cache`, () =>
    Effect.runPromise(decodeStoredThreadSnapshot(compact)),
  );
}
await measureThreadCache("200 long messages", projection);
const activity = Array.from({ length: 5_000 }, (_, index) => ({
  ...items[0]!,
  id: TurnItemId.make(`activity-${index}`),
  type: "reasoning" as const,
  ordinal: index,
  text: `Step ${index}: ${"Consider the changes and check the relevant source. ".repeat(5)}`,
  streaming: false,
}));
const longProjection: OrchestrationV2ThreadProjection = {
  ...base,
  turnItems: activity,
  visibleTurnItems: activity.map((item, position) => ({
    sourceThreadId: base.thread.id,
    sourceItemId: item.id,
    visibility: "local" as const,
    position,
    item,
  })),
};
await measureThreadCache("5,000 activities", longProjection);

// The server's existing cold-open wire policy, unchanged by these cache fixes.
const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
for (const [name, sourceProjection] of [
  ["long messages", projection],
  ["long activity thread", longProjection],
] as const) {
  const full = { kind: "snapshot" as const, snapshotSequence: 500, projection: sourceProjection };
  const bounded = buildBoundedThreadStreamSnapshot({
    ...full,
    snapshotUserTurnLimit: 1,
    compactTurnItems: true,
    compactIds: true,
    dedupeBodies: true,
  });
  sizes(`server ${name} full snapshot`, JSON.stringify(encodeStreamItem(full)));
  sizes(`server ${name} current mobile snapshot`, JSON.stringify(encodeStreamItem(bounded)));
  console.log(
    JSON.stringify({
      name,
      visibleRows: bounded.projection.visibleTurnItems.length,
      hasMoreHistory: bounded.hasMoreHistory,
    }),
  );
}

// Count the existing cold-open request path with an in-memory server transport.
// No network or device is used. The package tests cover auth retry and socket replay.
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Benchmark",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test/ws",
});
const mobileBody = encodeStreamItem(
  buildBoundedThreadStreamSnapshot({
    projection,
    snapshotSequence: 500,
    snapshotUserTurnLimit: 1,
    compactTurnItems: true,
    dedupeBodies: true,
    compactIds: true,
  }),
);
for (const olderServer of [false, true]) {
  const paths: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const bounded = path.endsWith("/bounded");
      const response =
        bounded && olderServer
          ? new Response("Not Found", { status: 404 })
          : Response.json(
              bounded
                ? mobileBody
                : encodeStreamItem({ kind: "snapshot", projection, snapshotSequence: 500 }),
            );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const loaded = await Effect.runPromise(
    ThreadSnapshotLoader.pipe(
      Effect.flatMap((loader) =>
        loader.load(
          {
            environmentId,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: target.wsBaseUrl,
            httpAuthorization: null,
            target,
          },
          projection.thread.id,
        ),
      ),
      Effect.provide(BoundedThreadSnapshotLoader.layerWithOptions({ snapshotUserTurnLimit: 1 })),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  );
  NodeAssert.equal(loaded._tag, "present");
  NodeAssert.equal(paths.length, olderServer ? 2 : 1);
  console.log(
    JSON.stringify({
      name: olderServer
        ? "older server fallback HTTP requests"
        : "current server cold thread HTTP requests",
      count: paths.length,
      paths,
    }),
  );
}

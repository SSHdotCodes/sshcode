import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    discoverNative: () => Effect.die("unused"),
    selectNative: () => Effect.die("unused"),
    previewNative: () => Effect.die("unused"),
    readNative: () => Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        ProjectionStore.layerMemory,
        IdAllocator.layer,
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        ThreadCommandExecutor.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "opens just the selected native session, confirms terminal activity and reuses concurrent imports",
  () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const upserts: Array<unknown> = [];
    let imported = false;
    let linkedAppThread: ThreadId | null = null;
    let active = true;
    let bootstraps = 0;
    let reads = 0;
    const session = () => ({
      sessionKey: "selected-session",
      provider: "codex" as const,
      providerInstanceId,
      nativeId: providerSessionId,
      title: "Selected CLI session",
      cwd: "/workspace/selected",
      host: "fixture-host",
      lastActiveAt: "2020-01-01T00:00:00.000Z",
      importedThreadId: null,
      mayBeActive: active,
    });
    const outcome = {
      _tag: "Importable" as const,
      source: {
        provider: "codex" as const,
        providerInstanceId,
        providerSessionId,
        filePath: "/fixture/selected.jsonl",
        size: 100,
        mtimeMs: Date.parse("2020-01-01T00:00:00.000Z"),
        device: 1,
        inode: 2,
        birthtimeMs: 3,
      },
      thread: {
        source: "codex" as const,
        providerInstanceId,
        providerSessionId,
        title: "Selected CLI session",
        model: null,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        messages: [
          { role: "user" as const, text: "Selected prompt", createdAt: "2020-01-01T00:00:00.000Z" },
        ],
      },
    };
    const layerTest = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            discoverNative: () =>
              Effect.succeed({ sessions: [session()], nextCursor: null, scanning: false }),
            previewNative: () =>
              Effect.succeed({
                session: session(),
                messages: outcome.thread.messages,
                truncated: false,
              }),
            selectNative: () =>
              Effect.succeed({
                session: session(),
                file: {
                  directory: "/fixture",
                  provider: "codex",
                  providerInstanceId,
                  filePath: "/fixture/selected.jsonl",
                  mtimeMs: outcome.source.mtimeMs,
                  size: 100,
                },
                head: {
                  nativeId: providerSessionId,
                  cwd: "/workspace/selected",
                  title: "Selected CLI session",
                  firstPrompt: "Selected prompt",
                },
              }),
            readNative: () =>
              Effect.sync(() => {
                reads++;
                return { cwd: "/workspace/selected", outcome };
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: (input) =>
              Effect.sync(() => {
                bootstraps++;
                expect(input.workspaceRoot).toBe("/workspace/selected");
                return { project: { id: projectId } as never, created: true };
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              imported
                ? Effect.succeed({
                    thread: {
                      id: threadId,
                      projectId,
                      historyOrigin: "v1_import",
                      deletedAt: null,
                    },
                  } as never)
                : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                imported = true;
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            upsert: (input) => Effect.sync(() => void upserts.push(input)),
            recordImportedTranscript: () => Effect.void,
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            findNativeSessionThreads: () =>
              Effect.succeed(
                linkedAppThread
                  ? [{ providerInstanceId, nativeId: providerSessionId, threadId: linkedAppThread }]
                  : [],
              ),
          }),
          IdAllocator.layer,
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        ThreadCommandExecutor.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const warning = yield* importer
        .openNative({ sessionKey: "selected-session" })
        .pipe(Effect.flip);
      expect(warning.reason).toBe("active");
      expect(reads).toBe(0);
      expect(writes).toHaveLength(0);
      const opened = yield* Effect.all(
        [
          importer.openNative({ sessionKey: "selected-session", confirmActive: true }),
          importer.openNative({ sessionKey: "selected-session", confirmActive: true }),
        ],
        { concurrency: 2 },
      );
      expect(opened).toEqual([
        { threadId, reused: false },
        { threadId, reused: true },
      ]);
      expect(bootstraps).toBe(1);
      expect(reads).toBe(1);
      expect(writes).toHaveLength(1);
      expect(upserts).toEqual([
        expect.objectContaining({
          providerInstanceId,
          resumeCursor: { threadId: providerSessionId },
          runtimePayload: { cwd: "/workspace/selected" },
        }),
      ]);
      expect((yield* importer.discoverNative({})).sessions[0]?.importedThreadId).toBe(threadId);
      expect(
        (yield* importer.previewNative({ sessionKey: "selected-session" })).session
          .importedThreadId,
      ).toBe(threadId);
      active = false;
      expect(yield* importer.openNative({ sessionKey: "selected-session" })).toEqual({
        threadId,
        reused: true,
      });
      linkedAppThread = ThreadId.make("existing-app-chat");
      expect(yield* importer.openNative({ sessionKey: "selected-session" })).toEqual({
        threadId: linkedAppThread,
        reused: true,
      });
      expect(writes).toHaveLength(1);
    }).pipe(Effect.provide(layerTest));
  },
);

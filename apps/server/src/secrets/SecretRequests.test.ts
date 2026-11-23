import * as ApiKeyStore from "./ApiKeyStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ApiKeyName,
  ProjectId,
  type OrchestrationV2ServerCommand,
  SecretRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");

/** Runs `body` against the service with an in-memory store and a thread holding one request. */
const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
    readonly keyOperations: string[];
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly delivery?: "file";
    readonly directory?: string;
    readonly runStatus?: string;
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly removeFails?: boolean;
    /** The agent's wait closes the card just before the answer's record lands. */
    readonly closedFirst?: boolean;
    /** How many record dispatches fail before one succeeds. */
    readonly failedRecords?: number;
    readonly committedFailures?: number;
    readonly apiKey?: boolean;
    readonly settingsWrite?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const keyOperations: string[] = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    let committedFailures = options.committedFailures ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          // Yields like a real file read, so concurrent callers can interleave.
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              projectId,
              archivedAt: options.archived ? DateTime.makeUnsafe(0) : null,
              deletedAt: options.deleted ? DateTime.makeUnsafe(0) : null,
            },
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.apiKey ? { apiKey: { name: "FAKE_API_KEY" } } : {}),
                ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            // Like the orchestrator, a card that is no longer pending keeps its answer.
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          }).pipe(
            Effect.flatMap((result) => {
              if (committedFailures > 0) {
                committedFailures--;
                return Effect.fail(new Error("fake post-commit failure") as never);
              }
              return Effect.succeed(result);
            }),
          );
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({
        service: {
          ...service,
          answer: (input, settingsWrite = options.settingsWrite ?? true) =>
            service.answer(input, settingsWrite),
        },
        stored,
        dispatched,
        keyOperations,
      });
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(
            Layer.mock(ApiKeyStore.ApiKeyStore)({
              list: () =>
                Effect.sync(() => {
                  const id = keyOperations
                    .find((operation) => operation.startsWith("save:"))
                    ?.slice(5);
                  return id === undefined
                    ? []
                    : [
                        {
                          id,
                          name: ApiKeyName.make("FAKE_API_KEY"),
                          label: "Test",
                          scope: "all" as const,
                          threadId: null,
                          createdAt: 0,
                          expiresAt: 10_000,
                        },
                      ];
                }),
              save: (input) =>
                Effect.sync(() => {
                  keyOperations.push(`save:${input.requestId}`);
                  assert.equal(input.name, "FAKE_API_KEY");
                  assert.equal(input.scope, "all");
                  assert.equal(input.expiresAt, 10_000);
                  return {
                    id: input.requestId!,
                    name: input.name,
                    label: input.label,
                    scope: input.scope,
                    threadId: null,
                    createdAt: 0,
                    expiresAt: input.expiresAt,
                  };
                }),
              remove: (id) => Effect.sync(() => void keyOperations.push(`remove:${id}`)),
              finalize: (id) => Effect.sync(() => void keyOperations.push(`finalize:${id}`)),
            }),
          ),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  });

/** The secret values in the store, leaving out the server's own salt. */
const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
      });
      assert.notInclude(JSON.stringify(dispatched), "ghp_secret");
      assert.include(dispatched[0] as object, {
        answerNoticeSummary: 'The user saved "GitHub token".',
      });

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      // Used once: the value is gone from the store and the ref fails.
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.all(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })].map(
          Effect.result,
        ),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "already_answered");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a save whose record and cleanup both failed is finished by saving again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Option.isSome(yield* service.savedRef({ threadId, turnItemId })));
      }),
    { failedRecords: 1, removeFails: true },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      // A failed attempt from another project does not burn the ref.
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        // Store names never grow with the thread id, so they fit any filesystem.
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect.each(["save", "decline"] as const)(
  "answers %s after the asking run ended, once",
  (type) =>
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const answer = type === "save" ? { type, secret: "fake-value" } : { type };
          yield* service.answer({ threadId, turnItemId, answer });
          const command = dispatched[0];
          assert.equal(command?.type, "secret_request.record");
          if (command?.type !== "secret_request.record") return;
          assert.include(
            command.answerNotice!,
            type === "save" ? "secretRef: secret-ref:" : 'declined "GitHub token"',
          );
          assert.isFalse(command.answerNotice!.includes("fake-value"));
          assert.equal(
            (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
            "already_answered",
          );
          assert.lengthOf(dispatched, 1);
        }),
      { runStatus: "completed" },
    ),
);

it.effect.each([{ archived: true }, { deleted: true }])("refuses unavailable chats %o", (options) =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "fake-value" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "thread_unavailable");
        assert.deepEqual(valuesOf(stored), []);
        assert.lengthOf(dispatched, 0);
      }),
    options,
  ),
);

it.effect("drops values nobody used once they expire, and keeps the rest", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const encode = (savedAt: number) =>
      new TextEncoder().encode(
        `{"projectId":"project-1","value":"ghp_secret","savedAt":${savedAt}}`,
      );
    yield* TestClock.adjust("2 days");
    const now = yield* Clock.currentTimeMillis;
    const stale = `secret-request-${"a".repeat(32)}`;
    const fresh = `secret-request-${"b".repeat(32)}`;
    yield* store.set(stale, encode(now - 25 * 60 * 60 * 1000));
    yield* store.set(fresh, encode(now));
    yield* store.set("unrelated", new Uint8Array([1]));

    // Building the service runs the first sweep.
    yield* Effect.gen(function* () {
      yield* SecretRequests.SecretRequests;
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(
            Layer.mock(ApiKeyStore.ApiKeyStore)({
              save: (input) =>
                Effect.sync(() => {
                  assert.equal(input.name, "FAKE_API_KEY");
                  assert.equal(input.scope, "all");
                  assert.equal(input.expiresAt, 10_000);
                  return {
                    id: "fake-vault-key",
                    name: input.name,
                    label: input.label,
                    scope: input.scope,
                    threadId: null,
                    createdAt: 0,
                    expiresAt: input.expiresAt,
                  };
                }),
              remove: () => Effect.void,
            }),
          ),
          Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
        ),
      ),
      Effect.scoped,
    );

    assert.isTrue(Option.isNone(yield* store.get(stale)));
    assert.isTrue(Option.isSome(yield* store.get(fresh)));
    assert.isTrue(Option.isSome(yield* store.get("unrelated")));
    assert.isTrue(Option.isSome(yield* store.get("secret-request-salt")));
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-requests-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

it.effect(
  "API key answers record metadata and status only, and never enter the one-use file store",
  () =>
    withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: {
              type: "save",
              secret: "obviously-fake-api-key",
              scope: "all",
              expiresAt: 10_000,
            },
          });
          assert.equal(dispatched.length, 1);
          assert.include(dispatched[0] as object, { secretStatus: "saved" });
          assert.isFalse(JSON.stringify(dispatched).includes("obviously-fake-api-key"));
          assert.lengthOf(valuesOf(stored), 0);
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
        }),
      { apiKey: true },
    ),
);

const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

it.effect("a file request moves its value to an owner-only file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "sudo-pass'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          assert.include(dispatched[0] as object, {
            answerNoticeSummary: 'The user saved "GitHub token".',
          });
          assert.notInclude(JSON.stringify(dispatched), "sudo-pass'$(id)");
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "sudo-pass'$(id)");
          assert.deepEqual(valuesOf(stored), []);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // A retried request_secret gets the same file; the value is never a ref again.
          assert.equal(yield* service.saveToFile({ threadId, turnItemId }), file);
          // The agent is told when the file goes: 24 hours after it was written.
          const written = Option.getOrThrow((yield* fs.stat(file)).mtime).getTime();
          const deletedAt = yield* service.fileDeletedAt(file);
          assert.equal(Date.parse(deletedAt), written + 24 * 60 * 60 * 1000);
          const notice = dispatched[0];
          assert.isTrue(
            notice?.type === "secret_request.record" &&
              notice.answerNotice?.includes(`It is deleted ${deletedAt} (24 hours)`),
          );
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }),
      { delivery: "file", directory },
    );

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed file write leaves the card pending and can retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const files = path.join(directory, "files");
    yield* fs.writeFileString(files, "block");
    yield* withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const input = {
            threadId,
            turnItemId,
            answer: { type: "save" as const, secret: "sudo-pass" },
          };
          assert.equal((yield* service.answer(input).pipe(Effect.flip)).reason, "store_failed");
          assert.lengthOf(dispatched, 0);
          yield* fs.remove(files);
          yield* service.answer(input);
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "sudo-pass");
          const record = dispatched[0];
          assert.isTrue(
            record?.type === "secret_request.record" && record.answerNotice?.includes(file),
          );
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file is not delivered while its stored copy cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const input = {
            threadId,
            turnItemId,
            answer: { type: "save" as const, secret: "sudo-pass" },
          };
          const first = yield* service.answer(input).pipe(Effect.flip);
          assert.equal(first.reason, "consume_failed");
          // A retry finds the file but still will not hand it out until the removal works.
          const retried = yield* service.answer(input).pipe(Effect.flip);
          assert.equal(retried.reason, "consume_failed");
        }),
      { delivery: "file", directory, removeFails: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never written to a file", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

it.effect.each(["dispatch failure", "closed card"] as const)(
  "API key replacement retains the previous credential on %s",
  (failure) =>
    withService(
      ({ service, keyOperations }) =>
        Effect.gen(function* () {
          const input = {
            threadId,
            turnItemId,
            answer: {
              type: "save" as const,
              secret: "fake-placeholder",
              scope: "all" as const,
              expiresAt: 10_000,
            },
          };
          const error = yield* service.answer(input).pipe(Effect.flip);
          assert.equal(
            error.reason,
            failure === "closed card" ? "already_answered" : "record_failed",
          );
          assert.isFalse(keyOperations.some((op) => op.startsWith("finalize:")));
          if (failure === "dispatch failure") {
            assert.lengthOf(keyOperations, 1);
            yield* service.answer(input);
            assert.equal(keyOperations[0], keyOperations[1]);
            assert.equal(keyOperations[2], keyOperations[0]!.replace("save:", "finalize:"));
          } else {
            assert.equal(keyOperations[1], keyOperations[0]!.replace("save:", "remove:"));
          }
        }),
      {
        apiKey: true,
        failedRecords: failure === "dispatch failure" ? 1 : 0,
        closedFirst: failure === "closed card",
      },
    ),
);

it.effect("an ambiguous committed API key answer can finish replacement on retry", () =>
  withService(
    ({ service, keyOperations }) =>
      Effect.gen(function* () {
        const input = {
          threadId,
          turnItemId,
          answer: {
            type: "save" as const,
            secret: "fake-placeholder",
            scope: "all" as const,
            expiresAt: 10_000,
          },
        };
        assert.equal((yield* service.answer(input).pipe(Effect.flip)).reason, "record_failed");
        assert.lengthOf(keyOperations, 1);
        yield* service.answer(input);
        assert.equal(keyOperations[1], keyOperations[0]!.replace("save:", "finalize:"));
      }),
    { apiKey: true, committedFailures: 1 },
  ),
);

it.effect("requires settings-write before saving an environment-wide API key", () =>
  withService(
    ({ service, keyOperations, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "test-key", scope: "all", expiresAt: 10_000 },
          })
          .pipe(Effect.flip);
        assert.equal(error.reason, "settings_write_required");
        assert.deepEqual(keyOperations, []);
        assert.deepEqual(dispatched, []);
      }),
    { apiKey: true, settingsWrite: false },
  ),
);

it.effect("rechecks settings-write when retrying an already saved environment-wide key", () =>
  withService(
    ({ service, keyOperations }) =>
      Effect.gen(function* () {
        yield* service.answer(
          {
            threadId,
            turnItemId,
            answer: { type: "save", secret: "test-key", scope: "all", expiresAt: 10_000 },
          },
          true,
        );
        const before = [...keyOperations];
        for (const answer of [
          { type: "decline" } as const,
          { type: "save", secret: "replacement", scope: "chat" } as const,
        ]) {
          const error = yield* service
            .answer({ threadId, turnItemId, answer }, false)
            .pipe(Effect.flip);
          assert.equal(error.reason, "settings_write_required");
        }
        assert.deepEqual(keyOperations, before);
      }),
    { apiKey: true },
  ),
);

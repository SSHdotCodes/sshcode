/**
 * SecretRequests - secrets an agent asks the user for.
 *
 * The user's answer goes straight to the server's secret store under a
 * one-use SecretRef; orchestration records only the request, status and handles.
 * A tool that needs the value takes the ref and consumes it, so the value
 * never reaches the transcript, projections, clients, or model context.
 * A `file` request instead moves its value to an owner-only file for the
 * agent's own shell (sudo passwords, CLI tokens); its card says so.
 *
 * @module SecretRequests
 */
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  TurnItemId,
  type ProjectId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as ApiKeyStore from "./ApiKeyStore.ts";
import * as Redacted from "effect/Redacted";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
/** Store name for a ref's value; refs are fixed-length hex, so names stay short and safe. */
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
/** A value nobody used within this long is dropped; the agent can ask again. */
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

/**
 * Each request has exactly one ref, derived from where it was asked. Its
 * length never depends on the thread id, so the store's file names stay
 * within filesystem limits, and the requesting tool finds it without a
 * second record. Unguessable without the server's own salt.
 */
const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

/** A ref's value, the project it was entered for, and when it was saved. */
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly manageApiKeys: ApiKeyStore.ApiKeyStore["Service"]["manage"];
    /**
     * Answers a pending request in a thread. Saving stores the value under a
     * new ref and queues a handle-only notice to the asking thread.
     */
    readonly answer: (
      input: SecretRequestAnswerInput,
      settingsWrite?: boolean,
    ) => Effect.Effect<void, SecretRequestError>;
    /** The ref minted when this request was saved, for the tool that asked. */
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    /**
     * Reads and deletes a ref's value. Fails for unknown or used refs, and
     * for refs entered in another project.
     */
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /** When the sweep deletes a file `saveToFile` wrote, as an ISO time. */
    readonly fileDeletedAt: (file: string) => Effect.Effect<string>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const apiKeys = yield* ApiKeyStore.ApiKeyStore;
  const answerLock = yield* Semaphore.make(1);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const answer: SecretRequests["Service"]["answer"] = (input, settingsWrite = false) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemIds: [input.turnItemId],
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      if (records.thread.archivedAt != null || records.thread.deletedAt != null) {
        return yield* new SecretRequestError({ reason: "thread_unavailable" });
      }
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      const apiKeyRequestId =
        item.apiKey === undefined ? undefined : `api-key:${refFor(salt, input.threadId, item.id)}`;
      if (item.apiKey !== undefined && !settingsWrite) {
        const keys = yield* apiKeys
          .list()
          .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
        if (
          (input.answer.type === "save" && input.answer.scope === "all") ||
          keys.some((key) => key.id === apiKeyRequestId && key.scope === "all")
        ) {
          return yield* new SecretRequestError({ reason: "settings_write_required" });
        }
      }
      if (item.secretStatus === "saved" && apiKeyRequestId !== undefined) {
        yield* apiKeys
          .finalize(apiKeyRequestId)
          .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
        return;
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      // Store first: the card only says saved once the value is kept. Create,
      // not set: a second answer racing this one must not replace the value.
      // A value already there on a card still pending is an earlier save whose
      // record failed and could not be cleaned up; recording it finishes that save.
      let apiKeyId: string | undefined;
      if (input.answer.type === "save" && item.apiKey !== undefined) {
        const saved = yield* apiKeys
          .save({
            ...(apiKeyRequestId === undefined ? {} : { requestId: apiKeyRequestId }),
            name: item.apiKey.name,
            label: item.label,
            threadId: input.threadId,
            scope: input.answer.scope ?? "chat",
            expiresAt:
              input.answer.expiresAt === undefined
                ? (yield* Clock.currentTimeMillis) + 30 * 86_400_000
                : input.answer.expiresAt,
            value: Redacted.make(input.answer.secret),
          })
          .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
        apiKeyId = saved.id;
      } else if (input.answer.type === "save") {
        const encoded = yield* encodeStored({
          projectId: records.thread.projectId,
          value: input.answer.secret,
          savedAt: yield* Clock.currentTimeMillis,
        }).pipe(Effect.orDie);
        yield* store
          .create(
            storeName(refFor(salt, input.threadId, item.id)),
            new TextEncoder().encode(encoded),
          )
          .pipe(
            Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
            Effect.mapError(
              (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
            ),
          );
      }
      const ref = refFor(salt, input.threadId, item.id);
      const file =
        input.answer.type === "save" && item.apiKey === undefined && item.delivery === "file"
          ? yield* writeSecretFile(ref, records.thread.projectId)
          : undefined;
      const answerNoticeSummary =
        input.answer.type === "decline"
          ? `The user declined "${item.label}".`
          : `The user saved "${item.label}".`;
      const answerNotice =
        input.answer.type === "decline"
          ? answerNoticeSummary
          : item.apiKey !== undefined
            ? `${answerNoticeSummary} API key saved privately. Call list_api_keys to check availability, then prepare_api_key to get a one-use sshcode secret run command. Never ask for the value in chat.`
            : file !== undefined
              ? `${answerNoticeSummary} File: ${file}. Read it inside commands, never print it. It is deleted ${yield* fileDeletedAt(file)} (24 hours); a key needed longer uses request_api_key.`
              : `${answerNoticeSummary} secretRef: ${ref}`;
      const secretStatus = input.answer.type === "save" ? "saved" : "declined";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          ...(item.apiKey === undefined ? {} : { apiKey: item.apiKey }),
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          secretStatus,
          answerNotice,
          answerNoticeSummary,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // A transport failure may follow a committed answer. Keep its handles if
          // committed or unreadable; otherwise remove the value and any private file.
          Effect.tapError(() =>
            Effect.gen(function* () {
              const current = yield* threadManagement
                .getThreadRecords(input.threadId, ["turnItems"], {
                  turnItemIds: [item.id],
                  turnItemTypes: ["secret_request"],
                  messageRoles: [],
                })
                .pipe(Effect.option);
              if (Option.isNone(current)) return;
              const card = current.value.turnItems.find((candidate) => candidate.id === item.id);
              if (card?.type === "secret_request" && card.secretStatus === "saved") return;
              if (input.answer.type === "save" && apiKeyId === undefined) {
                yield* removeLogged(storeName(ref));
                if (file !== undefined)
                  yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
              }
            }),
          ),
        );
      if (input.answer.type !== "save") return;
      // Another answer may have won outside this service instance. Keep only its value.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemIds: [item.id],
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type !== "secret_request" || card.secretStatus !== "saved") {
        if (apiKeyId !== undefined) yield* apiKeys.remove(apiKeyId).pipe(Effect.ignore);
        else yield* removeLogged(storeName(refFor(salt, input.threadId, item.id)));
        if (file !== undefined) yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      if (apiKeyId !== undefined)
        yield* apiKeys
          .finalize(apiKeyId)
          .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
    }).pipe(answerLock.withPermits(1), Effect.withSpan("SecretRequests.answer"));

  const savedRef: SecretRequests["Service"]["savedRef"] = (input) =>
    Effect.gen(function* () {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    });

  /** Removes a stored value; a failure is logged, since the value is still on disk. */
  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // get and remove are separate store calls; one consumer at a time keeps two
  // concurrent calls from both reading a ref before either deletes it.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's value, left in the store. */
  const readRef = (input: { readonly ref: SecretRef; readonly projectId: ProjectId }) =>
    Effect.gen(function* () {
      if (!REF_PATTERN.test(input.ref))
        return yield* new SecretRequestError({ reason: "invalid_ref" });
      const stored = yield* store
        .get(storeName(input.ref))
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
        return yield* new SecretRequestError({ reason: "ref_unavailable" });
      }
      if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
        // The hourly sweep retries a removal that fails here.
        yield* removeLogged(storeName(input.ref));
        return yield* new SecretRequestError({ reason: "ref_expired" });
      }
      return decoded.value.value;
    });

  const consumeRef = (input: { readonly ref: SecretRef; readonly projectId: ProjectId }) =>
    Effect.gen(function* () {
      const value = yield* readRef(input);
      // One use: the value moves into whatever consumed it. If it cannot be
      // deleted, it is not handed out, so a ref is never used twice.
      if (!(yield* removeLogged(storeName(input.ref)))) {
        return yield* new SecretRequestError({ reason: "consume_failed" });
      }
      return value;
    });

  const writeSecretFile = (ref: SecretRef, projectId: ProjectId) =>
    Effect.gen(function* () {
      if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
      const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
      return yield* Effect.gen(function* () {
        // One use: the file counts as delivered only once the stored copy is gone. A retry with
        // the same clientRequestId gets the file the first call wrote and finishes that removal.
        const removeStored = removeLogged(storeName(ref)).pipe(
          Effect.flatMap((removed) =>
            removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
          ),
        );
        if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
          return yield* removeStored;
        }
        // The stored value goes only after the file is complete, so a failed write can retry.
        const value = yield* readRef({ ref, projectId });
        const partial = `${file}.partial`;
        yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
          Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
          Effect.andThen(fileSystem.remove(partial, { force: true })),
          // `wx` never follows or replaces an existing path.
          Effect.andThen(
            fileSystem.writeFile(partial, new TextEncoder().encode(value), {
              flag: "wx",
              mode: 0o600,
            }),
          ),
          Effect.andThen(fileSystem.rename(partial, file)),
          Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
        );
        return yield* removeStored;
      }).pipe(consumeLock.withPermits(1));
    });

  // The sweep counts from the file's own time, so this does too.
  const fileDeletedAt: SecretRequests["Service"]["fileDeletedAt"] = (file) =>
    Effect.gen(function* () {
      const written = yield* fileSystem.stat(file).pipe(
        Effect.map((info) => Option.map(info.mtime, (time) => time.getTime())),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      const from = Option.isSome(written) ? written.value : yield* Clock.currentTimeMillis;
      return DateTime.formatIso(DateTime.makeUnsafe(from + SECRET_REF_TTL_MS));
    });

  const saveToFile: SecretRequests["Service"]["saveToFile"] = (input) =>
    Effect.gen(function* () {
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemIds: [TurnItemId.make(input.turnItemId)],
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      // Only a card that told the user the agent's commands can read the value may write it out.
      if (
        item?.type !== "secret_request" ||
        item.secretStatus !== "saved" ||
        item.delivery !== "file"
      ) {
        return yield* new SecretRequestError({ reason: "not_a_file_request" });
      }
      return yield* writeSecretFile(
        refFor(salt, input.threadId, item.id),
        records.thread.projectId,
      );
    }).pipe(Effect.withSpan("SecretRequests.saveToFile"));

  /**
   * Drops values nobody used before they expired, so an agent that never
   * consumed its ref does not leave the user's secret on disk.
   */
  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  /** Shell files follow the same 24-hour limit, measured from when they were written. */
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  // Once at startup, then hourly; a value lingers at most an hour past expiry.
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({
    answer,
    savedRef,
    consume,
    saveToFile,
    fileDeletedAt,
    manageApiKeys: apiKeys.manage,
  });
});

export const layer = Layer.effect(SecretRequests, make);

import {
  ApiKeyError,
  ApiKeyMetadata,
  ApiKeyName,
  type ApiKeyManageInput,
  type ApiKeyScope,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as ApiKeyVault from "./ApiKeyVault.ts";

export class ApiKeyStore extends Context.Service<
  ApiKeyStore,
  {
    readonly manage: (
      input: ApiKeyManageInput,
    ) => Effect.Effect<ReadonlyArray<ApiKeyMetadata>, ApiKeyError>;
    readonly save: (input: {
      readonly name: string;
      readonly label: string;
      readonly scope: ApiKeyScope;
      readonly threadId: ThreadId;
      readonly expiresAt: number | null;
      readonly value: Redacted.Redacted<string>;
      /** A request-bound save keeps previous credentials until finalize. */
      readonly requestId?: string;
    }) => Effect.Effect<ApiKeyMetadata, ApiKeyError>;
    readonly finalize: (id: string) => Effect.Effect<void, ApiKeyError>;
    readonly list: (
      threadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ApiKeyMetadata>, ApiKeyError>;
    readonly updateExpiry: (input: {
      readonly id: string;
      readonly expiresAt: number | null;
    }) => Effect.Effect<void, ApiKeyError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiKeyError>;
    readonly sweep: Effect.Effect<void, ApiKeyError>;
    readonly prepare: (name: string, threadId: ThreadId) => Effect.Effect<string, ApiKeyError>;
    /**
     * A key saved for all sessions, for the server's own features. Never return
     * the value to an agent or client.
     */
    readonly shared: (
      name: string,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, ApiKeyError>;
    /** `sshcode secret run` as an agent's shell can invoke it, even without `sshcode` on PATH. */
    readonly secretRunCommand: Effect.Effect<string>;
    /** Only the local CLI transport redeems a ticket. Never expose this as an MCP or client RPC. */
    readonly redeem: (
      ticket: string,
    ) => Effect.Effect<
      { readonly name: string; readonly value: Redacted.Redacted<string> },
      ApiKeyError
    >;
  }
>()("t3/secrets/ApiKeyStore") {}

const isApiKeyName = Schema.is(ApiKeyName);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const vault = yield* ApiKeyVault.ApiKeyVault;
  const lock = yield* Semaphore.make(1);
  const metadataPath = path.join(config.stateDir, "sshcode-api-keys.json");
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ApiKeyMetadata)));
  const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ApiKeyMetadata)));
  const storageError = () => new ApiKeyError({ reason: "storage" });
  const load = fs.readFileString(metadataPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("[]") : Effect.fail(storageError()),
    ),
    Effect.flatMap(decode),
    Effect.mapError(storageError),
  );
  const persist = (items: ReadonlyArray<ApiKeyMetadata>) =>
    Effect.gen(function* () {
      const text = yield* encode(items).pipe(Effect.mapError(storageError));
      const temporaryPath = `${metadataPath}.tmp`;
      yield* fs
        .writeFileString(temporaryPath, text, { mode: 0o600 })
        .pipe(Effect.mapError(storageError));
      yield* fs.chmod(temporaryPath, 0o600).pipe(Effect.mapError(storageError));
      yield* fs.rename(temporaryPath, metadataPath).pipe(Effect.mapError(storageError));
    });
  const expired = (item: ApiKeyMetadata, now: number) =>
    item.expiresAt !== null && item.expiresAt <= now;
  const validateExpiry = (expiresAt: number | null) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now)
          ? Effect.void
          : Effect.fail(new ApiKeyError({ reason: "invalid_expiry" })),
      ),
    );
  const sweepUnlocked = Effect.gen(function* () {
    const items = yield* load;
    const now = yield* Clock.currentTimeMillis;
    const live: ApiKeyMetadata[] = [];
    for (const item of items) {
      if (expired(item, now)) yield* vault.remove(item.id);
      else live.push(item);
    }
    if (live.length !== items.length) yield* persist(live);
    return live;
  });
  const removeUnlocked = (id: string) =>
    Effect.gen(function* () {
      const items = yield* load;
      if (!items.some((item) => item.id === id)) return;
      // Delete the credential first. If metadata persistence fails, reads fail closed.
      yield* vault.remove(id);
      yield* persist(items.filter((item) => item.id !== id));
    });
  const finalizeUnlocked = (id: string) =>
    Effect.gen(function* () {
      const items = yield* load;
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined || (yield* vault.get(id)) === undefined)
        return yield* new ApiKeyError({ reason: "unavailable" });
      for (const previous of items) {
        if (
          previous.id !== id &&
          previous.name === item.name &&
          previous.scope === item.scope &&
          previous.threadId === item.threadId
        )
          yield* removeUnlocked(previous.id);
      }
    });
  const visible = (item: ApiKeyMetadata, threadId: ThreadId) =>
    item.scope === "all" || item.threadId === threadId;
  const find = (name: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const items = (yield* sweepUnlocked).filter(
        (item) => item.name === name && visible(item, threadId),
      );
      const item = items.find((item) => item.scope === "chat") ?? items[0];
      if (item === undefined) return yield* new ApiKeyError({ reason: "unavailable" });
      const value = yield* vault.get(item.id);
      if (value === undefined) return yield* new ApiKeyError({ reason: "unavailable" });
      // Unlocking the credential vault may have taken past the deadline.
      if (expired(item, yield* Clock.currentTimeMillis)) {
        yield* removeUnlocked(item.id);
        return yield* new ApiKeyError({ reason: "unavailable" });
      }
      return { item, value };
    });
  // Tickets are deliberately memory-only, bound to a key id and the authenticated MCP thread.
  const tickets = new Map<
    string,
    { id: string; name: string; threadId: ThreadId; expiresAt: number }
  >();
  const sweep = sweepUnlocked.pipe(Effect.asVoid, lock.withPermits(1));
  const store: ApiKeyStore["Service"] = ApiKeyStore.of({
    manage: (input) =>
      Effect.gen(function* () {
        if (input.action === "update") yield* store.updateExpiry(input);
        if (input.action === "delete") yield* store.remove(input.id);
        return yield* store.list();
      }),
    save: (input) =>
      Effect.gen(function* () {
        yield* validateExpiry(input.expiresAt);
        const raw = Redacted.value(input.value);
        if (!isApiKeyName(input.name) || !raw.trim() || raw.includes("\0") || raw.length > 16_384) {
          return yield* new ApiKeyError({ reason: "invalid_key" });
        }
        const items = yield* sweepUnlocked;
        const id =
          input.requestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError)));
        const existing = items.find((item) => item.id === id);
        if (existing !== undefined) {
          // A retry must finish the same save, never replace its value.
          if ((yield* vault.get(id)) === undefined) yield* vault.set(id, input.value);
          return existing;
        }
        const item: ApiKeyMetadata = {
          id,
          name: input.name,
          label: input.label,
          scope: input.scope,
          threadId: input.scope === "chat" ? input.threadId : null,
          createdAt: yield* Clock.currentTimeMillis,
          expiresAt: input.expiresAt,
        };
        // Metadata first means a crash can never leave an untracked credential behind.
        yield* persist([...items, item]);
        yield* vault
          .set(item.id, input.value)
          .pipe(Effect.tapError(() => persist(items).pipe(Effect.ignore)));
        if (input.requestId === undefined) yield* finalizeUnlocked(item.id);
        return item;
      }).pipe(lock.withPermits(1)),
    finalize: (id) => finalizeUnlocked(id).pipe(lock.withPermits(1)),
    list: (threadId) =>
      sweepUnlocked.pipe(
        Effect.map((items) =>
          threadId === undefined ? items : items.filter((item) => visible(item, threadId)),
        ),
        lock.withPermits(1),
      ),
    updateExpiry: (input) =>
      Effect.gen(function* () {
        yield* validateExpiry(input.expiresAt);
        const items = yield* sweepUnlocked;
        if (!items.some((item) => item.id === input.id))
          return yield* new ApiKeyError({ reason: "unavailable" });
        yield* persist(
          items.map((item) =>
            item.id === input.id ? { ...item, expiresAt: input.expiresAt } : item,
          ),
        );
      }).pipe(lock.withPermits(1)),
    remove: (id) => removeUnlocked(id).pipe(lock.withPermits(1)),
    sweep,
    secretRunCommand: resolveHostCliCommand("secret run").pipe(
      Effect.map(({ command }) => command),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    ),
    shared: (name) =>
      Effect.gen(function* () {
        const item = (yield* sweepUnlocked).find(
          (candidate) => candidate.name === name && candidate.scope === "all",
        );
        return item === undefined ? undefined : yield* vault.get(item.id);
      }).pipe(lock.withPermits(1)),
    prepare: (name, threadId) =>
      Effect.gen(function* () {
        const { item } = yield* find(name, threadId);
        const now = yield* Clock.currentTimeMillis;
        for (const [token, record] of tickets) if (record.expiresAt <= now) tickets.delete(token);
        // The letter keeps a ticket from starting with "-", which the CLI reads as a flag.
        const token = `t${Buffer.from(
          yield* crypto.randomBytes(32).pipe(Effect.mapError(storageError)),
        ).toString("base64url")}`;
        tickets.set(token, { id: item.id, name, threadId, expiresAt: now + 60_000 });
        return token;
      }).pipe(lock.withPermits(1)),
    redeem: (token) =>
      Effect.gen(function* () {
        const ticket = tickets.get(token);
        tickets.delete(token);
        if (ticket === undefined || ticket.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* new ApiKeyError({ reason: "invalid_ticket" });
        const { item, value } = yield* find(ticket.name, ticket.threadId);
        // A vault unlock can outlast the ticket, even when the key itself never expires.
        if (ticket.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* new ApiKeyError({ reason: "invalid_ticket" });
        if (item.id !== ticket.id) return yield* new ApiKeyError({ reason: "unavailable" });
        return { name: item.name, value };
      }).pipe(lock.withPermits(1)),
  });
  const sweepSafely = sweep.pipe(
    Effect.catch(() => Effect.logWarning("Could not sweep expired API keys")),
  );
  yield* sweepSafely;
  yield* Effect.sleep("1 minute").pipe(
    Effect.andThen(sweepSafely),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );
  return store;
});

export const layer = Layer.effect(ApiKeyStore, make);
export const layerLive = layer.pipe(Layer.provide(ApiKeyVault.layer));

import * as ApiKeyStore from "./ApiKeyStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ApiKeyVault from "./ApiKeyVault.ts";

const thread = ThreadId.make("chat-one");
const other = ThreadId.make("chat-two");
const fake = "obviously-fake-api-key-for-tests";
const withStore = <A, E, R>(
  body: (
    store: ApiKeyStore.ApiKeyStore["Service"],
    directory: string,
    removed: Queue.Queue<string>,
  ) => Effect.Effect<A, E, R>,
  beforeGet: () => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const removed = yield* Queue.unbounded<string>();
    const vault = Layer.effect(
      ApiKeyVault.ApiKeyVault,
      Effect.gen(function* () {
        const inner = yield* ApiKeyVault.ApiKeyVault;
        return ApiKeyVault.ApiKeyVault.of({
          ...inner,
          get: (id) => beforeGet().pipe(Effect.andThen(inner.get(id))),
          remove: (id) => inner.remove(id).pipe(Effect.tap(() => Queue.offer(removed, id))),
        });
      }),
    ).pipe(Layer.provide(ApiKeyVault.layerMemory));
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sshcode-api-key-test-" });
    return yield* Effect.gen(function* () {
      return yield* body(yield* ApiKeyStore.ApiKeyStore, `${directory}/userdata`, removed);
    }).pipe(
      Effect.provide(
        ApiKeyStore.layer.pipe(
          Layer.provide(Layer.mergeAll(vault, ServerConfig.layerTest(directory, directory))),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped);

const save = (
  store: ApiKeyStore.ApiKeyStore["Service"],
  scope: "chat" | "all",
  expiresAt: number | null = null,
) =>
  store.save({
    name: "FAKE_API_KEY",
    label: "Fake service",
    scope,
    threadId: thread,
    expiresAt,
    value: Redacted.make(fake),
  });

it.effect("enforces scope and gives metadata only; chat keys override shared keys", () =>
  withStore((store, directory) =>
    Effect.gen(function* () {
      const chat = yield* save(store, "chat");
      assert.lengthOf(yield* store.list(thread), 1);
      assert.lengthOf(yield* store.list(other), 0);
      assert.equal(
        (yield* store.prepare("FAKE_API_KEY", other).pipe(Effect.flip)).reason,
        "unavailable",
      );
      const shared = yield* save(store, "all");
      assert.lengthOf(yield* store.list(other), 1);
      const ticket = yield* store.prepare("FAKE_API_KEY", thread);
      const value = yield* store.redeem(ticket);
      assert.equal(Redacted.value(value.value), fake);
      assert.equal((yield* store.redeem(ticket).pipe(Effect.flip)).reason, "invalid_ticket");
      const fs = yield* FileSystem.FileSystem;
      const metadata = yield* fs.readFileString(`${directory}/sshcode-api-keys.json`);
      assert.isFalse(metadata.includes(fake));
      assert.isFalse(JSON.stringify(yield* store.list()).includes(fake));
      assert.isFalse(JSON.stringify(value).includes(fake));
      yield* store.remove(chat.id);
      yield* store.remove(shared.id);
      assert.lengthOf(yield* store.list(), 0);
    }),
  ),
);

it.effect("expiry is checked at read even before a periodic sweep", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* save(store, "chat", 1_000);
      const ticket = yield* store.prepare("FAKE_API_KEY", thread);
      yield* TestClock.adjust(1_000);
      assert.equal((yield* store.redeem(ticket).pipe(Effect.flip)).reason, "unavailable");
      assert.lengthOf(yield* store.list(), 0);
    }),
  ),
);

it.effect("sweep supports never and expiry edits and rejects past dates", () =>
  withStore((store, directory) =>
    Effect.gen(function* () {
      const key = yield* save(store, "all", 30_000);
      assert.equal(
        (yield* store.updateExpiry({ id: key.id, expiresAt: 0 }).pipe(Effect.flip)).reason,
        "invalid_expiry",
      );
      yield* store.updateExpiry({ id: key.id, expiresAt: null });
      yield* TestClock.adjust(60_000);
      assert.lengthOf(yield* store.list(), 1);
      yield* store.updateExpiry({ id: key.id, expiresAt: 70_000 });
      yield* TestClock.adjust(60_000);
      yield* store.sweep;
      const fs = yield* FileSystem.FileSystem;
      assert.equal(yield* fs.readFileString(`${directory}/sshcode-api-keys.json`), "[]");
    }),
  ),
);

it.effect("tickets expire, and replacement and deletion revoke outstanding access", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* save(store, "chat");
      const ticket = yield* store.prepare("FAKE_API_KEY", thread);
      yield* TestClock.adjust(60_000);
      assert.equal((yield* store.redeem(ticket).pipe(Effect.flip)).reason, "invalid_ticket");
      const replaced = yield* store.prepare("FAKE_API_KEY", thread);
      const key = yield* save(store, "chat");
      assert.lengthOf(yield* store.list(), 1);
      assert.equal((yield* store.redeem(replaced).pipe(Effect.flip)).reason, "unavailable");
      const deleted = yield* store.prepare("FAKE_API_KEY", thread);
      yield* store.remove(key.id);
      assert.equal((yield* store.redeem(deleted).pipe(Effect.flip)).reason, "unavailable");
    }),
  ),
);

it.effect("does not redeem a ticket that expires while the vault is unlocking", () =>
  Effect.gen(function* () {
    const unlocking = yield* Deferred.make<void>();
    const unlocked = yield* Deferred.make<void>();
    let waitForUnlock = false;
    yield* withStore(
      (store) =>
        Effect.gen(function* () {
          yield* save(store, "chat");
          const ticket = yield* store.prepare("FAKE_API_KEY", thread);
          waitForUnlock = true;
          const redemption = yield* store.redeem(ticket).pipe(Effect.forkChild);
          yield* Deferred.await(unlocking);
          yield* TestClock.adjust(60_000);
          yield* Deferred.succeed(unlocked, undefined);
          const error = yield* Fiber.join(redemption).pipe(Effect.flip);
          assert.equal(error.reason, "invalid_ticket");
          assert.equal((yield* store.redeem(ticket).pipe(Effect.flip)).reason, "invalid_ticket");
        }),
      () =>
        waitForUnlock
          ? Deferred.succeed(unlocking, undefined).pipe(Effect.andThen(Deferred.await(unlocked)))
          : Effect.void,
    );
  }),
);

it.effect("automatically deletes expired credentials without a read", () =>
  withStore((store, directory, removed) =>
    Effect.gen(function* () {
      const key = yield* save(store, "chat", 1_000);
      yield* TestClock.adjust(60_000);
      assert.equal(yield* Queue.take(removed), key.id);
      yield* store.sweep;
      const fs = yield* FileSystem.FileSystem;
      assert.equal(yield* fs.readFileString(`${directory}/sshcode-api-keys.json`), "[]");
    }),
  ),
);

it.effect("request-bound replacements retain the previous key until accepted and retry by id", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const previous = yield* save(store, "all");
      const ticket = yield* store.prepare("FAKE_API_KEY", thread);
      const input = {
        requestId: "fake-request-key",
        name: "FAKE_API_KEY",
        label: "Fake replacement",
        scope: "all" as const,
        threadId: thread,
        expiresAt: null,
        value: Redacted.make("fake-replacement-placeholder"),
      };
      const staged = yield* store.save(input);
      assert.equal((yield* store.save(input)).id, staged.id);
      assert.deepEqual(
        (yield* store.list()).map((key) => key.id),
        [previous.id, staged.id],
      );
      yield* store.redeem(ticket);
      yield* store.remove(staged.id);
      yield* store.redeem(yield* store.prepare("FAKE_API_KEY", thread));
      const accepted = yield* store.save(input);
      yield* store.finalize(accepted.id);
      yield* store.finalize(accepted.id);
      assert.deepEqual(
        (yield* store.list()).map((key) => key.id),
        [accepted.id],
      );
      yield* store.redeem(yield* store.prepare("FAKE_API_KEY", other));
    }),
  ),
);

it.effect(
  "hands the server only keys saved for all sessions, and tickets never look like flags",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* save(store, "chat");
        assert.strictEqual(yield* store.shared("FAKE_API_KEY"), undefined);
        yield* save(store, "all");
        const shared = yield* store.shared("FAKE_API_KEY");
        assert.strictEqual(shared === undefined ? undefined : Redacted.value(shared), fake);
        assert.strictEqual(yield* store.shared("OTHER_API_KEY"), undefined);
        for (let index = 0; index < 80; index += 1) {
          assert.match(yield* store.prepare("FAKE_API_KEY", thread), /^t[\w-]{43}$/);
        }
      }),
    ),
);

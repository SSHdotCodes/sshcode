// @effect-diagnostics nodeBuiltinImport:off - Replay markers coordinate Node server processes.
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "./ServerSecretStore.ts";

const locks = new WeakMap<ServerSecretStore.ServerSecretStore["Service"], Semaphore.Semaphore>();

/** Serializes replay checks, replacement and pruning, including servers sharing the directory. */
export const withDpopReplayLock = <A, E, R>(
  store: ServerSecretStore.ServerSecretStore["Service"],
  task: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const semaphore = locks.get(store) ?? Semaphore.makeUnsafe(1);
    locks.set(store, semaphore);
    const directory = store.directory;
    if (directory === undefined) return semaphore.withPermit(Effect.uninterruptible(task));
    const failure = (cause: unknown) =>
      new ServerSecretStore.SecretStorePersistError({ resource: "DPoP replay lock", cause });
    return semaphore.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const compromised = yield* Deferred.make<
            never,
            ServerSecretStore.SecretStorePersistError
          >();
          const services = yield* Effect.context<never>();
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                lock(NodePath.join(directory, "dpop-replay"), {
                  realpath: false,
                  // Held for milliseconds per request. A lock left by a crashed server must
                  // expire before a restart takes requests, or phone and relay sign-ins fail.
                  stale: 5_000,
                  update: 1_000,
                  retries: { retries: 100, factor: 1, minTimeout: 10, maxTimeout: 10 },
                  onCompromised: (cause) =>
                    Effect.runSyncWith(services)(Deferred.fail(compromised, failure(cause))),
                }),
              catch: failure,
            }),
            (release) => Effect.promise(() => release()).pipe(Effect.ignore),
          );
          return yield* Effect.raceFirst(task, Effect.interruptible(Deferred.await(compromised)));
        }).pipe(Effect.uninterruptible),
      ),
    );
  });

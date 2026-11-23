import {
  type ComputerAction,
  type ComputerApp,
  type ComputerController,
  type ComputerDriverStatus,
  ComputerUseError,
  type ComputerUseSettings,
  type ComputerUseStatus,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";
import * as CuaComputerDriver from "./CuaComputerDriver.ts";
import { type ComputerObservation, makeComputerObservations } from "./ComputerObservations.ts";

/** Constructed by trusted transports from the live caller, never decoded from tool arguments. */
export interface ComputerUseActor {
  readonly authorizeNative: Effect.Effect<void, ComputerUseError>;
  readonly requestNamespace: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

interface Lease {
  readonly id: string;
  readonly actor: ComputerUseActor;
  readonly app: ComputerApp;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly ready: boolean;
}

interface Waiting {
  readonly actor: ComputerUseActor;
  readonly appId: string;
  readonly expiresAt: number;
}

type Driver = CuaComputerDriver.CuaComputerDriver["Service"];
type ActionResult = Effect.Success<ReturnType<Driver["act"]>>;
interface Screenshot {
  readonly base64: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly captureId?: string;
  readonly width?: number;
  readonly height?: number;
}
interface OpenResult {
  readonly leaseId: string;
  readonly app: ComputerApp;
  readonly owner: ComputerController;
}

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  {
    readonly status: (
      authorizeNative?: Effect.Effect<void, ComputerUseError>,
    ) => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly setup: () => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly stop: () => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly resume: () => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly subscribeState: () => Stream.Stream<ComputerUseStatus>;
    readonly listApps: (
      actor: ComputerUseActor,
    ) => Effect.Effect<ReadonlyArray<ComputerApp>, ComputerUseError>;
    readonly open: (
      actor: ComputerUseActor,
      appId: string,
    ) => Effect.Effect<OpenResult, ComputerUseError>;
    readonly snapshot: (
      actor: ComputerUseActor,
      leaseId: string,
      options?: { readonly maxChars?: number; readonly since?: string },
    ) => Effect.Effect<ComputerObservation, ComputerUseError>;
    readonly act: (
      actor: ComputerUseActor,
      leaseId: string,
      action: ComputerAction,
    ) => Effect.Effect<ActionResult, ComputerUseError>;
    readonly screenshot: (
      actor: ComputerUseActor,
      leaseId: string,
    ) => Effect.Effect<Screenshot, ComputerUseError>;
    readonly release: (
      actor: ComputerUseActor,
      leaseId: string,
    ) => Effect.Effect<void, ComputerUseError>;
  }
>()("t3/computer/ComputerUseService") {}

const LEASE_IDLE_MS = 120_000;
const MAX_WAITING = 32;

function sameActor(left: ComputerUseActor, right: ComputerUseActor): boolean {
  return (
    left.requestNamespace === right.requestNamespace &&
    left.threadId === right.threadId &&
    left.providerInstanceId === right.providerInstanceId
  );
}

function controller(lease: Lease): ComputerController {
  return {
    threadId: lease.actor.threadId,
    providerInstanceId: lease.actor.providerInstanceId,
    appId: lease.app.id,
    acquiredAt: lease.acquiredAt,
  };
}

const make = Effect.gen(function* () {
  const driver = yield* CuaComputerDriver.CuaComputerDriver;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const nativeLock = yield* Semaphore.make(1);
  const controlLock = yield* Semaphore.make(1);
  const observations = makeComputerObservations();
  const changes = yield* settings.subscribeChanges;
  let policy = (yield* settings.getSettings.pipe(
    Effect.mapError((cause) => new ComputerUseError({ reason: "unavailable", cause })),
  )).computerUse;
  let paused = false;
  let generation = 0;
  let sequence = 0;
  let lease: Lease | null = null;
  let waiting: Waiting[] = [];
  let active: Fiber.Fiber<unknown, ComputerUseError> | null = null;
  let timerWake = yield* Deferred.make<void>();
  let driverStatus: ComputerDriverStatus = {
    platform,
    installed: false,
    accessibility: "unknown",
    screenRecording: "unknown",
    reason: null,
  };
  const currentStatus = (): ComputerUseStatus => ({
    supported: platform === "darwin",
    enabled: policy.enabled,
    paused,
    driver: driverStatus,
    owner: lease === null ? null : controller(lease),
    queued: waiting.map((entry) => entry.actor.threadId),
    blockedAppIds: policy.blockedAppIds,
  });
  const state = yield* SubscriptionRef.make(currentStatus());
  const publish = () => SubscriptionRef.set(state, currentStatus());
  const wakeTimer = Effect.fnUntraced(function* () {
    const previous = timerWake;
    timerWake = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
  // Only metadata lives under this lock. Native cleanup must happen after it is released.
  const revoke = () => {
    generation++;
    lease = null;
    observations.clear();
    return active;
  };
  const cancel = (fiber: typeof active) => (fiber === null ? Effect.void : Fiber.interrupt(fiber));
  const isBlocked = (appId: string) =>
    policy.blockedAppIds.some((id) => id.toLowerCase() === appId.toLowerCase());
  const reconcile = Effect.fnUntraced(function* (next: ComputerUseSettings) {
    const interrupted = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const changed =
          policy.enabled !== next.enabled ||
          policy.blockedAppIds.length !== next.blockedAppIds.length ||
          policy.blockedAppIds.some((id, index) => id !== next.blockedAppIds[index]);
        policy = next;
        let interrupted: typeof active = null;
        if (
          (!next.enabled && (changed || lease !== null || active !== null)) ||
          (lease !== null && isBlocked(lease.app.id))
        ) {
          interrupted = revoke();
        }
        waiting = waiting.filter((entry) => next.enabled && !isBlocked(entry.appId));
        if (changed || interrupted !== null) {
          yield* publish();
          yield* wakeTimer();
        }
        return interrupted;
      }),
    );
    yield* cancel(interrupted);
  });
  const refreshPolicy = settings.getSettings.pipe(
    Effect.mapError((cause) => new ComputerUseError({ reason: "unavailable", cause })),
    Effect.flatMap((value) => reconcile(value.computerUse)),
  );
  const checkAllowed = Effect.fnUntraced(function* (appId?: string) {
    if (!policy.enabled) return yield* new ComputerUseError({ reason: "disabled" });
    if (paused) return yield* new ComputerUseError({ reason: "paused" });
    if (platform !== "darwin") return yield* new ComputerUseError({ reason: "unavailable" });
    if (appId !== undefined && isBlocked(appId))
      return yield* new ComputerUseError({ reason: "blocked_app" });
  });
  const expire = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;
    const interrupted = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        let interrupted: typeof active = null;
        let changed = false;
        if (lease !== null && lease.expiresAt <= now) {
          interrupted = revoke();
          changed = true;
        }
        const remaining = waiting.filter((entry) => entry.expiresAt > now);
        if (remaining.length !== waiting.length) changed = true;
        waiting = remaining;
        if (changed) yield* publish();
        return interrupted;
      }),
    );
    yield* cancel(interrupted);
  });
  const validateLease = Effect.fnUntraced(function* (actor: ComputerUseActor, leaseId: string) {
    yield* actor.authorizeNative;
    yield* checkAllowed(lease?.app.id);
    if (lease === null || lease.id !== leaseId || !sameActor(lease.actor, actor))
      return yield* new ComputerUseError({ reason: "invalid_lease" });
    const now = yield* Clock.currentTimeMillis;
    if (lease.expiresAt <= now) return yield* new ComputerUseError({ reason: "invalid_lease" });
    lease = { ...lease, expiresAt: now + LEASE_IDLE_MS };
    yield* wakeTimer();
    return lease;
  });

  /** Register interruptible work before it starts; stop never needs the native-operation semaphore. */
  const runNative = <T, A>(
    validate: Effect.Effect<T, ComputerUseError>,
    operation: (value: T) => Effect.Effect<A, ComputerUseError>,
    complete: (result: A, value: T) => Effect.Effect<A, ComputerUseError> = (result) =>
      Effect.succeed(result),
  ): Effect.Effect<A, ComputerUseError> =>
    Effect.gen(function* () {
      const requestedGeneration = generation;
      return yield* nativeLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* refreshPolicy;
            yield* expire();
            const registration = yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const value = yield* validate;
                if (requestedGeneration !== generation)
                  return yield* new ComputerUseError({ reason: "cancelled" });
                const fiber = yield* Effect.forkIn(Effect.interruptible(operation(value)), scope);
                active = fiber;
                return { fiber, value, generation };
              }),
            );
            const result = yield* restore(Fiber.await(registration.fiber)).pipe(
              Effect.ensuring(Fiber.interrupt(registration.fiber)),
              Effect.onInterrupt(() =>
                lock.withPermits(1)(
                  Effect.gen(function* () {
                    if (registration.generation === generation) {
                      revoke();
                      yield* publish();
                      yield* wakeTimer();
                    }
                  }),
                ),
              ),
              Effect.ensuring(
                lock.withPermits(1)(
                  Effect.sync(() => {
                    if (active === registration.fiber) active = null;
                  }),
                ),
              ),
            );
            return yield* lock.withPermits(1)(
              Effect.gen(function* () {
                if (registration.generation !== generation)
                  return yield* new ComputerUseError({ reason: "cancelled" });
                if (Exit.isFailure(result)) {
                  if (Cause.hasInterrupts(result.cause)) {
                    revoke();
                    yield* publish();
                    yield* wakeTimer();
                    return yield* new ComputerUseError({ reason: "cancelled" });
                  }
                  return yield* result;
                }
                return yield* complete(result.value, registration.value);
              }),
            );
          }),
        ),
      );
    });
  const status = Effect.fn("ComputerUseService.status")(function* (
    authorizeNative: Effect.Effect<void, ComputerUseError> = Effect.void,
  ) {
    yield* refreshPolicy;
    yield* expire();
    if (policy.enabled && !paused && platform === "darwin") {
      yield* runNative(
        checkAllowed().pipe(Effect.andThen(authorizeNative)),
        () => driver.status(),
        (result) =>
          Effect.gen(function* () {
            driverStatus = result;
            yield* publish();
            return result;
          }),
      );
    }
    return yield* lock.withPermits(1)(Effect.sync(currentStatus));
  });
  const open = Effect.fn("ComputerUseService.open")(function* (
    actor: ComputerUseActor,
    appId: string,
  ) {
    yield* refreshPolicy;
    yield* expire();
    const acquired = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* actor.authorizeNative;
        yield* checkAllowed(appId);
        if (
          lease !== null &&
          sameActor(lease.actor, actor) &&
          lease.app.id === appId &&
          lease.ready
        ) {
          lease = { ...lease, expiresAt: (yield* Clock.currentTimeMillis) + LEASE_IDLE_MS };
          yield* wakeTimer();
          return { existing: true, lease };
        }
        const owned = lease !== null && sameActor(lease.actor, actor);
        if (
          (lease !== null && (!owned || !lease.ready || active !== null)) ||
          (waiting.length > 0 && !sameActor(waiting[0]!.actor, actor))
        ) {
          if (!owned) {
            const index = waiting.findIndex((entry) => sameActor(entry.actor, actor));
            const expiresAt = (yield* Clock.currentTimeMillis) + LEASE_IDLE_MS;
            if (index >= 0) {
              waiting[index] = { ...waiting[index]!, appId, expiresAt };
              yield* wakeTimer();
            } else if (waiting.length < MAX_WAITING) {
              waiting.push({ actor, appId, expiresAt });
              yield* publish();
              yield* wakeTimer();
            }
          }
          return yield* new ComputerUseError({ reason: "busy" });
        }
        // Switching apps keeps this actor's host control but invalidates its old lease and baselines.
        if (lease !== null) revoke();
        waiting = waiting.filter((entry) => !sameActor(entry.actor, actor));
        const now = yield* Clock.currentTimeMillis;
        lease = {
          id: `computer-lease-${++sequence}`,
          actor: { ...actor },
          app: { id: appId, name: appId },
          acquiredAt: now,
          expiresAt: now + LEASE_IDLE_MS,
          ready: false,
        };
        yield* publish();
        yield* wakeTimer();
        return { existing: false, lease };
      }),
    );
    if (acquired.existing)
      return {
        leaseId: acquired.lease.id,
        app: acquired.lease.app,
        owner: controller(acquired.lease),
      };
    const opened = yield* runNative(
      validateLease(actor, acquired.lease.id),
      () => driver.open(appId),
      (app) =>
        Effect.gen(function* () {
          if (lease === null || lease.id !== acquired.lease.id)
            return yield* new ComputerUseError({ reason: "invalid_lease" });
          yield* checkAllowed(app.id);
          lease = { ...lease, app, ready: true };
          yield* publish();
          return app;
        }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? lock.withPermits(1)(
              Effect.gen(function* () {
                if (lease?.id === acquired.lease.id) {
                  revoke();
                  yield* publish();
                  yield* wakeTimer();
                }
              }),
            )
          : Effect.void,
      ),
    );
    return {
      leaseId: acquired.lease.id,
      app: opened,
      owner: controller({ ...acquired.lease, app: opened }),
    };
  });
  const withLease = <A>(
    actor: ComputerUseActor,
    leaseId: string,
    operation: (value: Lease) => Effect.Effect<A, ComputerUseError>,
  ) => runNative(validateLease(actor, leaseId), operation);

  yield* changes.pipe(
    Stream.runForEach((value) => reconcile(value.computerUse)),
    Effect.forkIn(scope),
  );
  // One event-driven timer handles lease idleness and abandoned queue reservations.
  yield* Effect.gen(function* () {
    while (true) {
      const next = yield* lock.withPermits(1)(
        Effect.sync(() => ({
          wake: timerWake,
          deadline: Math.min(
            lease?.expiresAt ?? Infinity,
            ...waiting.map((entry) => entry.expiresAt),
          ),
        })),
      );
      if (next.deadline === Infinity) yield* Deferred.await(next.wake);
      else
        yield* Deferred.await(next.wake).pipe(
          Effect.timeoutOrElse({
            duration: Math.max(0, next.deadline - (yield* Clock.currentTimeMillis)),
            orElse: () => Effect.void,
          }),
        );
      yield* expire();
    }
  }).pipe(Effect.forkIn(scope));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      revoke();
      waiting = [];
      yield* cancel(active);
    }),
  );
  return ComputerUseService.of({
    status,
    setup: () =>
      runNative(
        checkAllowed(),
        () => driver.setup(),
        (result) =>
          Effect.gen(function* () {
            driverStatus = result;
            yield* publish();
            return result;
          }),
      ).pipe(Effect.map(() => currentStatus())),
    stop: () =>
      controlLock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const interrupted = yield* lock.withPermits(1)(
              Effect.gen(function* () {
                paused = true;
                waiting = [];
                const interrupted = revoke();
                yield* publish();
                yield* wakeTimer();
                return interrupted;
              }),
            );
            yield* cancel(interrupted);
            return currentStatus();
          }),
        ),
      ),
    resume: () =>
      controlLock.withPermits(1)(
        Effect.gen(function* () {
          yield* refreshPolicy;
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (!policy.enabled) return yield* new ComputerUseError({ reason: "disabled" });
              paused = false;
              yield* publish();
              return currentStatus();
            }),
          );
        }),
      ),
    subscribeState: () => SubscriptionRef.changes(state),
    listApps: (actor) =>
      runNative(
        checkAllowed(),
        () => actor.authorizeNative.pipe(Effect.andThen(driver.listApps())),
        (apps) => Effect.succeed(apps.filter((app) => !isBlocked(app.id))),
      ),
    open,
    snapshot: (actor, leaseId, options = {}) =>
      withLease(actor, leaseId, (value) =>
        driver.snapshot(value.app.id).pipe(
          Effect.flatMap((snapshot) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                observations.observe({
                  scope: value.id,
                  now,
                  text: snapshot.tree,
                  ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
                  ...(options.since === undefined ? {} : { since: options.since }),
                  ...(snapshot.truncated === undefined ? {} : { truncated: snapshot.truncated }),
                  ...(snapshot.omittedLines === undefined
                    ? {}
                    : { omittedLines: snapshot.omittedLines }),
                  ...(snapshot.captureId === undefined ? {} : { captureId: snapshot.captureId }),
                }),
              ),
            ),
          ),
        ),
      ),
    act: (actor, leaseId, action) =>
      withLease(actor, leaseId, (value) => driver.act(value.app.id, action)),
    screenshot: (actor, leaseId) =>
      withLease(actor, leaseId, (value) =>
        Effect.gen(function* () {
          const image = yield* driver.screenshot(value.app.id);
          const info = yield* fs
            .stat(image.path)
            .pipe(
              Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
            );
          const maxBytes = 8 * 1024 * 1024;
          if (info.type !== "File" || info.size <= 0 || info.size > maxBytes)
            return yield* new ComputerUseError({ reason: "driver_failure" });
          const bytes = yield* fs
            .readFile(image.path)
            .pipe(
              Effect.mapError((cause) => new ComputerUseError({ reason: "driver_failure", cause })),
            );
          if (bytes.length === 0 || bytes.length > maxBytes)
            return yield* new ComputerUseError({ reason: "driver_failure" });
          return {
            base64: Buffer.from(bytes).toString("base64"),
            mimeType: image.mimeType,
            ...(image.captureId === undefined ? {} : { captureId: image.captureId }),
            ...(image.width === undefined ? {} : { width: image.width }),
            ...(image.height === undefined ? {} : { height: image.height }),
          };
        }),
      ),
    release: (actor, leaseId) =>
      Effect.gen(function* () {
        yield* refreshPolicy;
        yield* expire();
        const interrupted = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* validateLease(actor, leaseId);
            const interrupted = revoke();
            yield* publish();
            yield* wakeTimer();
            return interrupted;
          }),
        );
        yield* cancel(interrupted);
      }),
  });
});

export const layer = Layer.effect(ComputerUseService, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ComputerUseError,
  type ComputerDriverStatus,
  ProviderInstanceId,
  type ServerSettings as Settings,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as CuaComputerDriver from "./CuaComputerDriver.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

const actor: ComputerUseService.ComputerUseActor = {
  authorizeNative: Effect.void,
  requestNamespace: "session-a",
  threadId: ThreadId.make("thread-a"),
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const second = { ...actor, threadId: ThreadId.make("thread-b") };
const third = { ...actor, threadId: ThreadId.make("thread-c") };
const nativeStatus: ComputerDriverStatus = {
  platform: "darwin",
  installed: true,
  accessibility: "granted",
  screenRecording: "granted",
  reason: null,
};
const current = (service: ComputerUseService.ComputerUseService["Service"]) =>
  service.subscribeState().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

const fixture = Effect.fnUntraced(function* (
  options: {
    readonly driver?: Partial<CuaComputerDriver.CuaComputerDriver["Service"]>;
    readonly fs?: FileSystem.FileSystem;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* Queue.unbounded<{
    readonly value: Settings;
    readonly done: Deferred.Deferred<void>;
  }>();
  const calls: string[] = [];
  const driver: CuaComputerDriver.CuaComputerDriver["Service"] = {
    status: () =>
      Effect.sync(() => {
        calls.push("status");
        return nativeStatus;
      }),
    setup: () =>
      Effect.sync(() => {
        calls.push("setup");
        return nativeStatus;
      }),
    listApps: () =>
      Effect.sync(() => {
        calls.push("listApps");
        return [
          { id: "app", name: "App" },
          { id: "private", name: "Private" },
        ];
      }),
    open: (id) =>
      Effect.sync(() => {
        calls.push(`open:${id}`);
        return { id, name: `Name ${id}` };
      }),
    snapshot: () =>
      Effect.sync(() => {
        calls.push("snapshot");
        return { tree: "s12345678:1 button Save", captureId: "native-capture" };
      }),
    act: () =>
      Effect.sync(() => {
        calls.push("act");
        return { message: "unverifiable via background" };
      }),
    screenshot: () => Effect.die("unexpected screenshot"),
    ...options.driver,
  };
  const context = yield* Layer.build(ComputerUseService.layer).pipe(
    Effect.provideService(CuaComputerDriver.CuaComputerDriver, driver),
    Effect.provideService(FileSystem.FileSystem, options.fs ?? FileSystem.makeNoop({})),
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    Effect.provideService(ServerSettings.ServerSettingsService, {
      ...settings,
      subscribeChanges: Effect.succeed(
        Stream.fromQueue(changes).pipe(
          Stream.flatMap(({ value, done }) =>
            Stream.make(value).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain),
              ),
            ),
          ),
        ),
      ),
    }),
  );
  const service = Context.get(context, ComputerUseService.ComputerUseService);
  const update = Effect.fnUntraced(function* (computerUse: Settings["computerUse"]) {
    const value = yield* settings.updateSettings({ computerUse });
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(changes, { value, done });
    yield* Deferred.await(done);
  });
  return { service, calls, update, settings };
});

const enabled = ServerSettings.layerTest({ computerUse: { enabled: true } });

describe("ComputerUseService", () => {
  it.effect("rechecks native authorization after an operation waits for the native lock", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let allowed = true;
      const guarded = {
        ...actor,
        authorizeNative: Effect.suspend(() =>
          allowed ? Effect.void : Effect.fail(new ComputerUseError({ reason: "unavailable" })),
        ),
      };
      const { service, calls } = yield* fixture({
        driver: {
          listApps: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as([]),
            ),
        },
      });
      const { leaseId } = yield* service.open(guarded, "app");
      const holding = yield* service.listApps(actor).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const queued = yield* service
        .act(guarded, leaseId, { kind: "press", key: "Enter" })
        .pipe(Effect.flip, Effect.forkChild);
      allowed = false;
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holding);
      expect((yield* Fiber.join(queued)).reason).toBe("unavailable");
      expect(calls).not.toContain("act");
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );
  it.effect("does no native work while disabled, including status and setup", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();
      expect((yield* service.status()).enabled).toBe(false);
      for (const operation of [
        service.setup(),
        service.listApps(actor),
        service.open(actor, "app"),
        service.snapshot(actor, "unknown"),
        service.act(actor, "unknown", { kind: "press", key: "Enter" }),
        service.screenshot(actor, "unknown"),
        service.release(actor, "unknown"),
      ]) {
        expect(yield* operation.pipe(Effect.flip)).toMatchObject({ reason: "disabled" });
      }
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest())),
  );

  it.effect("streams initial state and takeover changes without exposing native content", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();
      const subscribed = yield* Deferred.make<void>();
      const updates = yield* service.subscribeState().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* service.stop();
      expect((yield* Fiber.join(updates)).map((state) => state.paused)).toEqual([false, true]);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("returns truthful unsupported and permission errors", () =>
    Effect.gen(function* () {
      const unsupported = yield* fixture({ platform: "linux" });
      expect((yield* unsupported.service.status()).supported).toBe(false);
      expect(yield* unsupported.service.open(actor, "app").pipe(Effect.flip)).toMatchObject({
        reason: "unavailable",
      });
      expect(unsupported.calls).toEqual([]);
      const denied = yield* fixture({
        driver: {
          open: () => Effect.fail(new ComputerUseError({ reason: "permission_required" })),
        },
      });
      expect(yield* denied.service.open(actor, "app").pipe(Effect.flip)).toMatchObject({
        reason: "permission_required",
      });
      expect((yield* current(denied.service)).owner).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("scopes ownership across namespaces, threads, and providers", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      expect(opened.app.name).toBe("Name app");
      expect(opened.owner.threadId).toBe(actor.threadId);
      for (const stranger of [
        { ...actor, requestNamespace: "session-b" },
        second,
        { ...actor, providerInstanceId: ProviderInstanceId.make("claude") },
      ]) {
        expect(yield* service.snapshot(stranger, opened.leaseId).pipe(Effect.flip)).toMatchObject({
          reason: "invalid_lease",
        });
        expect(
          yield* service
            .act(stranger, opened.leaseId, { kind: "type", text: "no" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid_lease" });
        expect(yield* service.release(stranger, opened.leaseId).pipe(Effect.flip)).toMatchObject({
          reason: "invalid_lease",
        });
      }
      expect(calls).toEqual(["open:app"]);
      expect(JSON.stringify(yield* current(service))).not.toContain(opened.leaseId);
      expect(JSON.stringify(yield* current(service))).not.toContain("session-a");
      yield* service.release(actor, opened.leaseId);
      expect(yield* service.snapshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_lease",
      });
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("preserves FIFO admission, deduplicates requests, and prevents a newcomer bypass", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const first = yield* service.open(actor, "app");
      for (const waiting of [second, second, third]) {
        expect(yield* service.open(waiting, "app").pipe(Effect.flip)).toMatchObject({
          reason: "busy",
        });
      }
      expect((yield* current(service)).queued).toEqual([second.threadId, third.threadId]);
      yield* service.release(actor, first.leaseId);
      expect(yield* service.open(third, "app").pipe(Effect.flip)).toMatchObject({ reason: "busy" });
      const next = yield* service.open(second, "app");
      yield* service.release(second, next.leaseId);
      expect((yield* service.open(third, "app")).owner.threadId).toBe(third.threadId);
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("does not queue an actor behind its own pending open", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let opens = 0;
      const { service } = yield* fixture({
        driver: {
          open: (id) =>
            Effect.gen(function* () {
              opens++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(finish);
              return { id, name: "App" };
            }),
        },
      });
      const opening = yield* service.open(actor, "app").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(yield* service.open(actor, "app").pipe(Effect.flip)).toMatchObject({ reason: "busy" });
      expect(yield* service.open(actor, "other").pipe(Effect.flip)).toMatchObject({
        reason: "busy",
      });
      expect((yield* current(service)).queued).toEqual([]);
      yield* Deferred.succeed(finish, undefined);
      expect((yield* Fiber.join(opening)).owner.threadId).toBe(actor.threadId);
      expect(opens).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("renews an active waiter's reservation without changing its FIFO position", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      yield* service.open(second, "app").pipe(Effect.flip);

      yield* TestClock.adjust("60 seconds");
      yield* service.open(second, "app").pipe(Effect.flip);
      yield* service.act(actor, opened.leaseId, { kind: "press", key: "Enter" });

      yield* TestClock.adjust("50 seconds");
      yield* service.open(third, "app").pipe(Effect.flip);
      yield* service.act(actor, opened.leaseId, { kind: "press", key: "Enter" });
      yield* TestClock.adjust("10 seconds");
      expect((yield* current(service)).queued).toEqual([second.threadId, third.threadId]);

      yield* service.release(actor, opened.leaseId);
      expect(yield* service.open(third, "app").pipe(Effect.flip)).toMatchObject({ reason: "busy" });
      expect((yield* service.open(second, "app")).owner.threadId).toBe(second.threadId);
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("bounds the busy queue", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      yield* service.open(actor, "app");
      for (let index = 0; index < 40; index++)
        yield* service
          .open({ ...actor, threadId: ThreadId.make(`waiting-${index}`) }, "app")
          .pipe(Effect.flip);
      expect((yield* current(service)).queued).toEqual(
        Array.from({ length: 32 }, (_, index) => `waiting-${index}`),
      );
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect(
    "stop interrupts active input without waiting behind its mutex, and awaits native cleanup",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const clean = yield* Deferred.make<void>();
        let inputs = 0;
        const { service } = yield* fixture({
          driver: {
            act: () =>
              Effect.gen(function* () {
                inputs++;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(clean))),
                ),
              ),
          },
        });
        const opened = yield* service.open(actor, "app");
        const action = yield* service
          .act(actor, opened.leaseId, { kind: "press", key: "Enter" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        expect(yield* service.open(second, "app").pipe(Effect.flip)).toMatchObject({
          reason: "busy",
        });
        const queuedAction = yield* service
          .act(actor, opened.leaseId, { kind: "press", key: "Enter" })
          .pipe(Effect.result, Effect.forkChild);
        const stopping = yield* service.stop().pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(yield* current(service)).toMatchObject({ paused: true, owner: null, queued: [] });
        yield* Deferred.succeed(clean, undefined);
        expect((yield* Fiber.join(stopping)).paused).toBe(true);
        expect(yield* Fiber.join(action)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "cancelled" },
        });
        expect((yield* Fiber.join(queuedAction))._tag).toBe("Failure");
        expect(inputs).toBe(1);
        expect(yield* service.open(actor, "app").pipe(Effect.flip)).toMatchObject({
          reason: "paused",
        });
        yield* service.resume();
        expect(yield* service.snapshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
          reason: "invalid_lease",
        });
        expect((yield* service.open(actor, "app")).leaseId).not.toBe(opened.leaseId);
      }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("caller cancellation cleans up and revokes its native tokens and lease", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const { service } = yield* fixture({
        driver: {
          act: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
        },
      });
      const opened = yield* service.open(actor, "app");
      const action = yield* service
        .act(actor, opened.leaseId, { kind: "type", text: "hello" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(action);
      yield* Deferred.await(cancelled);
      expect((yield* current(service)).owner).toBeNull();
      expect(yield* service.snapshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_lease",
      });
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("revokes from settings changes without a subsequent caller request", () =>
    Effect.gen(function* () {
      const { service, update } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      yield* service.open(second, "private").pipe(Effect.flip);
      yield* update({ enabled: true, blockedAppIds: ["APP", "private"] });
      expect(yield* current(service)).toMatchObject({
        owner: null,
        queued: [],
        blockedAppIds: ["APP", "private"],
      });
      expect(yield* service.open(actor, "app").pipe(Effect.flip)).toMatchObject({
        reason: "blocked_app",
      });
      expect(yield* service.listApps(actor)).toEqual([]);
      yield* update({ enabled: false, blockedAppIds: [] });
      expect((yield* current(service)).enabled).toBe(false);
      expect(yield* service.snapshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
        reason: "disabled",
      });
      yield* update({ enabled: true, blockedAppIds: [] });
      expect(yield* service.snapshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_lease",
      });
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("settings disable cancels executing native input", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const { service, update } = yield* fixture({
        driver: {
          act: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
        },
      });
      const opened = yield* service.open(actor, "app");
      const action = yield* service
        .act(actor, opened.leaseId, { kind: "type", text: "hello" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* update({ enabled: false, blockedAppIds: [] });
      yield* Deferred.await(cancelled);
      expect((yield* Fiber.join(action))._tag).toBe("Failure");
      expect((yield* current(service)).owner).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("blocking the controlled app interrupts native input and revokes the lease", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const { service, update } = yield* fixture({
        driver: {
          act: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
        },
      });
      const opened = yield* service.open(actor, "app");
      const action = yield* service
        .act(actor, opened.leaseId, { kind: "type", text: "hello" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* update({ enabled: true, blockedAppIds: ["APP"] });
      yield* Deferred.await(cancelled);
      expect((yield* Fiber.join(action))._tag).toBe("Failure");
      expect((yield* current(service)).owner).toBeNull();
      expect(yield* service.open(actor, "app").pipe(Effect.flip)).toMatchObject({
        reason: "blocked_app",
      });
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("expires idle control and abandoned queue reservations using the clock", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      yield* service.open(second, "app").pipe(Effect.flip);
      yield* TestClock.adjust("119 seconds");
      expect((yield* current(service)).owner?.threadId).toBe(actor.threadId);
      yield* TestClock.adjust("1 second");
      expect(yield* current(service)).toMatchObject({ owner: null, queued: [] });
      expect(
        yield* service
          .act(actor, opened.leaseId, { kind: "press", key: "Enter" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_lease" });
      yield* service.open(third, "app");
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("renews control on use and keeps action outputs small without implicit snapshots", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      yield* TestClock.adjust("90 seconds");
      expect(
        yield* service.act(actor, opened.leaseId, { kind: "click", ref: "s12345678:1" }),
      ).toEqual({ message: "unverifiable via background" });
      yield* TestClock.adjust("90 seconds");
      expect((yield* current(service)).owner?.threadId).toBe(actor.threadId);
      expect(calls).toEqual(["open:app", "act"]);
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("serves compact native text and isolates baselines after release", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();
      const opened = yield* service.open(actor, "app");
      const first = yield* service.snapshot(actor, opened.leaseId);
      expect(first).toMatchObject({
        kind: "full",
        text: "s12345678:1 button Save",
        captureId: "native-capture",
      });
      expect(
        yield* service.snapshot(actor, opened.leaseId, { since: first.snapshotId }),
      ).toMatchObject({ kind: "unchanged", text: "unchanged" });
      yield* service.release(actor, opened.leaseId);
      const next = yield* service.open(second, "app");
      expect(
        (yield* service.snapshot(second, next.leaseId, { since: first.snapshotId })).kind,
      ).toBe("full");
      expect(calls).not.toContain("screenshot");
    }).pipe(Effect.scoped, Effect.provide(enabled)),
  );

  it.effect("returns explicit bounded screenshot bytes and the native capture identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/capture.png`;
      yield* fs.writeFile(path, new Uint8Array([1, 2, 3]));
      let reads = 0;
      const { service } = yield* fixture({
        fs: FileSystem.makeNoop({
          stat: fs.stat,
          readFile: (path) =>
            Effect.sync(() => {
              reads++;
            }).pipe(Effect.andThen(fs.readFile(path))),
        }),
        driver: {
          screenshot: () =>
            Effect.succeed({
              path,
              mimeType: "image/png",
              captureId: "native-image",
              width: 100,
              height: 200,
            }),
        },
      });
      const opened = yield* service.open(actor, "app");
      expect(yield* service.screenshot(actor, opened.leaseId)).toEqual({
        base64: "AQID",
        mimeType: "image/png",
        captureId: "native-image",
        width: 100,
        height: 200,
      });
      yield* fs.truncate(path, 8 * 1024 * 1024 + 1);
      expect(yield* service.screenshot(actor, opened.leaseId).pipe(Effect.flip)).toMatchObject({
        reason: "driver_failure",
      });
      expect(reads).toBe(1);
      expect(JSON.stringify(yield* current(service))).not.toContain("AQID");
      expect(JSON.stringify(yield* current(service))).not.toContain(path);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(enabled, NodeServices.layer))),
  );
});

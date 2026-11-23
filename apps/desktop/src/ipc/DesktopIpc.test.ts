import type * as Electron from "electron";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
      );
      const frame = {};
      const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
      const sender = { sender: contents, senderFrame: frame };
      yield* ipc.registerWindow({
        webContents: contents as Electron.WebContents,
        isDestroyed: () => false,
      });
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );
});

it.effect(
  "denies privileged invoke and sync IPC from foreign contents, subframes and destroyed windows",
  () =>
    Effect.gen(function* () {
      let invoke: DesktopIpc.DesktopIpcHandleListener | undefined;
      let sync: DesktopIpc.DesktopIpcSyncListener | undefined;
      let calls = 0;
      let destroyed = false;
      const frame = {};
      const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_, listener) => {
            invoke = listener;
          },
          on: (_, listener) => {
            sync = listener;
          },
        }),
      );
      yield* ipc.registerWindow({
        webContents: contents as Electron.WebContents,
        isDestroyed: () => destroyed,
      });
      yield* ipc.handle({ channel: "invoke", handler: () => Effect.sync(() => ++calls) });
      yield* ipc.handleSync({ channel: "sync", handler: () => Effect.sync(() => ++calls) });
      const valid = { sender: contents, senderFrame: frame };
      assert.equal(yield* Effect.promise(async () => invoke!(valid, undefined)), 1);
      const validSync = { ...valid, returnValue: undefined as unknown };
      sync!(validSync);
      assert.equal(validSync.returnValue, 2);
      for (const event of [
        { sender: { id: 1 }, senderFrame: frame },
        { sender: contents, senderFrame: {} },
        { sender: contents },
      ]) {
        yield* Effect.promise(() =>
          Promise.resolve(invoke!(event, undefined)).then(
            () => assert.fail("untrusted invoke succeeded"),
            () => {},
          ),
        );
        const syncEvent = { ...event, returnValue: undefined as unknown };
        sync!(syncEvent);
        assert.isUndefined(syncEvent.returnValue);
      }
      destroyed = true;
      yield* Effect.promise(() =>
        Promise.resolve(invoke!(valid, undefined)).then(
          () => assert.fail("destroyed window invoked"),
          () => {},
        ),
      );
      assert.equal(calls, 2);
    }).pipe(Effect.scoped),
);

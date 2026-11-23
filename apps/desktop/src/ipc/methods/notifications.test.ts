import type * as Electron from "electron";
import * as NodeEvents from "node:events";
import type { DesktopNotification } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";

interface TestNotification extends NodeEvents.EventEmitter {
  readonly show: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

const native = vi.hoisted(() => ({
  create: vi.fn(),
  supported: vi.fn(() => true),
  getFocusedWindow: vi.fn(() => null as object | null),
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => true),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { id: 1, send: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
  listeners: new Map<string, () => void>(),
  instances: [] as TestNotification[],
  showEvent: "show",
}));
vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
  Notification: Object.assign(native.create, { isSupported: native.supported }),
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installNotifications } from "./notifications.ts";

const notification: DesktopNotification = {
  id: "alert-1",
  tag: "environment:chat",
  title: "Question",
  body: "Which approach?",
  actions: ["First (Recommended)", "Second"],
  hasReply: true,
};
const frame = {};
const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
const event = { sender: contents, senderFrame: frame };

beforeEach(() => {
  vi.clearAllMocks();
  native.supported.mockReturnValue(true);
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.isMinimized.mockReturnValue(true);
  native.listeners.clear();
  native.instances = [];
  native.showEvent = "show";
  native.create.mockImplementation(function () {
    const instance = Object.assign(new NodeEvents.EventEmitter(), {
      show: vi.fn(() => instance.emit(native.showEvent)),
      close: vi.fn(),
    });
    native.instances.push(instance);
    return instance;
  });
});

function withHandlers<A, E>(
  test: (
    show: DesktopIpc.DesktopIpcHandleListener,
    close: DesktopIpc.DesktopIpcHandleListener,
    focus: DesktopIpc.DesktopIpcHandleListener,
  ) => Effect.Effect<A, E>,
  platform: NodeJS.Platform = "darwin",
) {
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* DesktopIpc.DesktopIpc).registerWindow({
          webContents: contents as Electron.WebContents,
          isDestroyed: () => false,
        });
        yield* installNotifications();
        yield* test(
          handlers.get("desktop:show-notification")!,
          handlers.get("desktop:close-notification")!,
          handlers.get("desktop:focus-notification-window")!,
        );
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide([
        ElectronApp.layer,
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(handlers.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  });
}

it.effect("delivers silent mac alerts with actions and reply together", () =>
  withHandlers((show) =>
    Effect.promise(async () => {
      expect(await show(event, notification)).toBe(true);
      expect(native.create).toHaveBeenCalledExactlyOnceWith({
        id: "1:environment:chat",
        title: "Question",
        body: "Which approach?",
        actions: [
          { type: "button", text: "First (Recommended)" },
          { type: "button", text: "Second" },
        ],
        hasReply: true,
        replyPlaceholder: "Your answer",
        silent: true,
      });
      expect(native.instances[0]!.show).toHaveBeenCalledOnce();
    }),
  ),
);

it.effect("validates notification IPC before calling Electron", () =>
  withHandlers((show, close) =>
    Effect.promise(async () => {
      for (const invalid of [
        { ...notification, id: "" },
        { ...notification, tag: "" },
        { ...notification, actions: [1] },
        { ...notification, actions: [""] },
        { ...notification, hasReply: "yes" },
        { ...notification, body: null },
      ])
        await expect(show(event, invalid)).rejects.toBeDefined();
      await expect(close(event, 123)).rejects.toBeDefined();
      expect(native.create).not.toHaveBeenCalled();
    }),
  ),
);

it.effect.each(["win32", "linux"] as const)("keeps the web path on %s", (platform) =>
  withHandlers(
    (show) =>
      Effect.promise(async () => {
        expect(await show(event, notification)).toBe(false);
        expect(native.create).not.toHaveBeenCalled();
      }),
    platform,
  ),
);

it.effect.each(["unsupported", "focused", "destroyed", "unknown-sender"])(
  "does not present when %s",
  (condition) =>
    withHandlers((show) =>
      Effect.promise(async () => {
        if (condition === "unsupported") native.supported.mockReturnValue(false);
        if (condition === "focused") native.getFocusedWindow.mockReturnValue({});
        if (condition === "destroyed") native.isDestroyed.mockReturnValue(true);
        if (condition === "unknown-sender") {
          await expect(show({ sender: { id: 2 } }, notification)).rejects.toThrow(
            "registered application frame",
          );
        } else expect(await show(event, notification)).toBe(false);
        expect(native.create).not.toHaveBeenCalled();
      }),
    ),
);

it.effect.each(["failed", "throw"])("falls back when Electron presentation %s", (failure) =>
  withHandlers((show) =>
    Effect.promise(async () => {
      if (failure === "failed") native.showEvent = "failed";
      else
        native.create.mockImplementation(() => {
          throw new Error("Unavailable");
        });
      expect(await show(event, notification)).toBe(false);
      expect(native.webContents.send).not.toHaveBeenCalled();
      for (const instance of native.instances) {
        expect(instance.close).toHaveBeenCalledOnce();
        expect(instance.eventNames()).toEqual([]);
      }
    }),
  ),
);

it.effect.each(["action", "reply"])(
  "forwards one %s to the originating renderer with its alert id",
  (type) =>
    withHandlers((show) =>
      Effect.promise(async () => {
        await show(event, notification);
        const instance = native.instances[0]!;
        instance.emit(type, type === "action" ? { actionIndex: 1 } : { reply: "Custom answer" });
        instance.emit(type, type === "action" ? { actionIndex: 0 } : { reply: "Duplicate" });
        expect(native.webContents.send).toHaveBeenCalledExactlyOnceWith(
          "desktop:notification-response",
          {
            id: notification.id,
            type,
            ...(type === "action" ? { actionIndex: 1 } : { reply: "Custom answer" }),
          },
        );
        expect(instance.close).toHaveBeenCalledOnce();
        expect(instance.eventNames()).toEqual([]);
        expect(native.focus).not.toHaveBeenCalled();
      }),
    ),
);

it.effect("ignores invalid action indices and replies without a reply field", () =>
  withHandlers((show) =>
    Effect.promise(async () => {
      await show(event, { ...notification, hasReply: false });
      const instance = native.instances[0]!;
      for (const actionIndex of [-1, 0.5, 2, Infinity]) instance.emit("action", { actionIndex });
      instance.emit("reply", { reply: "Unexpected" });
      expect(native.webContents.send).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("restores and focuses the originating chat window on click", () =>
  withHandlers((show) =>
    Effect.promise(async () => {
      await show(event, notification);
      native.instances[0]!.emit("click");
      expect(native.webContents.send).toHaveBeenCalledExactlyOnceWith(
        "desktop:notification-response",
        { id: notification.id, type: "click" },
      );
      expect(native.restore).toHaveBeenCalledOnce();
      expect(native.show).toHaveBeenCalledOnce();
      expect(native.focus).toHaveBeenCalledOnce();
    }),
  ),
);

it.effect("restores the requesting window when a stale action needs the chat", () =>
  withHandlers((show, _, focus) =>
    Effect.promise(async () => {
      await show(event, notification);
      native.instances[0]!.emit("action", { actionIndex: 0 });
      expect(native.focus).not.toHaveBeenCalled();
      await expect(focus({ sender: { id: 2 } }, undefined)).rejects.toThrow(
        "registered application frame",
      );
      expect(native.focus).not.toHaveBeenCalled();
      await focus(event, undefined);
      expect(native.restore).toHaveBeenCalledOnce();
      expect(native.show).toHaveBeenCalledOnce();
      expect(native.focus).toHaveBeenCalledOnce();
    }),
  ),
);

it.effect("releases an alert when its renderer is destroyed", () =>
  withHandlers((show) =>
    Effect.promise(async () => {
      await show(event, notification);
      const destroy = native.webContents.once.mock.calls[0]![1] as () => void;
      destroy();
      expect(native.instances[0]!.close).toHaveBeenCalledOnce();
      expect(native.instances[0]!.eventNames()).toEqual([]);
    }),
  ),
);

it.effect("replaces the same tag, retains other tags, and ignores replaced responses", () =>
  withHandlers((show, close) =>
    Effect.promise(async () => {
      await show(event, notification);
      await show(event, { ...notification, id: "another-chat", tag: "environment:another-chat" });
      await show(event, { ...notification, id: "replacement" });
      const [replaced, other, replacement] = native.instances;
      expect(replaced!.close).toHaveBeenCalledOnce();
      expect(other!.close).not.toHaveBeenCalled();
      expect(native.webContents.once).toHaveBeenCalledOnce();
      replaced!.emit("action", { actionIndex: 0 });
      expect(native.webContents.send).not.toHaveBeenCalled();
      await close(event, notification.id);
      await expect(close({ sender: { id: 2 } }, "replacement")).rejects.toThrow(
        "registered application frame",
      );
      expect(replacement!.close).not.toHaveBeenCalled();
      await close(event, "replacement");
      expect(replacement!.close).toHaveBeenCalledOnce();
      expect(other!.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect.each(["browser-window-focus", "before-quit", "disposal"])(
  "clears retained notifications on %s",
  (trigger) =>
    withHandlers((show) =>
      Effect.promise(async () => {
        await show(event, notification);
        await show(event, { ...notification, id: "another", tag: "another" });
        if (trigger !== "disposal") native.listeners.get(trigger)!();
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const instance of native.instances) {
            expect(instance.close).toHaveBeenCalledOnce();
            expect(instance.eventNames()).toEqual([]);
          }
        }),
      ),
    ),
);

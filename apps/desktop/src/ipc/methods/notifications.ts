import { DesktopNotification, type DesktopNotificationResponse } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  CLOSE_NOTIFICATION_CHANNEL,
  FOCUS_NOTIFICATION_WINDOW_CHANNEL,
  NOTIFICATION_RESPONSE_CHANNEL,
  SHOW_NOTIFICATION_CHANNEL,
} from "../channels.ts";

export const installNotifications = Effect.fn("desktop.ipc.installNotifications")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  const platform = yield* HostProcess.Platform;
  const pending = new Map<
    string,
    { readonly id: string; readonly senderId: number; readonly close: () => void }
  >();
  const watchedWindows = new Map<Electron.BrowserWindow, () => void>();
  const watchWindow = (window: Electron.BrowserWindow) => {
    if (watchedWindows.has(window)) return;
    const webContents = window.webContents;
    const senderId = webContents.id;
    const destroyed = () => {
      watchedWindows.delete(window);
      for (const notification of pending.values()) {
        if (notification.senderId === senderId) notification.close();
      }
    };
    webContents.once("destroyed", destroyed);
    watchedWindows.set(window, () => webContents.removeListener("destroyed", destroyed));
  };
  const senderWindow = (event?: DesktopIpc.DesktopIpcInvokeEvent) =>
    Electron.BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.webContents.id === event?.sender.id,
    );
  const focus = (window: Electron.BrowserWindow) => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SHOW_NOTIFICATION_CHANNEL,
      payload: DesktopNotification,
      result: Schema.Boolean,
      handler: (input, event) =>
        Effect.promise(async () => {
          if (platform !== "darwin" || !Electron.Notification.isSupported() || !event) return false;
          const window = senderWindow(event);
          if (!window || Electron.BrowserWindow.getFocusedWindow()) return false;
          const tag = `${event.sender.id}:${input.tag}`;
          pending.get(tag)?.close();
          return new Promise<boolean>((resolve) => {
            try {
              const notification = new Electron.Notification({
                id: tag,
                title: input.title,
                body: input.body,
                // Electron 44's UNNotification backend supports buttons with hasReply;
                // the NotificationAction docs still describe the older macOS backend.
                actions: input.actions.map((text) => ({ type: "button", text })),
                hasReply: input.hasReply,
                replyPlaceholder: "Your answer",
                silent: true,
              });
              let closed = false;
              const close = () => {
                if (closed) return;
                closed = true;
                if (pending.get(tag)?.id === input.id) pending.delete(tag);
                notification.removeAllListeners();
                notification.close();
                resolve(false);
              };
              const respond = (response: DesktopNotificationResponse) => {
                if (pending.get(tag)?.id !== input.id || window.isDestroyed()) return;
                window.webContents.send(NOTIFICATION_RESPONSE_CHANNEL, response);
                if (response.type === "click") focus(window);
                close();
              };
              pending.set(tag, { id: input.id, senderId: event.sender.id, close });
              watchWindow(window);
              notification.on("show", () => resolve(true));
              notification.on("failed", close);
              notification.on("close", close);
              notification.on("click", () => respond({ id: input.id, type: "click" }));
              notification.on("action", (event) => {
                if (
                  Number.isInteger(event.actionIndex) &&
                  input.actions[event.actionIndex] !== undefined
                )
                  respond({ id: input.id, type: "action", actionIndex: event.actionIndex });
              });
              notification.on("reply", (event) => {
                if (input.hasReply) respond({ id: input.id, type: "reply", reply: event.reply });
              });
              notification.show();
            } catch {
              pending.get(tag)?.close();
              resolve(false);
            }
          });
        }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: FOCUS_NOTIFICATION_WINDOW_CHANNEL,
      payload: Schema.Void,
      result: Schema.Void,
      handler: (_, event) =>
        Effect.sync(() => {
          const window = senderWindow(event);
          if (window) focus(window);
        }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: CLOSE_NOTIFICATION_CHANNEL,
      payload: Schema.String,
      result: Schema.Void,
      handler: (id, event) =>
        Effect.sync(() => {
          for (const notification of pending.values()) {
            if (notification.id === id && notification.senderId === event?.sender.id)
              notification.close();
          }
        }),
    }),
  );
  const clear = () => {
    for (const notification of pending.values()) notification.close();
  };
  yield* app.on("browser-window-focus", clear);
  yield* app.on("before-quit", clear);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      clear();
      for (const unwatch of watchedWindows.values()) unwatch();
      watchedWindows.clear();
    }),
  );
});

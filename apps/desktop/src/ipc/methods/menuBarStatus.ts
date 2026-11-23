import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { MENU_BAR_OPEN_CHAT_CHANNEL, SET_MENU_BAR_STATUS_CHANNEL } from "../channels.ts";
import { MENU_BAR_ICON_1X, MENU_BAR_ICON_2X } from "./menuBarIcon.ts";
import {
  menuBarEntries,
  menuBarTitle,
  menuBarTooltip,
  type MenuBarChat,
  type MenuBarEntry,
} from "./menuBarStatus.logic.ts";

const MAX_CHATS = 40;
const MAX_LIMITS = 12;
const Id = Schema.String.check(Schema.isMaxLength(256));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));
const Chat = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  title: Schema.String.check(Schema.isMaxLength(400)),
});
const Status = Schema.NullOr(
  Schema.Struct({
    needsYou: Schema.Array(Chat),
    needsYouCount: Count,
    working: Schema.Array(Chat),
    workingCount: Count,
    limits: Schema.Array(Schema.String.check(Schema.isMaxLength(200))),
  }),
);

function menuBarIcon(): Electron.NativeImage {
  const image = Electron.nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, width: 18, height: 18, dataURL: MENU_BAR_ICON_1X });
  image.addRepresentation({ scaleFactor: 2, width: 36, height: 36, dataURL: MENU_BAR_ICON_2X });
  image.setTemplateImage(true);
  return image;
}

/**
 * The macOS menu-bar item: a small icon, the number of chats that need the user beside it, and a
 * menu of those chats, the chats still working and the usage limits. The window that last sent a
 * status owns the item; it goes away with that window or when the status is null (setting off).
 */
export const installMenuBarStatus = Effect.fn("desktop.ipc.installMenuBarStatus")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcess.Platform;
  let tray: Electron.Tray | null = null;
  let owner: Electron.BrowserWindow | null = null;

  const removeTray = () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  const ownerDestroyed = () => {
    owner = null;
    removeTray();
  };
  const setOwner = (window: Electron.BrowserWindow) => {
    if (owner === window) return;
    if (owner && !owner.isDestroyed())
      owner.webContents.removeListener("destroyed", ownerDestroyed);
    owner = window;
    window.webContents.once("destroyed", ownerDestroyed);
  };
  const targetWindow = () =>
    owner && !owner.isDestroyed()
      ? owner
      : Electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  const focus = (window: Electron.BrowserWindow) => {
    if (window.isMinimized()) window.restore();
    window.show();
    // A menu-bar click leaves the app in the background; bring it forward.
    Electron.app.focus({ steal: true });
    window.focus();
  };
  const openApp = () => {
    const window = targetWindow();
    if (window) focus(window);
    else Electron.app.emit("activate");
  };
  const openChat = (chat: MenuBarChat) => {
    const window = targetWindow();
    if (!window) {
      Electron.app.emit("activate");
      return;
    }
    focus(window);
    window.webContents.send(MENU_BAR_OPEN_CHAT_CHANNEL, {
      environmentId: chat.environmentId,
      threadId: chat.threadId,
    });
  };
  const menuItem = (entry: MenuBarEntry): Electron.MenuItemConstructorOptions => {
    if (entry.kind === "separator") return { type: "separator" };
    if (entry.kind === "chat") return { label: entry.label, click: () => openChat(entry.chat) };
    if (entry.kind === "open-app") return { label: entry.label, click: openApp };
    return { label: entry.label, enabled: false };
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_MENU_BAR_STATUS_CHANNEL,
      payload: Status,
      result: Schema.Void,
      handler: (input, event) =>
        Effect.sync(() => {
          if (platform !== "darwin" || !event) return;
          try {
            if (input === null) {
              removeTray();
              return;
            }
            const sender = Electron.BrowserWindow.getAllWindows().find(
              (window) => !window.isDestroyed() && window.webContents.id === event.sender.id,
            );
            if (!sender) return;
            setOwner(sender);
            const status = {
              ...input,
              needsYou: input.needsYou.slice(0, MAX_CHATS),
              working: input.working.slice(0, MAX_CHATS),
              limits: input.limits.slice(0, MAX_LIMITS),
            };
            if (!tray || tray.isDestroyed()) tray = new Electron.Tray(menuBarIcon());
            tray.setTitle(menuBarTitle(status), { fontType: "monospacedDigit" });
            tray.setToolTip(menuBarTooltip(status, Electron.app.name));
            tray.setContextMenu(
              Electron.Menu.buildFromTemplate(
                menuBarEntries(status, Electron.app.name).map(menuItem),
              ),
            );
          } catch (error) {
            Effect.runSync(Effect.logWarning("Could not update the menu bar item", error));
          }
        }),
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (owner && !owner.isDestroyed()) {
        owner.webContents.removeListener("destroyed", ownerDestroyed);
      }
      owner = null;
      removeTray();
    }),
  );
});

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_KEEP_AWAKE_CHANNEL } from "../channels.ts";
import { keepAwakeWanted, type KeepAwakeWork } from "./keepAwake.logic.ts";

const Work = Schema.NullOr(Schema.Struct({ working: Schema.Boolean, waiting: Schema.Boolean }));

/**
 * Keeps the computer from idle-sleeping while agents work, as told by the window that last
 * reported. The display may still sleep and a closed laptop lid still sleeps the machine. The
 * hold ends with that window, and switching between battery and mains power re-decides it.
 */
export const installKeepAwake = Effect.fn("desktop.ipc.installKeepAwake")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  let work: KeepAwakeWork | null = null;
  let blockerId: number | null = null;
  let owner: Electron.WebContents | null = null;

  const apply = () => {
    try {
      const wanted = keepAwakeWanted(work, Electron.powerMonitor.isOnBatteryPower());
      const held = blockerId !== null && Electron.powerSaveBlocker.isStarted(blockerId);
      if (wanted && !held) {
        blockerId = Electron.powerSaveBlocker.start("prevent-app-suspension");
      } else if (!wanted && held && blockerId !== null) {
        Electron.powerSaveBlocker.stop(blockerId);
        blockerId = null;
      }
    } catch (error) {
      Effect.runSync(Effect.logWarning("Could not change the keep-awake state", error));
    }
  };
  const ownerDestroyed = () => {
    owner = null;
    work = null;
    apply();
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_KEEP_AWAKE_CHANNEL,
      payload: Work,
      result: Schema.Void,
      handler: (input, event) =>
        Effect.sync(() => {
          if (!event) return;
          const sender = Electron.BrowserWindow.getAllWindows().find(
            (window) => !window.isDestroyed() && window.webContents.id === event.sender.id,
          )?.webContents;
          if (!sender) return;
          if (owner !== sender) {
            if (owner && !owner.isDestroyed()) owner.removeListener("destroyed", ownerDestroyed);
            owner = sender;
            sender.once("destroyed", ownerDestroyed);
          }
          work = input;
          apply();
        }),
    }),
  );
  Electron.powerMonitor.on("on-ac", apply);
  Electron.powerMonitor.on("on-battery", apply);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.powerMonitor.removeListener("on-ac", apply);
      Electron.powerMonitor.removeListener("on-battery", apply);
      if (owner && !owner.isDestroyed()) owner.removeListener("destroyed", ownerDestroyed);
      owner = null;
      work = null;
      apply();
    }),
  );
});

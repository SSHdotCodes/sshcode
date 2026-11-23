import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";
import { DesktopMediaStore, validateDesktopMediaInput } from "./mediaStore.ts";

class DesktopMediaError extends Schema.TaggedError<DesktopMediaError>()("DesktopMediaError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Media could not be prepared.";
  }
}

/** Only the main frame of the app's main window may use native media actions. */
export function isTrustedMediaSender(
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  main: { readonly webContents: { readonly id: number; readonly mainFrame: unknown } } | null,
): boolean {
  return (
    event !== undefined &&
    main !== null &&
    event.sender === main.webContents &&
    event.senderFrame === main.webContents.mainFrame &&
    event.senderFrame != null
  );
}

export function mediaIpcMethods(store: DesktopMediaStore) {
  const trustedWindow = Effect.fn("desktop.ipc.media.trustedWindow")(function* (
    event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  ) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (Option.isNone(main) || !isTrustedMediaSender(event, Option.getOrNull(main)))
      return yield* new DesktopMediaError({ cause: "unauthorized sender" });
    return main.value;
  });
  const prepare = DesktopIpc.makeIpcMethod({
    channel: Channels.PREPARE_DESKTOP_MEDIA_CHANNEL,
    payload: Schema.Unknown,
    result: Schema.String,
    handler: (input, event) =>
      Effect.gen(function* () {
        yield* trustedWindow(event);
        if (!validateDesktopMediaInput(input))
          return yield* new DesktopMediaError({ cause: "invalid data" });
        return yield* Effect.tryPromise({
          try: () => store.prepare(input),
          catch: (cause) => new DesktopMediaError({ cause }),
        });
      }),
  });
  const preview = DesktopIpc.makeIpcMethod({
    channel: Channels.PREVIEW_DESKTOP_MEDIA_CHANNEL,
    payload: Schema.String,
    result: Schema.Boolean,
    handler: (token, event) =>
      Effect.gen(function* () {
        const main = yield* trustedWindow(event);
        const file = store.get(token);
        if (!file) return false;
        return yield* Effect.try({
          try: () => {
            main.previewFile(file);
            store.pinPreview(token);
            return true;
          },
          catch: (cause) => new DesktopMediaError({ cause }),
        });
      }),
  });
  const close = DesktopIpc.makeIpcMethod({
    channel: Channels.CLOSE_DESKTOP_MEDIA_PREVIEW_CHANNEL,
    payload: Schema.String,
    result: Schema.Void,
    handler: (token, event) =>
      Effect.gen(function* () {
        const main = yield* trustedWindow(event);
        yield* Effect.try({
          try: () => {
            if (store.closePreview(token)) main.closeFilePreview();
          },
          catch: (cause) => new DesktopMediaError({ cause }),
        });
      }),
  });
  return { prepare, preview, close };
}

/** Starts drag only for an owned token sent by the main frame. */
export function startDesktopMediaDrag(
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  main: Electron.BrowserWindow | null,
  token: unknown,
  store: DesktopMediaStore,
  icon: () => Electron.NativeImage,
): boolean {
  if (!isTrustedMediaSender(event, main)) return false;
  const file = store.get(token);
  if (!file || !main) return false;
  try {
    const dragIcon = icon();
    if (dragIcon.isEmpty()) return false;
    main.webContents.startDrag({ file, icon: dragIcon.resize({ width: 64, height: 64 }) });
    return true;
  } catch {
    return false;
  }
}

export const installMediaIpc = Effect.fn("desktop.ipc.installMedia")(function* () {
  if ((yield* HostProcess.Platform) !== "darwin") return;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const windows = yield* ElectronWindow.ElectronWindow;
  const assets = yield* DesktopAssets.DesktopAssets;
  const icons = yield* assets.iconPaths;
  const maybeStore = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => DesktopMediaStore.create(),
      catch: (cause) => new DesktopMediaError({ cause }),
    }).pipe(Effect.option),
    (store) =>
      Option.isSome(store)
        ? Effect.promise(() => store.value.dispose()).pipe(Effect.orDie)
        : Effect.void,
  );
  if (Option.isNone(maybeStore)) return;
  const store = maybeStore.value;
  const methods = mediaIpcMethods(store);
  yield* ipc.handle(methods.prepare);
  yield* ipc.handle(methods.preview);
  yield* ipc.handle(methods.close);
  const onDrag = (event: Electron.IpcMainEvent, token: unknown) => {
    const main = Option.getOrNull(Effect.runSync(windows.main));
    startDesktopMediaDrag(event, main, token, store, () => {
      let icon = Option.isSome(icons.png)
        ? Electron.nativeImage.createFromPath(icons.png.value)
        : Electron.nativeImage.createEmpty();
      if (icon.isEmpty())
        icon = Electron.nativeImage.createFromDataURL(
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        );
      return icon;
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => Electron.ipcMain.on(Channels.DRAG_DESKTOP_MEDIA_CHANNEL, onDrag)),
    () =>
      Effect.sync(() => {
        Electron.ipcMain.removeListener(Channels.DRAG_DESKTOP_MEDIA_CHANNEL, onDrag);
      }),
  );
});

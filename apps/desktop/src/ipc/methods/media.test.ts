// @effect-diagnostics nodeBuiltinImport:off -- The temp-store test inspects its disposable files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";

vi.mock("electron", () => ({}));
import { isTrustedMediaSender, mediaIpcMethods, startDesktopMediaDrag } from "./media.ts";
import {
  DesktopMediaStore,
  MAX_DESKTOP_MEDIA_BYTES,
  validateDesktopMediaInput,
} from "./mediaStore.ts";

const stores: DesktopMediaStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
});

describe("desktop media ipc", () => {
  it("requires the exact main web contents and main frame", () => {
    const main = { webContents: { id: 7, mainFrame: {} } };
    expect(
      isTrustedMediaSender(
        { sender: main.webContents, senderFrame: main.webContents.mainFrame },
        main,
      ),
    ).toBe(true);
    expect(
      isTrustedMediaSender({ sender: { id: 7 }, senderFrame: main.webContents.mainFrame }, main),
    ).toBe(false);
    expect(isTrustedMediaSender({ sender: main.webContents, senderFrame: {} }, main)).toBe(false);
    expect(isTrustedMediaSender({ sender: main.webContents }, main)).toBe(false);
    expect(isTrustedMediaSender(undefined, main)).toBe(false);
  });
  it("rejects invalid payloads and bounds the materialized bytes", () => {
    expect(
      validateDesktopMediaInput({
        name: "a.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1]),
      }),
    ).toBe(true);
    expect(
      validateDesktopMediaInput({ name: "a", mimeType: "text/html", bytes: new Uint8Array([1]) }),
    ).toBe(false);
    expect(
      validateDesktopMediaInput({ name: "a", mimeType: "image/png", bytes: new Uint8Array() }),
    ).toBe(false);
    expect(
      validateDesktopMediaInput({
        name: "a",
        mimeType: "image/png",
        bytes: new Uint8Array(MAX_DESKTOP_MEDIA_BYTES + 1),
      }),
    ).toBe(false);
  });
  it.effect("materializes supplied bytes only for the main frame, using opaque tokens", () =>
    Effect.gen(function* () {
      const store = yield* Effect.promise(() => DesktopMediaStore.create());
      stores.push(store);
      const main = {
        webContents: { id: 7, mainFrame: {} },
        previewFile: vi.fn(),
        closeFilePreview: vi.fn(),
      };
      const windowLayer = {
        main: Effect.succeedSome(main),
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      const methods = mediaIpcMethods(store);
      const input = {
        name: "../../danger.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      };
      const wrongFrame = { sender: main.webContents, senderFrame: {} };
      const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
      const denied = yield* methods.prepare
        .handler(input, wrongFrame)
        .pipe(Effect.provideService(ElectronWindow.ElectronWindow, windowLayer), Effect.exit);
      expect(denied._tag).toBe("Failure");
      const token = yield* methods.prepare
        .handler(input, valid)
        .pipe(Effect.provideService(ElectronWindow.ElectronWindow, windowLayer));
      expect(token).not.toContain("danger");
      const file = store.get(token);
      expect(file).not.toBeNull();
      expect(NodePath.basename(file!)).toBe("_.._danger.png");
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(file!));
      expect([...bytes]).toEqual([1, 2, 3]);
      const invalid = yield* methods.preview
        .handler("/tmp/anything", valid)
        .pipe(Effect.provideService(ElectronWindow.ElectronWindow, windowLayer));
      expect(invalid).toBe(false);
      const opened = yield* methods.preview
        .handler(token, valid)
        .pipe(Effect.provideService(ElectronWindow.ElectronWindow, windowLayer));
      expect(opened).toBe(true);
      expect(main.previewFile).toHaveBeenCalledWith(file);
      const startDrag = vi.fn();
      const mainWithDrag = { ...main, webContents: { ...main.webContents, startDrag } };
      const dragEvent = {
        sender: mainWithDrag.webContents,
        senderFrame: mainWithDrag.webContents.mainFrame,
      };
      const icon = { isEmpty: () => false, resize: () => ({}) };
      const window = mainWithDrag as unknown as import("electron").BrowserWindow;
      const makeIcon = () => icon as unknown as import("electron").NativeImage;
      expect(
        startDesktopMediaDrag({ ...dragEvent, senderFrame: {} }, window, token, store, makeIcon),
      ).toBe(false);
      expect(startDesktopMediaDrag(dragEvent, window, "/tmp/anything", store, makeIcon)).toBe(
        false,
      );
      expect(startDesktopMediaDrag(dragEvent, window, token, store, makeIcon)).toBe(true);
      expect(startDrag).toHaveBeenCalledOnce();
      yield* methods.close
        .handler(token, valid)
        .pipe(Effect.provideService(ElectronWindow.ElectronWindow, windowLayer));
      expect(main.closeFilePreview).toHaveBeenCalledOnce();
      yield* Effect.promise(() => store.dispose());
      const exists = yield* Effect.promise(() =>
        NodeFSP.stat(file!).then(
          () => true,
          () => false,
        ),
      );
      expect(exists).toBe(false);
    }),
  );
});

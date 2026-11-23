import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import { sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

/** A guest whose page reports `focusedDocument` for the focus probe. */
const makeGuest = ({
  focused,
  focusedDocument = true,
}: {
  readonly focused: boolean;
  readonly focusedDocument?: boolean;
}) => {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === "Runtime.evaluate" && params?.expression?.endsWith("!== null")
      ? { result: { value: focusedDocument } }
      : { result: {} },
  );
  const webContents = {
    focusedFrame: focused ? {} : null,
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it.each(["restore", "other-field", "removed", "failure", "child-session", "touch"])(
    "preserves host typing focus after a pointer press: %s",
    async (outcome) => {
      const document = { activeElement: {} as object };
      const composer = {
        isConnected: true,
        focus: () => {
          document.activeElement = composer;
        },
      };
      const preview = { tagName: "WEBVIEW", getWebContentsId: () => 7 };
      const other = { tagName: "INPUT" };
      document.activeElement = composer;
      const context = NodeVM.createContext({ document });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const debuggee = {
        sendCommand: async () => {
          document.activeElement = outcome === "other-field" ? other : preview;
          if (outcome === "removed") composer.isConnected = false;
          if (outcome === "failure") throw new Error("Pointer failed");
          return {};
        },
      };
      const result = sendPageCommand(
        { id: 7, focusedFrame: null, hostWebContents: host } as unknown as Electron.WebContents,
        debuggee as unknown as Electron.Debugger,
        outcome === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent",
        { type: outcome === "touch" ? "touchStart" : "mousePressed" },
        outcome === "child-session" ? "child-frame" : undefined,
      );
      if (outcome === "failure") await expect(result).rejects.toThrow("Pointer failed");
      else await result;
      expect(document.activeElement).toBe(
        outcome === "other-field" ? other : outcome === "removed" ? preview : composer,
      );
      expect(Object.keys(context)).toEqual(["document"]);
    },
  );

  it.each([false, true])(
    "shares saved focus across sibling presses, user changes focus: %s",
    async (userClicks) => {
      const document = { activeElement: {} as object };
      const composer = {
        isConnected: true,
        focus: () => {
          document.activeElement = composer;
        },
      };
      document.activeElement = composer;
      const context = NodeVM.createContext({ document });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const previews = new Map(
        [7, 8].map((id) => [id, { tagName: "WEBVIEW", getWebContentsId: () => id }]),
      );
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const press = (id: number) =>
        sendPageCommand(
          { id, focusedFrame: null, hostWebContents: host } as unknown as Electron.WebContents,
          {
            sendCommand: async () => {
              document.activeElement = previews.get(id)!;
              if (id === 7) {
                started.resolve();
                await finish.promise;
              } else if (userClicks) document.activeElement = previews.get(7)!;
              return {};
            },
          } as unknown as Electron.Debugger,
          "Input.dispatchMouseEvent",
          { type: "mousePressed" },
        );
      const stuck = press(7);
      await started.promise;
      await press(8);
      expect(document.activeElement).toBe(userClicks ? previews.get(7) : composer);
      finish.resolve();
      await stuck;
      expect(Object.keys(context)).toEqual(["document"]);
    },
  );

  it.each([false, true])(
    "keeps release behind focus capture, failed press: %s",
    async (failPress) => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const events: unknown[] = [];
      const guest = {
        id: 7,
        focusedFrame: null,
        hostWebContents: {
          isDestroyed: () => false,
          executeJavaScript: async () => {
            started.resolve();
            await finish.promise;
          },
        },
      };
      const debuggee = {
        sendCommand: async (_method: string, params: Record<string, unknown>) => {
          events.push(params["type"]);
          if (failPress && params["type"] === "mousePressed") throw new Error("Press failed");
          return {};
        },
      };
      const send = (type: string) =>
        sendPageCommand(
          guest as unknown as Electron.WebContents,
          debuggee as unknown as Electron.Debugger,
          "Input.dispatchMouseEvent",
          { type },
        );
      const pressed = send("mousePressed");
      await started.promise;
      const released = send("mouseReleased");
      finish.resolve();
      const results = await Promise.allSettled([pressed, released]);
      expect(results.map((result) => result.status)).toEqual([
        failPress ? "rejected" : "fulfilled",
        "fulfilled",
      ]);
      expect(events).toEqual(["mousePressed", "mouseReleased"]);
    },
  );

  it.each([undefined, false, true])(
    "reloads only the guest with ignoreCache=%s",
    async (ignoreCache) => {
      const guest = makeGuest({ focused: false });
      await expect(
        guest.send("Page.reload", ignoreCache === undefined ? {} : { ignoreCache }),
      ).resolves.toEqual({});
      expect(guest.webContents.reload).toHaveBeenCalledTimes(ignoreCache ? 0 : 1);
      expect(guest.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(ignoreCache ? 1 : 0);
      expect(guest.sendCommand).not.toHaveBeenCalled();
    },
  );

  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("uses CDP input while the guest holds focus, where it already reaches the page", async () => {
    const guest = makeGuest({ focused: true });
    await guest.send("Input.insertText", { text: "x" });
    await guest.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
    expect(guest.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Input.insertText",
      "Input.dispatchKeyEvent",
    ]);
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  it("clears a field with Cmd+A and Delete while unfocused, never touching the clipboard", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      modifiers: 4,
      commands: ["selectAll", "paste"],
    });
    await guest.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete" });
    expect(guest.webContents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "rawKeyDown", keyCode: "a", modifiers: ["meta"] },
      { type: "rawKeyDown", keyCode: "Delete", modifiers: [] },
    ]);
    const scripts = guest.sendCommand.mock.calls.map(([, params]) => params?.expression ?? "");
    expect(scripts.some((script) => script.includes('["selectAll"]'))).toBe(true);
    expect(scripts.some((script) => script.includes("paste"))).toBe(false);
  });

  it("does not run other page commands through the guest's direct input", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });
    expect(guest.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: 1,
        y: 1,
      },
      undefined,
    );
    expect(guest.webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});

describe("CDP key events as Electron input", () => {
  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});

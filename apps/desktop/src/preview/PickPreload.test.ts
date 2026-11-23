// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipc.listeners.set(channel, listener),
    off: (channel: string) => ipc.listeners.delete(channel),
    send: ipc.send,
  },
}));
vi.mock("react-grab/primitives", () => ({ getElementContext: async () => null }));

let shadow: ShadowRoot;
const attachShadow = Element.prototype.attachShadow;

beforeAll(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
    shadow = attachShadow.call(this, init);
    return shadow;
  });
  await import("./PickPreload.ts");
});
beforeEach(() => {
  document.body.innerHTML = '<input id="page-field"><button id="page-button">Page</button>';
  ipc.send.mockClear();
  ipc.listeners.get(START_PICK_CHANNEL)!(undefined, undefined, true);
});
afterEach(() => {
  ipc.listeners.get(CANCEL_PICK_CHANNEL)?.();
});

const comment = () => shadow.querySelector("textarea")!;
const key = (type: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent(type, {
    key: "a",
    bubbles: true,
    composed: true,
    cancelable: true,
    ...options,
  });
  comment().dispatchEvent(event);
  return event;
};

describe("preview annotation event isolation", () => {
  it("hides comment keys from page capture listeners while preserving normal editing", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page, true);
    window.addEventListener("keypress", page, true);
    window.addEventListener("keyup", page, true);
    try {
      comment().focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        expect(key(type).defaultPrevented).toBe(false);
      }
      expect(page).not.toHaveBeenCalled();
      document
        .querySelector("#page-button")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
      expect(page).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", page, true);
      window.removeEventListener("keypress", page, true);
      window.removeEventListener("keyup", page, true);
    }
  });

  it("keeps Enter submission, Shift+Enter, composition and Escape behavior", () => {
    comment().focus();
    expect(key("keydown", { key: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
    expect(key("keydown", { key: "Enter", isComposing: true }).defaultPrevented).toBe(false);
    expect(key("keydown", { key: "Enter" }).defaultPrevented).toBe(true);
    expect(key("keydown", { key: "Enter", metaKey: true }).defaultPrevented).toBe(true);
    expect(key("keydown", { key: "Escape" }).defaultPrevented).toBe(true);
    expect(document.querySelector("[data-t3code-annotation-ui]")).toBeNull();
  });

  it.each(["pointerdown", "focusin", "focusout", "wheel", "touchstart", "touchmove"])(
    "keeps overlay %s away from document dialog and scroll handlers",
    (type) => {
      const page = vi.fn();
      const overlay = vi.fn();
      document.addEventListener(type, page);
      comment().addEventListener(type, overlay);
      try {
        comment().dispatchEvent(
          new Event(type, { bubbles: true, composed: true, cancelable: true }),
        );
        expect(overlay).toHaveBeenCalledOnce();
        expect(page).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener(type, page);
      }
    },
  );

  it("hides focus leaving the page for the overlay from page dialog handlers", () => {
    const page = vi.fn();
    document.addEventListener("focusout", page);
    try {
      document.querySelector("#page-field")!.dispatchEvent(
        new FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: document.querySelector("[data-t3code-annotation-ui]"),
        }),
      );
      expect(page).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("focusout", page);
    }
  });
});

it.each([
  { scrolled: false, rect: { x: 40, y: 60, width: 200, height: 120 } },
  // The last rect would point at whatever now sits there, so no crop beats a wrong one.
  { scrolled: true, rect: { x: 0, y: 0, width: 0, height: 0 } },
])(
  "submits a replaced element's last rect unless the page scrolled ($scrolled)",
  async ({ scrolled, rect }) => {
    const card = document.body.appendChild(document.createElement("div"));
    const pickedRect = new DOMRect(40, 60, 200, 120);
    // Browsers report a detached element at 0x0 in the corner.
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(() =>
      card.isConnected ? pickedRect : new DOMRect(),
    );
    document.elementsFromPoint = () => [card];

    card.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
    );
    // A polling page re-renders while the comment is written and replaces the picked node.
    card.replaceWith(document.createElement("div"));
    if (scrolled) window.dispatchEvent(new Event("scroll"));
    const attach = Array.from(shadow.querySelectorAll("button")).find(
      (button) => button.textContent === "Attach",
    );
    if (!attach) throw new Error("Attach button not found");
    attach.click();

    await vi.waitFor(() =>
      expect(ipc.send.mock.calls.some(([channel]) => channel === ELEMENT_PICKED_CHANNEL)).toBe(
        true,
      ),
    );
    const [, annotation] =
      ipc.send.mock.calls.find(([channel]) => channel === ELEMENT_PICKED_CHANNEL) ?? [];
    expect((annotation as { elements: Array<{ rect: unknown }> }).elements[0]?.rect).toEqual(rect);
  },
);

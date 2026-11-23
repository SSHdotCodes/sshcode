// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { serializeEditorDoc } from "../composer-rich-text-doc";
import { OverviewComposer } from "./OverviewComposer";

const env = EnvironmentId.make("env-1");
const { shells } = vi.hoisted(() => ({
  shells: [
    {
      environmentId: "env-1",
      id: "idle",
      title: "Login idle",
      updatedAt: "2026-10-19T12:00:00Z",
      archivedAt: null,
      deletedAt: null,
      runtime: null,
      latestRun: null,
    },
    {
      environmentId: "env-1",
      id: "working",
      title: "Login working",
      updatedAt: "2026-10-18T12:00:00Z",
      archivedAt: null,
      deletedAt: null,
      runtime: { status: "running" },
      latestRun: null,
    },
    {
      environmentId: "env-1",
      id: "overview-self",
      title: "Overview",
      updatedAt: "2026-10-19T12:00:00Z",
      archivedAt: null,
      deletedAt: null,
      runtime: null,
      latestRun: null,
    },
  ],
}));
vi.mock("../state/entities", () => ({ useThreadShells: () => shells }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("./ThreadContextChip", () => ({
  ThreadContextChip: ({ record }: { record: { title: string } }) => <span>{record.title}</span>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[:"\\]/g, "\\$&") });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function editor() {
  return container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!.editor;
}
async function type(text: string) {
  for (const char of text)
    await act(async () => editor().view.dispatch(editor().state.tr.insertText(char)));
}
async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(async () => {
    editor().view.props.handleKeyDown?.(editor().view, event);
  });
}

it("offers working chats at @, filters titles, picks with the keyboard and sends structured context", async () => {
  const onSend = vi.fn();
  await act(async () =>
    root.render(<OverviewComposer environmentId={env} onSend={onSend} autoFocus={false} />),
  );
  await type("How is @");
  expect(
    [...container.querySelectorAll("[data-composer-item-id]")].map((item) => item.textContent),
  ).toEqual(["Login workingWorking chat", "Login idleThread"]);
  await type("working");
  expect(container.querySelectorAll("[data-composer-item-id]")).toHaveLength(1);
  await press("Enter");
  expect(onSend).not.toHaveBeenCalled();
  expect(serializeEditorDoc(editor().state.doc).value).toBe(
    "How is [Login working](t3-context://v1/thread/thread_working) ",
  );
  expect(editor().state.doc.firstChild?.child(1).type.name).toBe("composer-context-reference");
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "How is [Login working](t3-context://v1/thread/thread_working) ",
    {
      version: 1,
      records: [
        {
          version: 1,
          kind: "thread",
          contextId: "thread_working",
          label: "Login working",
          title: "Login working",
          environmentId: env,
          threadId: ThreadId.make("working"),
        },
      ],
    },
  );
  expect(serializeEditorDoc(editor().state.doc).value).toBe("");
});

it("dismisses suggestions with Escape and supports selecting a different chat with arrows and Tab", async () => {
  const onSend = vi.fn();
  await act(async () =>
    root.render(<OverviewComposer environmentId={env} onSend={onSend} autoFocus={false} />),
  );
  await type("@");
  await press("Escape");
  expect(container.querySelector("[data-composer-command-drawer]")).toBeNull();
  await type("log");
  expect(container.querySelector("[data-composer-command-drawer]")).toBeNull();
  await type(" @");
  await press("ArrowDown");
  await press("Tab");
  expect(serializeEditorDoc(editor().state.doc).value).toContain(
    "[Login idle](t3-context://v1/thread/thread_idle)",
  );
});

it("inserts Quest dictation at the caret and sends through the existing context path", async () => {
  sessionStorage.setItem("sshcodePanel", "overview");
  try {
    const onSend = vi.fn();
    await act(async () =>
      root.render(<OverviewComposer environmentId={env} onSend={onSend} autoFocus={false} />),
    );
    await type("Ask @working");
    await press("Enter");
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await act(async () => {
      editor().commands.setTextSelection(1);
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("sshcode-quest", { detail: { type: "insertText", text: "Please " } }),
      );
    });
    expect(serializeEditorDoc(editor().state.doc).value).toBe(
      "Please Ask [Login working](t3-context://v1/thread/thread_working) ",
    );
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sshcode-quest", { detail: { type: "send" } }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe(
      "Please Ask [Login working](t3-context://v1/thread/thread_working) ",
    );
    expect(onSend.mock.calls[0]?.[1].records).toEqual([
      expect.objectContaining({ kind: "thread", threadId: "working" }),
    ]);
  } finally {
    sessionStorage.clear();
  }
});

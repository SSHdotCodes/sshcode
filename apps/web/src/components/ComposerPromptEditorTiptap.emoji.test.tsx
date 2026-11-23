// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import * as emoji from "@t3tools/shared/emoji";
import { loadEmojiData } from "@t3tools/shared/emoji";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;
let commandKey: ReturnType<typeof vi.fn<() => boolean>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  commandKey = vi.fn(() => false);
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(value: string, richTextEnabled = true, literalText = false, preload = true) {
  if (preload) await loadEmojiData();
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
        richTextEnabled={richTextEnabled}
        literalText={literalText}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
        onCommandKeyDown={commandKey}
      />,
    ),
  );
  const editor = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!.editor;
  await act(async () => {
    editor.view.focus();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  return editor;
}
function press(editor: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  return editor.view.props.handleKeyDown?.(editor.view, event);
}

describe("composer emoji", () => {
  it.each(["Enter", "Tab"])(
    "inserts the highlighted emoji with %s without submitting",
    async (key) => {
      const editor = await mount("great :ta");
      await vi.waitFor(() =>
        expect(document.querySelector('[role="option"]')?.textContent).toContain(":tada:"),
      );
      await act(async () => {
        expect(press(editor, key)).toBe(true);
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe("great 🎉");
      expect(commandKey).not.toHaveBeenCalled();
      await act(async () => {
        editor.commands.undo();
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe("great :ta");
    },
  );
  it("navigates suggestions and keeps Escape dismissed until the token changes", async () => {
    const editor = await mount(":ta");
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(1),
    );
    await act(async () => {
      press(editor, "ArrowDown");
    });
    const selected = document.querySelector('[role="option"][aria-selected="true"]')!.textContent!;
    expect(selected).not.toContain(":tada:");
    await act(async () => {
      press(editor, "Escape");
    });
    await act(async () => {
      editor.commands.setTextSelection(2);
    });
    commandKey.mockClear();
    await act(async () => {
      press(editor, "ArrowDown");
    });
    expect(commandKey).toHaveBeenCalled();
    await act(async () => {
      editor.commands.setTextSelection(4);
    });
    commandKey.mockClear();
    await act(async () => {
      press(editor, "ArrowDown");
    });
    expect(commandKey).toHaveBeenCalled();
  });
  it.each([
    ["10:30", true],
    ["https://example.com/:ta", true],
    ["`:ta`", true],
    ["```\n:ta\n```", true],
    ["` :ta", false],
    ["~~~\n:ta", false],
  ])("does not offer emoji in %j", async (value, richText) => {
    await mount(value as string, richText as boolean);
    expect(document.querySelector('[aria-label="Emoji suggestions"][role="listbox"]')).toBeNull();
  });
  it.each(["ArrowUp", "ArrowDown"])(
    "leaves %s available when a shortcode has no matches",
    async (key) => {
      const editor = await mount(":zzzz");
      await vi.waitFor(() =>
        expect(document.querySelector('[role="status"]')?.textContent).toBe("No matching emoji"),
      );
      commandKey.mockClear();
      await act(async () => {
        expect(press(editor, key)).toBe(false);
      });
      expect(commandKey).toHaveBeenCalledWith(key, expect.any(KeyboardEvent));
      expect(document.querySelector('[role="listbox"] [role="status"]')).toBeNull();
    },
  );
  it.each(["Enter", "Tab"])("leaves %s available while emoji data is loading", async (key) => {
    vi.spyOn(emoji, "loadEmojiData").mockReturnValue(new Promise(() => {}));
    const editor = await mount(":ta", true, false, false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading emoji…");
    commandKey.mockClear();
    commandKey.mockReturnValue(key === "Enter");
    await act(async () => {
      expect(press(editor, key)).toBe(key === "Enter");
    });
    expect(commandKey).toHaveBeenCalledWith(
      key,
      expect.any(KeyboardEvent),
      ...(key === "Enter" ? [false] : []),
    );
    expect(serializeEditorDoc(editor.state.doc).value).toBe(":ta");
  });
  it("groups recent and popular emoji under accessible labels", async () => {
    localStorage.setItem("t3code:emoji-recents:v1", '["tada"]');
    await mount("");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Choose emoji"]')!.click();
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector('[role="group"][aria-label="Recent"] [role="option"]'),
      ).not.toBeNull(),
    );
    const listbox = document.querySelector('[role="listbox"][aria-label="Emoji"]')!;
    expect(
      listbox.querySelectorAll('[role="group"][aria-label="Recent"] [role="option"]'),
    ).toHaveLength(1);
    expect(
      listbox.querySelector('[role="group"][aria-label="Popular"] [role="option"]'),
    ).not.toBeNull();
    expect(
      [...listbox.querySelectorAll("p")].every(
        (label) => label.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
    expect(listbox.querySelector('[role="status"]')).toBeNull();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search emoji"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "zzzz",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toBe("No emoji found."),
    );
    expect(listbox.querySelector('[role="group"][aria-label="Search results"]')).not.toBeNull();
    expect(listbox.querySelector('[role="status"]')).toBeNull();
  });
  it("offers emoji inside bold text while preserving the formatting", async () => {
    const editor = await mount("**:ta**");
    await vi.waitFor(() =>
      expect(document.querySelector('[role="option"]')?.textContent).toContain(":tada:"),
    );
    await act(async () => {
      press(editor, "Tab");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("**🎉**");
  });
  it("leaves literal answers unchanged", async () => {
    const editor = await mount(":ta", false, true);
    expect(container.querySelector('[aria-label="Choose emoji"]')).toBeNull();
    await act(async () => {
      press(editor, "Tab");
    });
    expect(commandKey).toHaveBeenCalled();
    expect(serializeEditorDoc(editor.state.doc).value).toBe(":ta");
  });
});

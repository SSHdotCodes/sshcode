// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/Users/yashsingh/p/projects/t3code/apps/server/src/orchestration-v2/ProjectionMaintenance.ts:235)";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountEditor(
  value: string,
  richTextEnabled = true,
  onChange: ComponentProps<typeof ComposerPromptEditor>["onChange"] = () => {},
) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={0}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={onChange}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  const handled = editor.view.props.handleKeyDown?.(editor.view, event);
  expect(event.defaultPrevented).toBe(Boolean(handled));
  return handled;
}

it("keeps Up before the opening bold marker in a quote, including while typing", async () => {
  const editor = await mountEditor(draft);
  const position = editor.state.selection.from;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "ArrowUp")).toBe(true);
    expect(editor.state.selection.from).toBe(position);
    editor.view.updateState(editor.state);
    const marker = editor.view.dom.querySelector(".composer-rich-marker");
    const caret = window.getSelection()?.getRangeAt(0);
    if (!marker || !caret) throw new Error("Caret or bold marker is missing");
    const markerRange = document.createRange();
    markerRange.selectNode(marker);
    expect(caret.compareBoundaryPoints(Range.START_TO_START, markerRange)).toBeLessThanOrEqual(0);
    // A repeated Up stays at the outside stop, ready for native navigation.
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**"));
});

it("keeps Down after a closing marker, including while typing", async () => {
  const editor = await mountEditor("> **bold**");
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(press(editor, "ArrowDown")).toBe(true);
    expect(press(editor, "ArrowDown")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x");
});

it("leaves vertical navigation between paragraphs to the browser", async () => {
  const editor = await mountEditor("**first**\n**second**");
  await act(async () => {
    const first = editor.state.doc.child(0);
    editor.commands.setTextSelection(first.nodeSize + 1);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.setTextSelection(first.nodeSize - 1);
    expect(press(editor, "ArrowDown")).toBe(false);
  });
});

it.each([
  { shiftKey: true },
  { altKey: true },
  { metaKey: true },
  { ctrlKey: true },
  { isComposing: true },
])("preserves modified Up behavior for %j", async (options) => {
  const editor = await mountEditor(draft);
  await act(async () => {
    expect(press(editor, "ArrowUp", options)).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  const editor = await mountEditor(draft, false);
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("keeps a controlled composer caret stable while typing a GitHub URL, then chips its separator", async () => {
  function ControlledComposer() {
    const [draft, setDraft] = useState({ value: "", cursor: 0 });
    return (
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        {...draft}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(value, cursor) => setDraft({ value, cursor })}
        onPaste={() => {}}
      />
    );
  }
  await act(async () => root.render(<ControlledComposer />));
  const editor = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!.editor;
  const url = "https://github.com/owner/repo/blob/main/src/file.ts?q=one#L1";
  for (const char of url) {
    await act(async () => editor.view.dispatch(editor.state.tr.insertText(char)));
    expect(editor.state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(editor.state.selection.from).toBe(serializeEditorDoc(editor.state.doc).value.length + 1);
  }
  await act(async () => editor.view.dispatch(editor.state.tr.insertText(" ")));
  expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("composer-github-link");
  expect(editor.state.selection.from).toBe(3);
  expect(serializeEditorDoc(editor.state.doc).value).toBe(`${url} `);
});

it("leaves a typed end-of-text GitHub URL as text when focus leaves", async () => {
  const editor = await mountEditor("");
  const url = "https://github.com/owner/repo";
  await act(async () => {
    editor.view.dispatch(editor.state.tr.insertText(url));
    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
  });
  // The composer's parse leaves it text too; a chip here would disagree with it.
  expect(editor.state.doc.firstChild?.firstChild?.isText).toBe(true);
  expect(serializeEditorDoc(editor.state.doc).value).toBe(url);
});

it("moves the caret without publishing a draft and still saves the following edit", async () => {
  const ref = scopeThreadRef(
    EnvironmentId.make("cursor-perf-test"),
    ThreadId.make("cursor-perf-test"),
  );
  const store = useComposerDraftStore.getState();
  store.setPrompt(ref, "hello");
  const notify = vi.fn();
  const unsubscribe = useComposerDraftStore.subscribe(notify);
  try {
    const editor = await mountEditor("hello", true, (value) => store.setPrompt(ref, value));
    notify.mockClear();
    const before = useComposerDraftStore.getState();
    await act(async () => {
      editor.commands.setTextSelection(2);
      editor.commands.setTextSelection(4);
      editor.commands.setTextSelection(3);
    });
    expect(editor.state.selection.from).toBe(3);
    expect(useComposerDraftStore.getState()).toBe(before);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => {
      editor.commands.insertContent("!");
    });
    expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe("he!llo");
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    store.clearComposerContent(ref);
  }
});

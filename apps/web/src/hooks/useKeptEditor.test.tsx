// @vitest-environment jsdom

import { EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Activity, StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useKeptEditor } from "./useKeptEditor";

let root: Root;
let container: HTMLDivElement;
let editors: Editor[] = [];
const updates: string[] = [];

function Composer(props: { label: string }) {
  const editor = useKeptEditor({
    extensions: [StarterKit],
    content: "<p></p>",
    onUpdate: ({ editor: updated }) => updates.push(`${props.label}:${updated.getText()}`),
  });
  editors.push(editor);
  return <EditorContent editor={editor} data-composer />;
}

const render = (hidden: boolean, label = "first", mounted = true) =>
  act(async () => {
    root.render(
      <StrictMode>
        {mounted ? (
          <Activity mode={hidden ? "hidden" : "visible"}>
            <Composer label={label} />
          </Activity>
        ) : null}
      </StrictMode>,
    );
  });

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
const kept = () => editors.at(-1)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  editors = [];
  updates.length = 0;
});

afterEach(async () => {
  await act(() => root.unmount());
  await settle();
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps one editor, its text and its undo history across an Activity hide", async () => {
  await render(false);
  await settle();
  const editor = kept();
  editor.commands.insertContent("hello");
  expect(container.querySelector("[data-composer] .ProseMirror")?.textContent).toBe("hello");

  await render(true);
  await settle();
  await render(false);
  await settle();

  expect(kept()).toBe(editor);
  expect(editor.isDestroyed).toBe(false);
  expect(container.querySelector("[data-composer] .ProseMirror")?.textContent).toBe("hello");
  editor.commands.undo();
  expect(editor.getText()).toBe("");
});

it("calls the latest render's callbacks", async () => {
  await render(false, "first");
  await render(false, "second");
  await settle();
  kept().commands.insertContent("x");
  expect(updates).toEqual(["second:x"]);
});

it("destroys the editor when its component unmounts, hidden or not", async () => {
  await render(false);
  await settle();
  const editor = kept();
  await render(true);
  await render(true, "first", false);
  await settle();
  expect(editor.isDestroyed).toBe(true);
});

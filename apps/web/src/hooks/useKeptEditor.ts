import { Editor, type EditorOptions } from "@tiptap/react";
import { useEffect, useInsertionEffect, useLayoutEffect, useState } from "react";

/** Callbacks forwarded to the latest render's options, as Tiptap's useEditor does. */
const CALLBACK_OPTIONS = [
  "onBeforeCreate",
  "onBlur",
  "onCreate",
  "onDestroy",
  "onFocus",
  "onSelectionUpdate",
  "onTransaction",
  "onUpdate",
  "onContentError",
  "onDrop",
  "onPaste",
  "onDelete",
  "onMount",
  "onUnmount",
] as const satisfies ReadonlyArray<keyof EditorOptions>;

/**
 * A Tiptap editor that lives exactly as long as its component. Tiptap's
 * useEditor destroys the editor when its effects stop, which an <Activity>
 * hide does too, so a kept chat's composer lost its undo history and was
 * rebuilt, shorter for a moment, on reveal. Insertion effects keep running
 * while hidden: the editor is mounted in one and destroyed in its cleanup.
 *
 * The view mounts in the first commit, so the first render must not read
 * `editor.view` (Tiptap throws); read it inside a function called later.
 */
export function useKeptEditor(options: Partial<EditorOptions>): Editor {
  const [{ editor, setLatest }] = useState(() => {
    // The options the callbacks forward to, kept current by the layout effect below.
    let latest = options;
    const callbacks: Partial<EditorOptions> = {};
    for (const name of CALLBACK_OPTIONS) {
      Object.assign(callbacks, {
        [name]: (...args: never[]) =>
          (latest[name] as ((...args: never[]) => void) | undefined)?.(...args),
      });
    }
    return {
      // Unmounted, so the second instance a StrictMode render discards holds no
      // view and no document listeners.
      editor: new Editor({ ...options, ...callbacks, element: null }),
      setLatest: (next: Partial<EditorOptions>) => {
        latest = next;
      },
    };
  });
  useLayoutEffect(() => {
    setLatest(options);
  });
  useInsertionEffect(() => {
    editor.mount(document.createElement("div"));
    return () => {
      // After the commit: destroying unmounts React node views, which sets state.
      queueMicrotask(() => editor.destroy());
    };
  }, [editor]);
  useEffect(() => {
    if (!sameEditorOptions(options, editor.options)) {
      editor.setOptions({ ...options, editable: editor.isEditable });
    }
  });
  return editor;
}

/** Tiptap's useEditor comparison: callbacks are forwarded, extensions compare by item. */
function sameEditorOptions(next: Partial<EditorOptions>, current: Partial<EditorOptions>) {
  return Object.entries(next).every(([key, value]) => {
    if ((CALLBACK_OPTIONS as ReadonlyArray<string>).includes(key)) return true;
    if (key === "extensions" && Array.isArray(value) && current.extensions) {
      const extensions = current.extensions;
      return (
        value.length === extensions.length &&
        value.every((extension, index) => extension === extensions[index])
      );
    }
    return value === current[key as keyof EditorOptions];
  });
}

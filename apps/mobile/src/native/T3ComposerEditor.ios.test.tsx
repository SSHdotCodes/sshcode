// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  fontScale: 1,
  readState: vi.fn(),
  props: {} as Record<string, any>,
  flatten(style: any): Record<string, any> {
    return Array.isArray(style)
      ? Object.assign({}, ...style.map((entry) => harness.flatten(entry)))
      : (style ?? {});
  },
}));
vi.mock("expo", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    requireNativeView: () => (props: Record<string, any>) => {
      useImperativeHandle(props.ref, () => ({ readState: harness.readState }));
      harness.props = props;
      return null;
    },
  };
});
vi.mock("react-native", () => ({
  StyleSheet: { flatten: harness.flatten },
  useWindowDimensions: () => ({ fontScale: harness.fontScale }),
}));
vi.mock("../lib/markdownFileIcons", () => ({
  markdownFileIconSource: vi.fn(),
  markdownIconAssetUri: vi.fn(),
}));
vi.mock("../lib/markdownLinks", () => ({ resolveMarkdownFileIcon: vi.fn() }));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../lib/nativeComposerTheme", () => ({ createNativeComposerTheme: () => ({}) }));
vi.mock("../lib/useFontFamily", () => ({ useFontFamily: () => "DMSans-Regular" }));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));

import { ComposerEditor } from "./T3ComposerEditor.ios";

let root: Root;
const onChangeText = vi.fn();
function render(style = { minHeight: 72, maxHeight: 160 }) {
  act(() =>
    root.render(<ComposerEditor value="draft" onChangeText={onChangeText} style={style} />),
  );
}
function resize(height: number) {
  act(() => harness.props.onComposerContentSizeChange({ nativeEvent: { width: 300, height } }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.fontScale = 1;
  harness.readState.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("iOS native composer sizing", () => {
  it("uses native measurements to grow, cap, and shrink the actual editor", () => {
    render();
    expect(harness.flatten(harness.props.style).height).toBe(72);
    resize(110);
    expect(harness.flatten(harness.props.style).height).toBe(110);
    resize(400);
    expect(harness.flatten(harness.props.style).height).toBe(160);
    resize(22);
    expect(harness.flatten(harness.props.style).height).toBe(72);
  });

  it("updates the custom UIKit font and line height when the iOS text size changes", () => {
    render();
    expect(harness.props.fontSize).toBe(16);
    harness.fontScale = 2;
    render();
    expect(harness.props.fontSize).toBe(32);
    expect(harness.props.lineHeight).toBe(44);
  });
});

describe("iOS native composer clear after send", () => {
  function mountControlled({ follows = true } = {}) {
    const changes: string[] = [];
    let setValue: (value: string) => void = () => {};
    function Parent() {
      const [value, set] = useState("");
      setValue = set;
      return (
        <ComposerEditor
          value={value}
          onChangeText={(next) => {
            changes.push(next);
            if (follows) set(next);
          }}
        />
      );
    }
    act(() => root.render(<Parent />));
    const native = (eventCount: number, value: string, resetSequence?: number, resetAck = false) =>
      act(() =>
        harness.props.onComposerChange({
          nativeEvent: {
            eventCount,
            value,
            selection: { start: value.length, end: value.length },
            ...(resetSequence === undefined ? {} : { resetSequence }),
            ...(resetAck ? { resetAck } : {}),
          },
        }),
      );
    const document = () => JSON.parse(harness.props.controlledDocumentJson);
    return {
      changes,
      native,
      document,
      clear: () => act(() => setValue("")),
      restore: (value: string) => act(() => setValue(value)),
    };
  }

  it("wins over an autocorrection iOS commits while the clear is on its way", () => {
    const composer = mountControlled();
    composer.native(1, "so i can use if", 0);
    // The app sends the draft and clears it.
    composer.clear();
    expect(composer.document()).toMatchObject({ value: "", resetSequence: 1 });
    // The keyboard commits its pending "if" -> "it" before the clear lands.
    composer.native(2, "so i can use it", 0);
    expect(composer.changes).toEqual(["so i can use if"]);
    expect(composer.document().value).toBe("");
    // The editor applied the clear and confirms it; typing after that counts again.
    composer.native(3, "", 1, true);
    expect(composer.document()).toMatchObject({ value: "", mostRecentEventCount: 3 });
    composer.native(4, "n", 1);
    expect(composer.changes).toEqual(["so i can use if", "n"]);
  });

  it("keeps a draft the parent restores before the editor confirms the clear", () => {
    const composer = mountControlled();
    composer.native(1, "hello", 0);
    composer.clear();
    expect(composer.document().resetSequence).toBe(1);
    // The send failed and the app put the message back before the confirmation arrived.
    composer.restore("hello");
    composer.native(2, "", 1, true);
    expect(composer.changes).toEqual(["hello"]);
    // Re-sent at the confirmed revision, so the editor applies it.
    expect(composer.document()).toMatchObject({
      value: "hello",
      mostRecentEventCount: 2,
      resetSequence: 1,
    });
  });

  it("gives each reset its own window for dropping earlier events", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const composer = mountControlled();
      composer.native(1, "a", 0);
      composer.clear();
      composer.native(2, "ab", 0); // dropped; starts reset 1's window
      now.mockReturnValue(5_000);
      composer.restore("b");
      composer.clear(); // reset 2, while reset 1 was never confirmed
      composer.native(3, "abc", 1);
      expect(composer.changes).toEqual(["a"]);
    } finally {
      now.mockRestore();
    }
  });

  it("never resets when the parent lags the first keystroke", () => {
    const composer = mountControlled({ follows: false });
    composer.native(1, "a", 0);
    expect(composer.document().resetSequence).toBe(0);
  });

  it("treats the user deleting everything as typing, not a reset", () => {
    const composer = mountControlled();
    composer.native(1, "abc", 0);
    composer.native(2, "", 0);
    expect(composer.document().resetSequence).toBe(0);
    composer.native(3, "x", 0);
    expect(composer.changes).toEqual(["abc", "", "x"]);
  });
});

it("drops old typing synchronously when an already-empty draft is sent or discarded", () => {
  let generation = 0;
  const changes = vi.fn();
  const render = () =>
    act(() =>
      root.render(
        <ComposerEditor value="" readResetGeneration={() => generation} onChangeText={changes} />,
      ),
    );
  render();
  const staleChange = harness.props.onComposerChange;
  generation++;
  act(() =>
    staleChange({
      nativeEvent: {
        value: "late",
        eventCount: 1,
        resetSequence: 0,
        selection: { start: 4, end: 4 },
      },
    }),
  );
  expect(changes).not.toHaveBeenCalled();
  render();
  const reset = JSON.parse(harness.props.controlledDocumentJson).resetSequence;
  expect(reset).toBe(1);
  act(() =>
    harness.props.onComposerChange({
      nativeEvent: {
        value: "",
        eventCount: 2,
        resetSequence: reset,
        resetAck: true,
        selection: { start: 0, end: 0 },
      },
    }),
  );
  act(() =>
    harness.props.onComposerChange({
      nativeEvent: {
        value: "new",
        eventCount: 3,
        resetSequence: reset,
        selection: { start: 3, end: 3 },
      },
    }),
  );
  expect(changes).toHaveBeenCalledExactlyOnceWith("new");
});

it("flushes final native text but never acknowledges past an undelivered paste", async () => {
  const ref = createRef<import("./T3ComposerEditor.types").ComposerEditorHandle>();
  const changes = vi.fn();
  act(() => root.render(<ComposerEditor ref={ref} value="teh" onChangeText={changes} />));
  harness.readState.mockResolvedValue({
    value: "the",
    eventCount: 1,
    resetSequence: 0,
    pasteEventCount: 0,
    selection: { start: 3, end: 3 },
  });
  await act(() => ref.current!.flushPendingInput());
  expect(changes).toHaveBeenCalledWith("the");
  changes.mockClear();
  harness.readState.mockResolvedValue({
    value: "paste target",
    eventCount: 3,
    resetSequence: 0,
    pasteEventCount: 2,
    selection: { start: 12, end: 12 },
  });
  await act(() => ref.current!.flushPendingInput());
  expect(changes).not.toHaveBeenCalled();
});

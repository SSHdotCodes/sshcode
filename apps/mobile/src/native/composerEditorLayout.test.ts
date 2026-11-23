import { describe, expect, it } from "vite-plus/test";

import { composerEditorHeight } from "./composerEditorLayout";

const expanded = {
  lineHeight: 22,
  contentInsetVertical: 0,
  style: { minHeight: 72, maxHeight: 160 },
};

describe("native composer height", () => {
  it("grows from the minimum, caps long drafts, and shrinks after deleting text", () => {
    expect(
      [22, 96.2, 240, 22].map((contentHeight) =>
        composerEditorHeight({ ...expanded, contentHeight }),
      ),
    ).toEqual([72, 97, 160, 72]);
  });

  it("keeps the collapsed pill one line tall even with a long draft", () => {
    expect(
      composerEditorHeight({
        ...expanded,
        contentHeight: 240,
        contentInsetVertical: 6,
        style: { height: 36 },
      }),
    ).toBe(36);
  });

  it("makes room for the iOS text size setting in a collapsed composer", () => {
    expect(
      composerEditorHeight({
        contentHeight: 100,
        lineHeight: 44,
        contentInsetVertical: 6,
        style: { height: 36 },
      }),
    ).toBe(56);
  });

  it("ignores invalid native measurements and preserves percentage heights", () => {
    expect(composerEditorHeight({ ...expanded, contentHeight: NaN })).toBe(72);
    expect(
      composerEditorHeight({ ...expanded, contentHeight: 100, style: { height: "100%" } }),
    ).toBeUndefined();
  });
});

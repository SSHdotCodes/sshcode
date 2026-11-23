import { describe, expect, it } from "vite-plus/test";

import { keepAwakeWanted } from "./keepAwake.logic.ts";

describe("keepAwakeWanted", () => {
  it("never holds the computer awake while the setting is off", () => {
    expect(keepAwakeWanted(null, false)).toBe(false);
    expect(keepAwakeWanted(null, true)).toBe(false);
  });

  it("holds it awake for a running turn, on battery too", () => {
    expect(keepAwakeWanted({ working: true, waiting: false }, true)).toBe(true);
    expect(keepAwakeWanted({ working: true, waiting: true }, false)).toBe(true);
  });

  it("holds it awake for background work only on mains power", () => {
    expect(keepAwakeWanted({ working: false, waiting: true }, false)).toBe(true);
    expect(keepAwakeWanted({ working: false, waiting: true }, true)).toBe(false);
  });

  it("lets it sleep when nothing is in flight", () => {
    expect(keepAwakeWanted({ working: false, waiting: false }, false)).toBe(false);
  });
});

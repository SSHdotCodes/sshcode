import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlLayout } from "./composerControlLayout";
import { scaledTypographyLineHeight } from "./appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "./typography";

describe("composer control text layout", () => {
  it("keeps the ordinary composer compact and its touch target at least 44pt", () => {
    expect(resolveComposerControlLayout(16, 1)).toEqual({ labelLines: 1, minHeight: 44 });
    expect(resolveComposerControlLayout(11, 0.8).minHeight).toBe(44);
  });

  it("allows two lines for either larger system text or the app's largest text size", () => {
    expect(resolveComposerControlLayout(16, 1.5).labelLines).toBe(2);
    expect(resolveComposerControlLayout(22, 1).labelLines).toBe(2);
    expect(resolveComposerControlLayout(16, 1.2).labelLines).toBe(1);
  });

  it("accounts for the combination of app size and Dynamic Type", () => {
    expect(resolveComposerControlLayout(18, 1.2).labelLines).toBe(2);
    expect(resolveComposerControlLayout(18, 1).labelLines).toBe(1);
    expect(resolveComposerControlLayout(16, 1.2).labelLines).toBe(1);
  });

  it.each([11, 16, 18, 22])(
    "fits a scaled text line plus vertical padding at base size %i",
    (base) => {
      let previousHeight = 0;
      for (const scale of [0.8, 1, 1.2, 1.5, 2, 2.5, 3.2]) {
        const layout = resolveComposerControlLayout(base, scale);
        const renderedLineHeight =
          scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.footnote, base) * scale;
        expect(layout.minHeight).toBeGreaterThanOrEqual(renderedLineHeight + 16);
        expect(layout.minHeight).toBeGreaterThanOrEqual(44);
        expect(layout.minHeight).toBeGreaterThanOrEqual(previousHeight);
        previousHeight = layout.minHeight;
      }
    },
  );

  it.each([NaN, Infinity, -1, 0])("uses a safe system scale for %s", (scale) => {
    expect(resolveComposerControlLayout(16, scale)).toEqual(resolveComposerControlLayout(16, 1));
  });
});

import {
  DEFAULT_BASE_FONT_SIZE,
  normalizeBaseFontSize,
  scaledTypographyLineHeight,
} from "./appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "./typography";

/** Match the text's app-size and system-size scaling while preserving a 44pt touch target. */
export function resolveComposerControlLayout(baseFontSize: number, systemFontScale: number) {
  const fontScale = Number.isFinite(systemFontScale) && systemFontScale > 0 ? systemFontScale : 1;
  const baseSize = normalizeBaseFontSize(baseFontSize);
  const effectiveScale = (baseSize / DEFAULT_BASE_FONT_SIZE) * fontScale;
  const lineHeight = scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.footnote, baseSize) * fontScale;
  return {
    labelLines: effectiveScale >= 1.3 ? 2 : 1,
    minHeight: Math.max(44, Math.ceil(lineHeight + 16)),
  };
}

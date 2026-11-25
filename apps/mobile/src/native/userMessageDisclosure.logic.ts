import { hasWideMarkdownBlock } from "../lib/wideMarkdownBlocks";

export const USER_MESSAGE_THRESHOLD_LINES = 14;
export const USER_MESSAGE_FOLDED_LINES = 10;

export function canFoldUserMessage(naturalHeight: number, thresholdHeight: number): boolean {
  // Native shadow layout and onLayout can round to different device pixels.
  return thresholdHeight > 0 && naturalHeight - thresholdHeight > 1;
}

/** The native line clamp applies to selectable text, while rich GFM blocks use separate views. */
export function canMeasureUserMessageLines(markdown: string): boolean {
  return (
    markdown.length > USER_MESSAGE_THRESHOLD_LINES &&
    !/!\[|^\s*>\s*\[!|^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/m.test(markdown) &&
    !hasWideMarkdownBlock(markdown, { includeOrderedLists: false })
  );
}

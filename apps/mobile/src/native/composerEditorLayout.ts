/** Fit the native editor to its contents while keeping long drafts scrollable. */
export function composerEditorHeight(input: {
  readonly contentHeight: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly style: {
    readonly height?: unknown;
    readonly minHeight?: unknown;
    readonly maxHeight?: unknown;
  };
}): number | undefined {
  const { style } = input;
  const singleLineHeight = Math.ceil(input.lineHeight + input.contentInsetVertical * 2);
  if (typeof style.height === "number") return Math.max(style.height, singleLineHeight);
  if (style.height !== undefined) return undefined;
  const minimum = Math.max(
    typeof style.minHeight === "number" ? style.minHeight : 0,
    singleLineHeight,
  );
  const maximum = typeof style.maxHeight === "number" ? style.maxHeight : Infinity;
  const content = Number.isFinite(input.contentHeight) ? Math.ceil(input.contentHeight) : minimum;
  return Math.max(minimum, Math.min(content, maximum));
}

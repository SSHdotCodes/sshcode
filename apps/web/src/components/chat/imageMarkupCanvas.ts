import {
  MARKUP_TEXT_WEIGHT,
  markupPath,
  markupTextHalo,
  markupTextLayout,
  type MarkupItem,
} from "@t3tools/client-runtime/image-markup";

export const MARKUP_FONT_FAMILY = "system-ui, sans-serif";

export function drawMarkup(
  context: CanvasRenderingContext2D,
  items: readonly MarkupItem[],
  width: number,
  height: number,
) {
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const item of items) {
    if (item.tool === "text") {
      const { x, y, fontSize } = markupTextLayout(item, width, height);
      context.font = `${MARKUP_TEXT_WEIGHT} ${fontSize}px ${MARKUP_FONT_FAMILY}`;
      context.direction = "ltr";
      context.textBaseline = "alphabetic";
      context.textAlign = "left";
      const alpha = context.globalAlpha;
      for (const layer of markupTextHalo(item.color, fontSize)) {
        context.globalAlpha = alpha * layer.opacity;
        context.strokeStyle = layer.color;
        context.lineWidth = layer.width;
        context.strokeText(item.content, x, y + layer.offset);
      }
      context.globalAlpha = alpha;
      context.fillStyle = item.color;
      context.fillText(item.content, x, y);
    } else {
      context.strokeStyle = item.color;
      context.lineWidth = item.width * Math.min(width, height);
      context.stroke(new Path2D(markupPath(item, width, height)));
    }
  }
}

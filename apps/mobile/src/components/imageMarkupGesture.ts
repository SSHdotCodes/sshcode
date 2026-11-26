import type { Dispatch, SetStateAction } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  appendMarkupStroke,
  changeMarkupText,
  fitMarkupLoop,
  imagePoint,
  MARKUP_TEXT_SIZES,
  MARKUP_WIDTHS,
  markupTextLayout,
  type MarkupHistory,
  type MarkupItem,
  type MarkupPoint,
  type MarkupShape,
  type MarkupText,
  type MarkupTool,
} from "@t3tools/client-runtime/image-markup";
import { uuidv4 } from "../lib/uuid";

type MarkupDrag = { shape: MarkupShape } | { text: MarkupText; position: MarkupPoint };

export function createMarkupInteraction() {
  let active: MarkupDrag | null = null;
  let draft: MarkupText | null = null;
  const widths = new Map<string, number>();
  return {
    getActiveDrag: () => active,
    setActiveDrag: (drag: MarkupDrag | null) => {
      active = drag;
    },
    getTextDraft: () => draft,
    setTextDraft: (text: MarkupText | null) => {
      draft = text;
    },
    getLabelWidth: (id: string) => widths.get(id),
    setLabelWidth: (id: string, width: number) => {
      widths.set(id, width);
    },
  };
}

export function createMarkupGesture({
  color,
  enabled,
  items,
  setDrawing,
  setHistory,
  setSelected,
  setSnapped,
  size,
  startEditing,
  state,
  tool,
  viewHeight,
  viewWidth,
}: {
  color: string;
  enabled: boolean;
  items: readonly MarkupItem[];
  setDrawing: (item: MarkupItem | null) => void;
  setHistory: Dispatch<SetStateAction<MarkupHistory>>;
  setSelected: (id: string | null) => void;
  setSnapped: (shape: MarkupShape | null) => void;
  size: number;
  startEditing: (text: MarkupText) => void;
  state: ReturnType<typeof createMarkupInteraction>;
  tool: MarkupTool;
  viewHeight: number;
  viewWidth: number;
}) {
  const { getActiveDrag, getLabelWidth, setActiveDrag } = state;
  let lastTap: { id: string; time: number } | null = null;
  const textAt = (x: number, y: number) => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.tool !== "text") continue;
      const layout = markupTextLayout(item, viewWidth, viewHeight);
      const labelWidth = getLabelWidth(item.id) ?? layout.fontSize * item.content.length * 0.55;
      const padding = 7;
      if (
        x >= layout.x - padding &&
        x <= layout.x + labelWidth + padding &&
        y >= layout.y - layout.fontSize - padding &&
        y <= layout.y + padding
      )
        return item;
    }
  };
  const pan = Gesture.Pan()
    .minDistance(tool === "text" ? 3 : 0)
    .maxPointers(1)
    .enabled(enabled)
    .runOnJS(true)
    .onStart((event) => {
      setSnapped(null);
      const startX = event.x - event.translationX;
      const startY = event.y - event.translationY;
      if (tool === "text") {
        lastTap = null;
        const text = textAt(startX, startY);
        if (text) {
          setSelected(text.id);
          setActiveDrag({ text, position: text.point });
        }
        return;
      }
      const shape = {
        tool,
        id: uuidv4(),
        color,
        width: MARKUP_WIDTHS[size]!,
        points: [imagePoint(startX, startY, viewWidth, viewHeight)],
      };
      setActiveDrag({ shape });
      setDrawing(shape);
    })
    .onUpdate((event) => {
      const current = getActiveDrag();
      if (!current) return;
      if ("text" in current) {
        const position = imagePoint(
          current.text.point.x * viewWidth + event.translationX,
          current.text.point.y * viewHeight + event.translationY,
          viewWidth,
          viewHeight,
        );
        setActiveDrag({ ...current, position });
        setDrawing({ ...current.text, point: position });
        return;
      }
      const next = imagePoint(event.x, event.y, viewWidth, viewHeight);
      const shape = {
        ...current.shape,
        points:
          current.shape.tool === "pen"
            ? [...current.shape.points, next]
            : [current.shape.points[0]!, next],
      };
      setActiveDrag({ shape });
      setDrawing(shape);
    })
    .onFinalize((_, success) => {
      const current = getActiveDrag();
      if (success && current) {
        if ("text" in current) {
          setHistory((value) =>
            changeMarkupText(value, { ...current.text, point: current.position }),
          );
        } else {
          const fit = fitMarkupLoop(current.shape);
          setHistory((value) => appendMarkupStroke(value, current.shape, fit));
          if (fit !== current.shape) setSnapped(fit);
        }
      }
      setActiveDrag(null);
      setDrawing(null);
    });
  if (tool !== "text") return pan;
  const tap = Gesture.Tap()
    .enabled(enabled)
    .runOnJS(true)
    .onEnd((event, success) => {
      if (!success) return;
      setSnapped(null);
      const text = textAt(event.x, event.y);
      if (text) {
        setSelected(text.id);
        const time = performance.now();
        const previous = lastTap;
        if (previous?.id === text.id && time - previous.time < 330) {
          lastTap = null;
          startEditing(text);
        } else {
          lastTap = { id: text.id, time };
        }
      } else {
        lastTap = null;
        setSelected(null);
        startEditing({
          tool,
          id: uuidv4(),
          point: imagePoint(event.x, event.y, viewWidth, viewHeight),
          color,
          size: MARKUP_TEXT_SIZES[size]! / Math.max(viewWidth, 1),
          content: "",
        });
      }
    });
  return Gesture.Race(pan, tap);
}

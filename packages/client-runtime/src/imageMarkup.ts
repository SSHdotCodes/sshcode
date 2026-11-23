export type MarkupTool = "ellipse" | "rectangle" | "arrow" | "pen";
export interface MarkupPoint {
  x: number;
  y: number;
}
export interface MarkupShape {
  tool: MarkupTool;
  points: readonly MarkupPoint[];
  color: string;
  /** Fraction of the image's shorter edge. */
  width: number;
}
export const MARKUP_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff", "#000000"];
export const MARKUP_WIDTHS = [0.004, 0.008, 0.014];
export const MARKUP_TOOLS: readonly MarkupTool[] = ["ellipse", "rectangle", "arrow", "pen"];

/** Coordinates are relative to the fitted image, excluding its letterbox. */
export function imagePoint(x: number, y: number, width: number, height: number): MarkupPoint {
  return {
    x: Math.max(0, Math.min(1, x / Math.max(1, width))),
    y: Math.max(0, Math.min(1, y / Math.max(1, height))),
  };
}

export function shapeBounds(points: readonly MarkupPoint[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Closed loops must follow an ellipse, cover all quadrants and make one turn. */
export function loopToEllipse(shape: MarkupShape): MarkupShape {
  if (shape.tool !== "pen" || shape.points.length < 12) return shape;
  const bounds = shapeBounds(shape.points);
  if (bounds.width < 0.025 || bounds.height < 0.025) return shape;
  const first = shape.points[0]!;
  const last = shape.points.at(-1)!;
  if (Math.hypot((first.x - last.x) / bounds.width, (first.y - last.y) / bounds.height) > 0.25)
    return shape;
  let error = 0;
  let travel = 0;
  let previousAngle: number | undefined;
  const quadrants = new Set<number>();
  for (const point of shape.points) {
    const x = ((point.x - bounds.x) / bounds.width - 0.5) * 2;
    const y = ((point.y - bounds.y) / bounds.height - 0.5) * 2;
    error += Math.abs(Math.hypot(x, y) - 1);
    const angle = Math.atan2(y, x);
    quadrants.add((x >= 0 ? 1 : 0) + (y >= 0 ? 2 : 0));
    if (previousAngle !== undefined) {
      const delta = angle - previousAngle;
      travel += Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
    }
    previousAngle = angle;
  }
  if (error / shape.points.length > 0.16 || quadrants.size !== 4 || travel < 5 || travel > 8)
    return shape;
  return {
    ...shape,
    tool: "ellipse",
    points: [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ],
  };
}

/** One SVG path is shared by the native preview and the browser's canvas export. */
export function markupPath(shape: MarkupShape, width: number, height: number): string {
  const points = shape.points.map((point) => ({ x: point.x * width, y: point.y * height }));
  const first = points[0];
  if (!first) return "";
  const last = points.at(-1)!;
  if (shape.tool === "pen")
    return `M ${first.x} ${first.y} ${
      points.length === 1
        ? `l 0.01 0`
        : points
            .slice(1)
            .map((p) => `L ${p.x} ${p.y}`)
            .join(" ")
    }`;
  const b = shapeBounds(points);
  if (shape.tool === "rectangle")
    return `M ${b.x} ${b.y} h ${b.width} v ${b.height} h ${-b.width} Z`;
  if (shape.tool === "ellipse") {
    if (b.width === 0 || b.height === 0) return "";
    return `M ${b.x} ${b.y + b.height / 2} a ${b.width / 2} ${b.height / 2} 0 1 0 ${b.width} 0 a ${b.width / 2} ${b.height / 2} 0 1 0 ${-b.width} 0`;
  }
  const angle = Math.atan2(last.y - first.y, last.x - first.x);
  const head = Math.min(
    Math.hypot(last.x - first.x, last.y - first.y) / 2,
    shape.width * Math.min(width, height) * 5,
  );
  const wing = (offset: number) =>
    `${last.x - head * Math.cos(angle + offset)} ${last.y - head * Math.sin(angle + offset)}`;
  return `M ${first.x} ${first.y} L ${last.x} ${last.y} M ${wing(-0.55)} L ${last.x} ${last.y} L ${wing(0.55)}`;
}

export interface MarkupHistory {
  past: readonly (readonly MarkupShape[])[];
  present: readonly MarkupShape[];
  future: readonly (readonly MarkupShape[])[];
}
export const EMPTY_MARKUP_HISTORY: MarkupHistory = { past: [], present: [], future: [] };
export function changeMarkup(
  history: MarkupHistory,
  present: readonly MarkupShape[],
): MarkupHistory {
  return { past: [...history.past, history.present], present, future: [] };
}
export function undoMarkup(history: MarkupHistory): MarkupHistory {
  const present = history.past.at(-1);
  return present
    ? { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] }
    : history;
}
export function redoMarkup(history: MarkupHistory): MarkupHistory {
  const present = history.future[0];
  return present
    ? { past: [...history.past, history.present], present, future: history.future.slice(1) }
    : history;
}
export function markupName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || "image"}-marked.png`;
}

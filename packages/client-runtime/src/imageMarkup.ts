export type MarkupTool = MarkupShape["tool"] | "text";
export interface MarkupPoint {
  x: number;
  y: number;
}
export interface MarkupShape {
  tool: "ellipse" | "rectangle" | "arrow" | "pen";
  id: string;
  points: readonly MarkupPoint[];
  color: string;
  /** Fraction of the image's shorter edge. */
  width: number;
}
export interface MarkupText {
  tool: "text";
  id: string;
  point: MarkupPoint;
  color: string;
  /** Fraction of the image's width at placement. */
  size: number;
  content: string;
}
export type MarkupItem = MarkupShape | MarkupText;
export const MARKUP_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff", "#000000"];
export const MARKUP_WIDTHS = [0.004, 0.008, 0.014];
export const MARKUP_TEXT_SIZES = [14, 18, 24];
export const MARKUP_TEXT_WEIGHT = 600;
export const MARKUP_SNAP_DURATION_MS = 3000;
export const MARKUP_TOOLS: readonly MarkupTool[] = ["ellipse", "rectangle", "arrow", "pen", "text"];

/** Coordinates are relative to the fitted image, excluding its letterbox. */
export function imagePoint(x: number, y: number, width: number, height: number): MarkupPoint {
  return {
    x: Math.max(0, Math.min(1, x / Math.max(1, width))),
    y: Math.max(0, Math.min(1, y / Math.max(1, height))),
  };
}

export function shapeBounds(points: readonly MarkupPoint[]) {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    x = Math.min(x, point.x);
    y = Math.min(y, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

function fitEllipseAxes(
  samples: readonly { x: number; y: number; weight: number }[],
  initial?: MarkupPoint,
) {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let sumX = 0;
  let sumY = 0;
  for (const { x, y, weight } of samples) {
    const residual = initial ? Math.hypot(x * initial.x, y * initial.y) - 1 : 0;
    const fitWeight = weight / (1 + (residual / 0.12) ** 4);
    const x2 = x * x;
    const y2 = y * y;
    xx += fitWeight * x2 * x2;
    xy += fitWeight * x2 * y2;
    yy += fitWeight * y2 * y2;
    sumX += fitWeight * x2;
    sumY += fitWeight * y2;
  }
  const determinant = xx * yy - xy * xy;
  if (determinant <= 0) return undefined;
  // Keep the fitted radii inside the stroke's extent.
  return {
    x: Math.sqrt(Math.max(1, (sumX * yy - sumY * xy) / determinant)),
    y: Math.sqrt(Math.max(1, (sumY * xx - sumX * xy) / determinant)),
  };
}

/** Fits a closed, single-turn stroke around its original center. */
export function fitMarkupLoop(shape: MarkupShape): MarkupShape {
  if (shape.tool !== "pen" || shape.points.length < 12) return shape;
  const bounds = shapeBounds(shape.points);
  if (bounds.width < 0.025 || bounds.height < 0.025) return shape;
  const first = shape.points[0]!;
  const last = shape.points.at(-1)!;
  if (Math.hypot((first.x - last.x) / bounds.width, (first.y - last.y) / bounds.height) > 0.25)
    return shape;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rx = bounds.width / 2;
  const ry = bounds.height / 2;
  const samples = shape.points.map((point) => {
    const x = (point.x - cx) / rx;
    const y = (point.y - cy) / ry;
    return { x, y, angle: Math.atan2(y, x) };
  });
  const angleDistance = (a: number, b: number) => {
    const delta = a - b;
    return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
  };
  let travel = 0;
  const quadrants = new Set<number>();
  for (const [index, { x, y, angle }] of samples.entries()) {
    quadrants.add((x >= 0 ? 1 : 0) + (y >= 0 ? 2 : 0));
    if (index > 0) travel += angleDistance(angle, samples[index - 1]!.angle);
  }
  if (quadrants.size !== 4 || travel < 5 || travel > 8) return shape;

  // Weight by angle so pausing at one point does not pull the fit.
  const weighted = samples.map(({ x, y, angle }, index) => {
    const previous = samples[index - 1] ?? samples.at(-1)!;
    const next = samples[index + 1] ?? samples[0]!;
    const weight = (angleDistance(angle, previous.angle) + angleDistance(angle, next.angle)) / 2;
    return { x, y, weight };
  });
  // Solve a*x² + b*y² ≈ 1, then refit with less influence from brief excursions.
  const initial = fitEllipseAxes(weighted);
  if (!initial) return shape;
  const axes = fitEllipseAxes(weighted, initial) ?? initial;
  let ellipseError = 0;
  let rectangleError = 0;
  let totalWeight = 0;
  for (const { x, y, weight } of weighted) {
    ellipseError += weight * Math.abs(Math.hypot(x * axes.x, y * axes.y) - 1);
    rectangleError += weight * Math.abs(1 - Math.max(Math.abs(x), Math.abs(y)));
    totalWeight += weight;
  }
  const rectangle = rectangleError < ellipseError;
  if (Math.min(ellipseError, rectangleError) / totalWeight > 0.16) return shape;
  const fittedX = rectangle ? rx : rx / axes.x;
  const fittedY = rectangle ? ry : ry / axes.y;
  return {
    ...shape,
    tool: rectangle ? "rectangle" : "ellipse",
    points: [
      { x: cx - fittedX, y: cy - fittedY },
      { x: cx + fittedX, y: cy + fittedY },
    ],
  };
}

/** Shared image-space placement for the preview and PNG, using an alphabetic baseline. */
export function markupTextLayout(text: MarkupText, width: number, height: number) {
  const fontSize = text.size * width;
  return {
    x: text.point.x * width,
    y: text.point.y * height + fontSize,
    fontSize,
  };
}

/** Feather the shadow in thin bands so the native SVG export can draw it without a full-image filter. */
export function markupTextHalo(color: string, fontSize: number) {
  const rgb = Number.parseInt(color.slice(1), 16);
  const brightness = 299 * (rgb >> 16) + 587 * ((rgb >> 8) & 255) + 114 * (rgb & 255);
  const scale = fontSize / MARKUP_TEXT_SIZES[1]!;
  const shadow = "#1b2233";
  const offset = 0.5 * scale;
  return [
    { color: shadow, width: 5 * scale, offset, opacity: 0.035 },
    { color: shadow, width: 4 * scale, offset, opacity: 0.055 },
    { color: shadow, width: 3 * scale, offset, opacity: 0.075 },
    {
      color: brightness >= 165_000 ? shadow : "#fff9f2",
      width: 2 * scale,
      offset: 0,
      opacity: 0.55,
    },
  ];
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
  past: readonly (readonly MarkupItem[])[];
  present: readonly MarkupItem[];
  future: readonly (readonly MarkupItem[])[];
}
export const EMPTY_MARKUP_HISTORY: MarkupHistory = { past: [], present: [], future: [] };
export function changeMarkup(
  history: MarkupHistory,
  present: readonly MarkupItem[],
): MarkupHistory {
  return { past: [...history.past, history.present], present, future: [] };
}
export function appendMarkupStroke(history: MarkupHistory, stroke: MarkupShape, fit: MarkupShape) {
  const drawn = changeMarkup(history, [...history.present, stroke]);
  return fit === stroke ? drawn : changeMarkup(drawn, [...history.present, fit]);
}

export function changeMarkupText(history: MarkupHistory, text: MarkupText) {
  const index = history.present.findIndex((item) => item.tool === "text" && item.id === text.id);
  const content = text.content.trim();
  if (index < 0)
    return content ? changeMarkup(history, [...history.present, { ...text, content }]) : history;
  if (!content)
    return changeMarkup(
      history,
      history.present.filter((_, i) => i !== index),
    );
  const original = history.present[index] as MarkupText;
  if (
    content === original.content &&
    text.point.x === original.point.x &&
    text.point.y === original.point.y
  )
    return history;
  return changeMarkup(
    history,
    history.present.map((item, i) => (i === index ? { ...text, content } : item)),
  );
}
export function previewMarkup(present: readonly MarkupItem[], draft: MarkupItem | null) {
  if (!draft) return present;
  if (draft.tool === "text" && present.some((item) => item.id === draft.id)) {
    return present.map((item) => (item.id === draft.id ? draft : item));
  }
  return [...present, draft];
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

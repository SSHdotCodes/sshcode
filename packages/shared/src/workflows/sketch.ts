import {
  ProviderInstanceId,
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowAgentNode,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowMark,
  type WorkflowMarkColor,
  type WorkflowNode,
  type WorkflowStrokeMark,
  type WorkflowTextMark,
} from "@t3tools/contracts";

export * from "./roughShapes.ts";

/** Marker line widths and text sizes for drawn marks, in canvas units. */
export const MARK_WEIGHTS: Readonly<Record<WorkflowStrokeMark["weight"], number>> = {
  thin: 2.5,
  bold: 5,
  extra: 10,
};
export const MARK_TEXT_SIZES: Readonly<Record<WorkflowTextMark["size"], number>> = {
  s: 20,
  m: 28,
  l: 40,
  xl: 60,
};
/** Mark colors where the web theme's colors don't reach (the phone); ink follows the theme. */
export const MARK_HEX: Readonly<Record<Exclude<WorkflowMarkColor, "ink">, string>> = {
  red: "#d9363e",
  green: "#2f9d5c",
  blue: "#2f6fdb",
  orange: "#e48a1c",
};

/** A smooth path through freehand points (flat x,y pairs): curves through the midpoints. */
export function markStrokePath(points: ReadonlyArray<number>): string {
  const r = (value: number) => Math.round(value * 10) / 10;
  if (points.length < 4) {
    const [x = 0, y = 0] = points;
    return `M${r(x)} ${r(y)}l0.01 0`;
  }
  let d = `M${r(points[0]!)} ${r(points[1]!)}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    d += `Q${r(x)} ${r(y)} ${r((x + points[i + 2]!) / 2)} ${r((y + points[i + 3]!) / 2)}`;
  }
  return `${d}L${r(points[points.length - 2]!)} ${r(points[points.length - 1]!)}`;
}

/** A mark's rough box for fitting views; text width is estimated from glyph widths. */
export function markBox(mark: WorkflowMark): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (mark.kind === "stroke") return { x: mark.x, y: mark.y, ...markStrokeSize(mark) };
  const size = MARK_TEXT_SIZES[mark.size];
  const lines = mark.text.split("\n");
  const longest = Math.max(1, ...lines.map((line) => line.length));
  return {
    x: mark.x,
    y: mark.y,
    width: longest * size * SKETCH_HAND_GLYPH + 8,
    height: lines.length * size * 1.2 + 4,
  };
}

/** A stroke's box: its points are relative to `x`,`y`, padded by its width. */
export function markStrokeSize(mark: WorkflowStrokeMark): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (let i = 0; i < mark.points.length; i += 2) {
    width = Math.max(width, mark.points[i]!);
    height = Math.max(height, mark.points[i + 1]!);
  }
  const pad = MARK_WEIGHTS[mark.weight];
  return { width: Math.max(24, width + pad), height: Math.max(24, height + pad) };
}

/** Rough average glyph widths, in font units, for wrapping without measuring text. */
export const SKETCH_HAND_GLYPH = 0.48;
export const SKETCH_SANS_GLYPH = 0.56;
export const SKETCH_TITLE_SIZE = 34;
export const SKETCH_MODEL_SIZE = 21;

/** Brand tint for a box's model dot, by driver; others stay neutral. */
export const SKETCH_MODEL_DOT: Partial<Record<string, string>> = {
  claudeAgent: "#d97757",
  codex: "#10a37f",
  antigravity: "#4285f4",
};

/** Word-wrap into at most `maxLines` lines of `maxChars`, ending with "…" when cut. */
export function wrapPreviewText(text: string, maxChars: number, maxLines: number): string[] {
  const clip = (line: string) =>
    line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index]!;
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || current === "") {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
    index = words.length;
  }
  const out = lines.map(clip);
  if (index < words.length && out.length > 0) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = last.endsWith("…") ? last : `${last.slice(0, maxChars - 1)}…`;
  }
  return out;
}

/** "up to 8" or "×3" for a box that runs several agents; null for one. */
export function sketchCountTag(node: WorkflowNode): string | null {
  if (node.kind !== "agent") return null;
  if (node.count.kind === "upTo") return node.count.max > 1 ? `up to ${node.count.max}` : null;
  return node.count.n > 1 ? `×${node.count.n}` : null;
}

/** Box title: its label, else the first typed line, else a placeholder. */
export function sketchTitle(node: WorkflowNode): string {
  const first =
    node.text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return node.kind === "agent" ? node.label.trim() || first || "Untitled agent" : first;
}

/** On-screen size below which a thumbnail drops sketchy outlines and the model line. */
export const SKETCH_SMALL_SCALE = 0.45;
/** Smallest on-screen title, in pixels, a thumbnail draws. */
export const SKETCH_MIN_TITLE_PX = 9.5;

const PREVIEW_BOX = { width: 200, height: 96 };
const PREVIEW_GAP = { x: 56, y: 28 };
const PREVIEW_PAD = 24;
const PREVIEW_STACK = 20;

/**
 * A drawing's padded extent in canvas units: boxes with room for their count tag
 * and stacked cards, and marks. Thumbnails use it as their viewBox.
 */
export function sketchBounds(
  nodes: ReadonlyArray<WorkflowNode>,
  marks: ReadonlyArray<WorkflowMark> = [],
): { x: number; y: number; width: number; height: number } {
  const boxes = [
    ...nodes.map((node) => {
      const stack = sketchCountTag(node) ? PREVIEW_STACK : 0;
      return {
        x: node.x,
        y: node.y - 16,
        width: node.width + stack,
        height: node.height + stack + 16,
      };
    }),
    ...marks.map(markBox),
  ];
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x: minX - PREVIEW_PAD,
    y: minY - PREVIEW_PAD,
    width: maxX - minX + PREVIEW_PAD * 2,
    height: maxY - minY + PREVIEW_PAD * 2,
  };
}

/** How large a drawing shows when fit into a `width`×`height` pixel area. */
export function sketchFitScale(
  nodes: ReadonlyArray<WorkflowNode>,
  area: { readonly width: number; readonly height: number },
  marks: ReadonlyArray<WorkflowMark> = [],
): number {
  if (nodes.length === 0 && marks.length === 0) return 1;
  const bounds = sketchBounds(nodes, marks);
  return Math.min(area.width / bounds.width, area.height / bounds.height);
}

/**
 * Card thumbnails: a drawing that would shrink to unreadable boxes in its card
 * (a tall chain in a wide card) is redrawn as compact boxes flowing left to right
 * by level, which keeps labels legible. Drawings that already fit stay as drawn.
 */
export function sketchPreviewNodes(
  nodes: ReadonlyArray<WorkflowNode>,
  edges: ReadonlyArray<WorkflowEdge>,
  area: { readonly width: number; readonly height: number },
  marks: ReadonlyArray<WorkflowMark> = [],
): ReadonlyArray<WorkflowNode> {
  if (nodes.length === 0) return nodes;
  const asDrawn = sketchFitScale(nodes, area, marks);
  if (asDrawn >= SKETCH_SMALL_SCALE) return nodes;
  const ids = new Set(nodes.map((node) => node.id));
  const parentOf = new Map<string, string>();
  for (const edge of edges)
    if (edge.kind === "delegates" && ids.has(edge.from) && ids.has(edge.to))
      parentOf.set(edge.to, edge.from);
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const parent = parentOf.get(id);
    if (parent === undefined || seen.has(id)) return 0;
    seen.add(id);
    return depthOf(parent, seen) + 1;
  };
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const depth = depthOf(node.id);
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const rowHeight = PREVIEW_BOX.height + PREVIEW_STACK + PREVIEW_GAP.y;
  const tallest = Math.max(...[...columns.values()].map((column) => column.length));
  const placed = new Map<string, { x: number; y: number }>();
  for (const [depth, column] of columns) {
    const ordered = [...column].sort((a, b) => a.x - b.x || a.y - b.y);
    const offset = ((tallest - ordered.length) * rowHeight) / 2;
    ordered.forEach((node, index) =>
      placed.set(node.id, {
        x: depth * (PREVIEW_BOX.width + PREVIEW_STACK + PREVIEW_GAP.x),
        y: offset + index * rowHeight,
      }),
    );
  }
  const compact = nodes.map((node) => ({ ...node, ...PREVIEW_BOX, ...placed.get(node.id)! }));
  return sketchFitScale(compact, area) > asDrawn * 1.15 ? compact : nodes;
}

export interface SketchPreview {
  readonly nodes: ReadonlyArray<WorkflowNode>;
  readonly marks: ReadonlyArray<WorkflowMark>;
  /** On-screen pixels per canvas unit; 1 when drawn without an area. */
  readonly scale: number;
  readonly viewBox: { x: number; y: number; width: number; height: number };
}

/** How far, in canvas units, a mark may reach past a box and still belong to it. */
const MARK_REACH = 40;

/**
 * Marks drawn on or around one box (a circle, an underline, a word beside it),
 * moved and resized with that box into the compact layout. Marks spanning
 * several boxes or away from all of them no longer line up, so they are left out.
 */
function marksFollowingBoxes(
  marks: ReadonlyArray<WorkflowMark>,
  drawn: ReadonlyArray<WorkflowNode>,
  compact: ReadonlyArray<WorkflowNode>,
): ReadonlyArray<WorkflowMark> {
  const moved = new Map(compact.map((node) => [node.id, node]));
  return marks.flatMap((mark): WorkflowMark[] => {
    const box = markBox(mark);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const distance = (node: WorkflowNode) =>
      Math.hypot(node.x + node.width / 2 - center.x, node.y + node.height / 2 - center.y);
    const owner = drawn
      .filter(
        (node) =>
          box.x >= node.x - MARK_REACH &&
          box.y >= node.y - MARK_REACH &&
          box.x + box.width <= node.x + node.width + MARK_REACH &&
          box.y + box.height <= node.y + node.height + MARK_REACH,
      )
      .sort((a, b) => distance(a) - distance(b))[0];
    const to = owner && moved.get(owner.id);
    if (!owner || !to) return [];
    const sx = to.width / owner.width;
    const sy = to.height / owner.height;
    const x = to.x + (mark.x - owner.x) * sx;
    const y = to.y + (mark.y - owner.y) * sy;
    return mark.kind === "stroke"
      ? [{ ...mark, x, y, points: mark.points.map((v, i) => v * (i % 2 === 0 ? sx : sy)) }]
      : [{ ...mark, x, y }];
  });
}

/**
 * What a thumbnail draws in an `area` of pixels. Marks count toward the fit, so
 * far-flung marks make the boxes compact rather than tiny. Compact boxes keep
 * only the marks that belong to one box, moved with it, and text marks too
 * small to read are left out. Without an area the drawing shows as drawn.
 */
export function sketchPreview(
  nodes: ReadonlyArray<WorkflowNode>,
  edges: ReadonlyArray<WorkflowEdge>,
  marks: ReadonlyArray<WorkflowMark>,
  area?: { readonly width: number; readonly height: number },
): SketchPreview {
  if (!area) return { nodes, marks, scale: 1, viewBox: sketchBounds(nodes, marks) };
  const laidOut = sketchPreviewNodes(nodes, edges, area, marks);
  const placed = laidOut === nodes ? marks : marksFollowingBoxes(marks, nodes, laidOut);
  const fit = sketchFitScale(laidOut, area, placed);
  const shown = placed.filter(
    (mark) => mark.kind === "stroke" || MARK_TEXT_SIZES[mark.size] * fit >= SKETCH_MIN_TITLE_PX,
  );
  return {
    nodes: laidOut,
    marks: shown,
    scale: sketchFitScale(laidOut, area, shown),
    viewBox: sketchBounds(laidOut, shown),
  };
}

export const SKETCH_OPUS = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
export const SKETCH_SOL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
export const SKETCH_HAIKU = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

/**
 * The example team on both apps: Opus leads two Sol workers, each fanning out
 * to many Haiku agents. `resolved` labels the boxes and picks their models;
 * otherwise it is the raw sketch text. `id` makes the unique part of each id.
 */
export function sketchExampleWorkflow(
  now: string,
  resolved: boolean,
  id: () => string,
): WorkflowDefinition {
  const agent = (x: number, y: number, text: string): WorkflowAgentNode => ({
    kind: "agent",
    id: WorkflowNodeId.make(`n_${id()}`),
    x,
    y,
    width: 240,
    height: 132,
    text,
    label: "",
    model: null,
    instructions: "",
    count: { kind: "exact", n: 1 },
    machine: "local",
    isolation: "shared",
  });
  const edge = (from: WorkflowAgentNode, to: WorkflowAgentNode): WorkflowEdge => ({
    id: WorkflowEdgeId.make(`e_${id()}`),
    from: from.id,
    to: to.id,
    kind: "delegates",
  });
  const lead = agent(300, 0, "Opus 5.5 (parent)");
  const solA = agent(40, 230, "gpt 6.1 sol");
  const solB = agent(560, 230, "gpt 6.1 sol");
  const haikuA = agent(40, 460, "many haiku agents");
  const haikuB = agent(560, 460, "many haiku agents");
  const note: WorkflowNode = {
    kind: "note",
    id: WorkflowNodeId.make(`n_${id()}`),
    x: 860,
    y: 20,
    width: 200,
    height: 96,
    text: "Keep PRs small. Ask before touching the schema.",
    attachedTo: null,
  };
  const many = { kind: "upTo" as const, max: 8 };
  const nodes: WorkflowNode[] = resolved
    ? [
        {
          ...lead,
          label: "Lead",
          model: SKETCH_OPUS,
          instructions: "Split the release work and merge.",
        },
        {
          ...solA,
          label: "Backend",
          model: SKETCH_SOL,
          instructions: "Fix the failing API tests.",
          isolation: "worktree",
        },
        {
          ...solB,
          label: "Frontend",
          model: SKETCH_SOL,
          instructions: "Polish the settings screens.",
        },
        {
          ...haikuA,
          label: "Test fixers",
          model: SKETCH_HAIKU,
          instructions: "Fix one failing test each.",
          count: many,
        },
        {
          ...haikuB,
          label: "UI polish",
          model: SKETCH_HAIKU,
          instructions: "Tidy one screen each.",
          count: many,
        },
        note,
      ]
    : [lead, solA, solB, haikuA, haikuB, note];
  return {
    version: 1,
    id: WorkflowId.make(`wf_${id()}`),
    name: resolved ? "Ship the release" : "Opus team",
    description: "",
    rootNodeId: lead.id,
    nodes,
    edges: [edge(lead, solA), edge(lead, solB), edge(solA, haikuA), edge(solB, haikuB)],
    createdAt: now,
    updatedAt: now,
  };
}

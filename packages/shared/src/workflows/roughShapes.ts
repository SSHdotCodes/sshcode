import roughModule from "roughjs";
import type { Options } from "roughjs/bin/core.js";
import type { RoughGenerator } from "roughjs/bin/generator.js";

/**
 * Hand-drawn SVG paths from rough.js's generator (no DOM needed). Seeds come
 * from ids, so a box keeps the same wobble across renders; results are cached
 * because cards re-render on every status change while their size doesn't.
 */
// roughjs is CommonJS with ESM typings: NodeNext sees its API under `default`, bundlers at the top.
const rough = ((roughModule as { default?: unknown }).default ?? roughModule) as {
  generator: () => RoughGenerator;
};
const generator = rough.generator();
const cache = new Map<string, ReadonlyArray<RoughPath | null>>();

export interface RoughPath {
  readonly d: string;
  readonly strokeWidth: number;
  readonly fill: boolean;
}

export function seedFrom(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2_147_483_647 || 1;
}

function remember<T extends ReadonlyArray<RoughPath | null>>(key: string, make: () => T): T {
  const hit = cache.get(key) as T | undefined;
  if (hit) return hit;
  const value = make();
  if (cache.size > 600) cache.clear();
  cache.set(key, value);
  return value;
}

function toPaths(drawable: ReturnType<typeof generator.path>): RoughPath[] {
  return generator.toPaths(drawable).map((info) => ({
    d: info.d,
    strokeWidth: info.strokeWidth,
    fill: info.fill !== undefined && info.fill !== "none",
  }));
}

const BASE: Options = {
  roughness: 1.1,
  bowing: 0.9,
  strokeWidth: 1.6,
  stroke: "currentColor",
  disableMultiStroke: false,
  preserveVertices: false,
};

/** A rounded rectangle traced twice by hand, inset so strokes stay inside the box. */
export function roughCard(
  width: number,
  height: number,
  seed: number,
  options: { readonly radius?: number; readonly roughness?: number } = {},
): ReadonlyArray<RoughPath> {
  const w = Math.round(width);
  const h = Math.round(height);
  const r = Math.min(options.radius ?? 14, w / 4, h / 4);
  const roughness = options.roughness ?? BASE.roughness!;
  return remember(`card:${w}:${h}:${seed}:${r}:${roughness}`, () => {
    const i = 2;
    const right = w - i;
    const bottom = h - i;
    const d = [
      `M ${i + r} ${i}`,
      `L ${right - r} ${i}`,
      `Q ${right} ${i} ${right} ${i + r}`,
      `L ${right} ${bottom - r}`,
      `Q ${right} ${bottom} ${right - r} ${bottom}`,
      `L ${i + r} ${bottom}`,
      `Q ${i} ${bottom} ${i} ${bottom - r}`,
      `L ${i} ${i + r}`,
      `Q ${i} ${i} ${i + r} ${i}`,
    ].join(" ");
    return toPaths(generator.path(d, { ...BASE, seed, roughness }));
  });
}

/** A gently bowed line with an open arrowhead at the end. */
export function roughArrow(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  seed: number,
  options: { readonly head?: boolean } = {},
): { readonly line: string; readonly head: string | null; readonly smooth: string } {
  const round = (value: number) => Math.round(value * 2) / 2;
  const key = `arrow:${round(from.x)}:${round(from.y)}:${round(to.x)}:${round(to.y)}:${seed}:${options.head !== false}`;
  const [line, head, smooth] = remember(key, () => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    // Bow sideways a little, like a quick pen stroke.
    const bend = Math.min(18, length * 0.06) * (seed % 2 === 0 ? 1 : -1);
    const mid = {
      x: from.x + dx / 2 - (dy / length) * bend,
      y: from.y + dy / 2 + (dx / length) * bend,
    };
    const stroke = generator.curve(
      [
        [from.x, from.y],
        [mid.x, mid.y],
        [to.x, to.y],
      ],
      { ...BASE, seed, roughness: 0.9, bowing: 0.6 },
    );
    const lineD = toPaths(stroke)
      .map((path) => path.d)
      .join(" ");
    // A clean quadratic through the same midpoint, for hit testing and the run flow.
    const control = { x: 2 * mid.x - (from.x + to.x) / 2, y: 2 * mid.y - (from.y + to.y) / 2 };
    const smoothPath = {
      d: `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`,
      strokeWidth: 1.6,
      fill: false,
    };
    if (options.head === false) {
      return [{ d: lineD, strokeWidth: 1.6, fill: false }, null, smoothPath];
    }
    // Arrowhead follows the curve's final direction.
    const angle = Math.atan2(to.y - mid.y, to.x - mid.x);
    const size = Math.min(14, length / 3);
    const wing = (offset: number) =>
      [to.x - size * Math.cos(angle + offset), to.y - size * Math.sin(angle + offset)] as [
        number,
        number,
      ];
    const head = generator.linearPath([wing(0.45), [to.x, to.y], wing(-0.45)], {
      ...BASE,
      seed: seed + 1,
      roughness: 0.7,
    });
    return [
      { d: lineD, strokeWidth: 1.6, fill: false },
      {
        d: toPaths(head)
          .map((path) => path.d)
          .join(" "),
        strokeWidth: 1.6,
        fill: false,
      },
      smoothPath,
    ];
  });
  return { line: line!.d, head: head?.d ?? null, smooth: smooth!.d };
}

/**
 * Where the segment from a box's center toward `toward` leaves the box, so
 * arrows meet box edges instead of centers.
 */
export function boxEdgePoint(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  toward: { readonly x: number; readonly y: number },
  gap = 6,
): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = box.width / 2 + gap;
  const halfH = box.height / 2 + gap;
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * The home sky as dither layers: pure, so it can be drawn off the screen and tested.
 *
 * A bank of fog lies along the top of the screen, heaviest toward the right, rolling in
 * soft billows and thinning to nothing above the first chat: the new chat's smoke, seen
 * from the list. Each harness wears one arc of it around a sun past the top right corner,
 * sized by its share, with a dithered seam where two meet.
 */
import { MOSAIC_STEPS, mosaicShade } from "@t3tools/client-runtime/new-chat-smoke";

import { DitherCanvas, DOT, ditherThreshold, MOSAIC_LEVELS, type DitherLayer } from "./dither";

/** How many reveal steps the fog dissolves in by. */
export const SKY_SLICES = 4;
/** How many rings a working sky's ripple steps through, from the sun outward. */
export const RIPPLE_STEPS = 6;

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const v = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Soft noise in two octaves: broad billows with a little curl at their edges. */
function billows(x: number, y: number): number {
  return 0.7 * valueNoise(x / 96, y / 58) + 0.3 * valueNoise(x / 38 + 7.3, y / 25 + 3.1);
}

export interface SkyLayers {
  readonly glow: DitherLayer[];
  readonly rim: DitherLayer[];
  /** Thin rings, `slice` counting out from the sun, lit one after another while agents work. */
  readonly ripple: DitherLayer[];
}

/** One harness's share of the sky: its hue where the fog is thin, its hot tone where dense. */
export interface SkyTone {
  readonly glow: string;
  readonly rim: string;
  readonly share: number;
}

interface SkyGrid {
  readonly columns: number;
  readonly rows: number;
  /** The fog's density at each dot, 0 to 1. */
  readonly fog: Float32Array;
  /** Each dot's distance from the sun, which decides whose arc it is in. */
  readonly arc: Float32Array;
  /** `arc` over the fogged dots, sorted, to cut the arcs by share. */
  readonly sorted: Float32Array;
}

/** The few sizes in use (the sky over the chats, the dawn over Insights), kept once worked out. */
const cachedGrids = new Map<string, SkyGrid>();

/** The fog depends only on the size, so it is worked out once and kept. */
function skyGrid(width: number, height: number): SkyGrid {
  const key = `${width}x${height}`;
  const cached = cachedGrids.get(key);
  if (cached) return cached;
  const columns = Math.max(1, Math.round(width / DOT));
  const rows = Math.max(1, Math.round(height / DOT));
  const fog = new Float32Array(columns * rows);
  const arc = new Float32Array(columns * rows);
  const fogged: number[] = [];
  const sunX = width + 24;
  const sunY = -height * 0.4;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = column * DOT;
      const y = row * DOT;
      const index = row * columns + column;
      // Distance into the fog: down the screen, and a little toward the left.
      const depth = (y / height) * 1.2 + (1 - x / width) * 0.5 + (0.5 - billows(x, y)) * 0.4;
      const density = depth >= 1 ? 0 : Math.min(1, (1 - Math.max(0, depth)) ** 1.7 * 1.2);
      fog[index] = density;
      arc[index] = Math.hypot((sunX - x) / width, (y - sunY) / (height * 1.4));
      if (density > 0.04) fogged.push(arc[index]!);
    }
  }
  const sorted = Float32Array.from(fogged).sort();
  const grid = { columns, rows, fog, arc, sorted };
  // A turned phone brings new sizes: keep the last few only.
  if (cachedGrids.size >= 4) cachedGrids.delete(cachedGrids.keys().next().value!);
  cachedGrids.set(key, grid);
  return grid;
}

/**
 * `fadeTop`, a share of the height, softens the top edge too: for a bank that begins
 * partway down the screen rather than at its top.
 */
export function skyLayers(
  width: number,
  height: number,
  tones: ReadonlyArray<SkyTone>,
  fadeTop = 0,
  gap?: number,
): SkyLayers {
  const glowCanvas = new DitherCanvas(SKY_SLICES, gap);
  const rimCanvas = new DitherCanvas(SKY_SLICES, gap);
  const rippleCanvas = new DitherCanvas(RIPPLE_STEPS, gap);
  if (tones.length > 0) {
    const { columns, rows, fog, arc, sorted } = skyGrid(width, height);
    // Cut the arcs so each harness covers its share of the fog, the largest nearest the sun.
    const total = tones.reduce((sum, tone) => sum + Math.max(0, tone.share), 0) || 1;
    const cuts: number[] = [];
    let running = 0;
    for (const tone of tones.slice(0, -1)) {
      running += Math.max(0, tone.share) / total;
      cuts.push(sorted[Math.min(sorted.length - 1, Math.floor(running * sorted.length))] ?? 1);
    }
    const toneAt = (column: number, row: number) => {
      // A dithered seam: tiles near a cut fall to either side in the Bayer order.
      const value =
        arc[row * columns + column]! + (ditherThreshold(column + 3, row + 5) - 0.5) * 0.08;
      let tone = 0;
      while (tone < cuts.length && value >= cuts[tone]!) tone++;
      return tones[tone]!;
    };
    const fadeRows = fadeTop * rows;
    const densityAt = (column: number, row: number) => {
      const density = fog[row * columns + column]!;
      if (row >= fadeRows) return density;
      const rise = row / fadeRows;
      return density * rise * rise * (3 - 2 * rise);
    };
    glowCanvas.paint(columns, rows, densityAt, (column, row) => toneAt(column, row).glow);
    rimCanvas.paint(
      columns,
      rows,
      (column, row) => Math.max(0, (densityAt(column, row) - 0.55) * 1.7),
      (column, row) => toneAt(column, row).rim,
    );
    // The ripple: RIPPLE_STEPS thin rings around the sun, inside the fog.
    const first = sorted[0] ?? 0;
    const last = sorted[sorted.length - 1] ?? 1;
    const band = (last - first) / RIPPLE_STEPS;
    const rippleTop = MOSAIC_LEVELS * MOSAIC_STEPS;
    if (band > 0) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const index = row * columns + column;
          const density = densityAt(column, row);
          if (density <= 0.08) continue;
          const position = (arc[index]! - first) / band;
          const step = Math.min(RIPPLE_STEPS - 1, Math.floor(position));
          // A ring a third of its band wide, as full as the fog it crosses.
          if (step < 0 || position - step > 0.34) continue;
          const shade = mosaicShade(0.25 + 0.6 * density, column, row, MOSAIC_LEVELS);
          if (shade === 0) continue;
          rippleCanvas.dotAt(column, row, step, toneAt(column, row).rim, shade / rippleTop);
        }
      }
    }
  }
  return {
    glow: glowCanvas.layers(),
    rim: rimCanvas.layers(),
    ripple: rippleCanvas.layers(),
  };
}

/**
 * The new-chat backdrop in the style of a dithered photo: a smoky cloud of the harness's
 * light rising from the lower right, a faint second one in the upper left, and dark
 * between them where the prompt sits. The field is cut into a few tones with an 8×8
 * Bayer matrix, so it reads as chunky ordered dither rather than a smooth gradient.
 *
 * Pure and deterministic: the same grid always gives the same scene, on every client.
 */

/** Tones above the background: deep, dim, mid, full tint, hot core. */
export const SMOKE_TONES = 5;

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

/** The 8×8 Bayer threshold in (0, 1) at grid `column`, `row`. */
export function bayerThreshold(column: number, row: number): number {
  return BAYER[(row & 7) * 8 + (column & 7)]!;
}

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let octave = 0; octave < 5; octave++) {
    sum += amplitude * valueNoise(x, y, seed + octave * 17);
    norm += amplitude;
    x *= 2.03;
    y *= 2.03;
    amplitude *= 0.5;
  }
  return sum / norm;
}

const smooth = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
};

/** Brightness 0–1 at a point; `x` runs 0 to `aspect` across, `y` 0 to 1 down. */
export function smokeIntensity(x: number, y: number, aspect: number): number {
  const scale = 2.4;
  // Warping the noise by more noise turns blobs into wisps of smoke.
  const warpX = fbm(x * scale + 3.1, y * scale + 1.7, 11) - 0.5;
  const warpY = fbm(x * scale + 8.3, y * scale + 4.2, 23) - 0.5;
  const smoke = fbm(x * scale * 1.6 + warpX * 4, y * scale * 1.6 + warpY * 4, 5);
  const main = Math.exp(-(((x - aspect) / 0.95) ** 2 + ((y - 1.05) / 0.85) ** 2) * 1.6);
  const corner = 0.3 * Math.exp(-((x / 0.5) ** 2 + ((y + 0.05) / 0.35) ** 2) * 2.2);
  const light = (main + corner) * (0.9 + 0.75 * (smoke - 0.5) * 2);
  // Below the floor is plain background: the dark stays dark, not a sprinkle of dots.
  return Math.min(1, Math.max(0, (light - 0.1) / 0.9));
}

/** The cloud's wisps alone, 0–1, without its glow: the grain of the open chat's edges. */
function smokeTexture(x: number, y: number): number {
  const scale = 3.2;
  const warpX = fbm(x * scale + 3.1, y * scale + 1.7, 11) - 0.5;
  const warpY = fbm(x * scale + 8.3, y * scale + 4.2, 23) - 0.5;
  const smoke = fbm(x * scale * 1.6 + warpX * 4, y * scale * 1.6 + warpY * 4, 5);
  // fbm keeps to the middle of 0–1; stretch it so wisps and gaps both show.
  return Math.min(1, Math.max(0, (smoke - 0.5) * 2.2 + 0.5));
}

/** Broad, slow swells, 0–1: how far the open chat's edge glow reaches in at each point. */
function smokeSwell(x: number, y: number): number {
  return Math.min(1, Math.max(0, (fbm(x * 1.3 + 5.7, y * 1.3 + 2.9, 41) - 0.5) * 2.4 + 0.5));
}

/**
 * How much of the embers' edge glow shows at a point, 0–1. It leans hard toward the lower
 * right, where the new chat's cloud was. Away from there broad clumps with real gaps decide
 * which stretches of edge glow, so the edges never read as a border; near the lower right
 * the clumps give way and the corner stays one smoky mass.
 */
function emberShape(x: number, y: number, aspect: number, settle = EMBER_SETTLE): number {
  const clumps = smooth((fbm(x * 1.7 + 9.2, y * 1.7 + 6.1, 59) - 0.44) / 0.2);
  // The cloud's own glow (see smokeIntensity), so the embers are where it settled.
  const home = Math.exp(
    -(((x - aspect) / settle.across) ** 2 + ((y - 1.05) / settle.up) ** 2) * 1.6,
  );
  return Math.min(1, (0.08 + 1.25 * home) * (clumps + (1 - clumps) * home ** 2));
}

/** The field's own detail is coarser than a cell; sampling it every few cells is enough. */
const SAMPLE_EVERY = 3;

/** A field over a `columns`×`rows` grid of square cells, sampled coarsely and read back smoothly. */
function sampledField(
  columns: number,
  rows: number,
  intensity: (x: number, y: number, aspect: number) => number = smokeIntensity,
): (column: number, row: number) => number {
  const aspect = columns / rows;
  const sampleColumns = Math.ceil(columns / SAMPLE_EVERY) + 1;
  const sampleRows = Math.ceil(rows / SAMPLE_EVERY) + 1;
  // Filled on first read: the open chat's embers only ever read near the edges.
  const samples = new Float32Array(sampleColumns * sampleRows).fill(Number.NaN);
  const at = (r: number, c: number) => {
    const index = r * sampleColumns + c;
    let value = samples[index]!;
    if (Number.isNaN(value)) {
      value = intensity((c * SAMPLE_EVERY + 0.5) / rows, (r * SAMPLE_EVERY + 0.5) / rows, aspect);
      samples[index] = value;
      value = samples[index]!;
    }
    return value;
  };
  return (column, row) => {
    const sy = row / SAMPLE_EVERY;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const sx = column / SAMPLE_EVERY;
    const x0 = Math.floor(sx);
    const fx = sx - x0;
    const top = at(y0, x0) + (at(y0, x0 + 1) - at(y0, x0)) * fx;
    const bottom = at(y0 + 1, x0) + (at(y0 + 1, x0 + 1) - at(y0 + 1, x0)) * fx;
    return top + (bottom - top) * fy;
  };
}

function dither(value: number, column: number, row: number, levels: number): number {
  const floor = Math.floor(value);
  return Math.min(levels, floor + (value - floor > bayerThreshold(column, row) ? 1 : 0));
}

/**
 * The tone of every cell in a `columns`×`rows` grid, row by row: 0 is background,
 * `SMOKE_TONES` the hot core. Cells are square, so the grid's shape sets the aspect.
 */
export function smokeTones(columns: number, rows: number): Uint8Array {
  const field = sampledField(columns, rows);
  const tones = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      tones[row * columns + column] = dither(
        field(column, row) * SMOKE_TONES,
        column,
        row,
        SMOKE_TONES,
      );
    }
  }
  return tones;
}

/**
 * When each cell goes out as the new chat's cloud settles into an open chat's embers, from
 * 0 (first) to 1 (last): the far upper left and the thin wisps first, the dense core in the
 * lower right last, in Bayer order within that, so the cloud dissolves as dither. The lit
 * cells (`tones` above 0) are spread evenly over 0 to 1, so the same share of the cloud goes
 * out in every moment of the animation. Run it backwards (1 minus) and the cloud billows
 * out of the corner instead.
 */
export function smokeDissolveOrder(columns: number, rows: number, tones: Uint8Array): Float32Array {
  const field = sampledField(columns, rows);
  const order = new Float32Array(columns * rows);
  const diagonal = Math.hypot(columns, rows);
  const lit: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const fromCorner = Math.hypot(columns - column, rows - row) / diagonal;
      order[index] =
        0.45 * (1 - fromCorner) +
        0.35 * field(column, row) +
        0.2 * BAYER[(row % 8) * 8 + (column % 8)]!;
      if (tones[index]! > 0) lit.push(index);
    }
  }
  lit.sort((left, right) => order[left]! - order[right]!);
  const last = Math.max(1, lit.length - 1);
  for (let rank = 0; rank < lit.length; rank++) order[lit[rank]!] = rank / last;
  return order;
}

/** Tones of the embers an open chat keeps: a whisper of the new chat's cloud. */
export const EMBER_TONES = 3;

/** The brightest the embers get, 0–1: at most about two thirds of the densest cells at the top tone. */
const EMBER_PEAK = 0.88;

/** The farthest an edge's embers reach, as a multiple of its `reach` (the swell at its widest). */
export const EMBER_MAX_STRETCH = 1.6 * 1.3;

/** How far in from an edge the embers reach (CSS pixels, points) and how bright they get there (0–1). */
export interface EmberEdge {
  readonly reach: number;
  readonly strength: number;
}

/** How far from the lower-right corner the embers settle, across and up, in screen heights. */
export interface EmberSettle {
  readonly across: number;
  readonly up: number;
}

/** Where the cloud's own glow sits (see smokeIntensity): the embers' home by default. */
const EMBER_SETTLE: EmberSettle = { across: 0.95, up: 0.85 };

/** Each edge's glow, and the lower-right corner's; one left out stays plain. */
export interface EmberEdges {
  readonly top?: EmberEdge;
  readonly right?: EmberEdge;
  readonly bottom?: EmberEdge;
  readonly left?: EmberEdge;
  /** Measured from the lower-right corner itself, so the corner holds a mass, not an L. */
  readonly corner?: EmberEdge;
  /** How widely the embers settle around the corner; wider fills more of a big window. */
  readonly settle?: EmberSettle;
  /** The corner's reach at most, as a share of the window's longer side. */
  readonly cornerShare?: number;
}

/**
 * An open chat's embers, settled where the new chat's cloud was: a smoky mass in the lower
 * right, trailing along the bottom and up the right edge's lower half. They settle wide, so
 * a big window keeps light across its lower third instead of one small corner; the top and
 * left stay plain, so the corner holds the eye instead of a frame.
 */
export const CHAT_EMBER_EDGES: EmberEdges = {
  corner: { reach: 1000, strength: 1 },
  bottom: { reach: 340, strength: 0.62 },
  right: { reach: 340, strength: 0.78 },
  settle: { across: 1.8, up: 1.5 },
  cornerShare: 0.55,
};

/**
 * An open chat's embers as light rather than tones: the lit cells, how bright each is, and
 * where each sits in the slow wave that rolls out of the corner while the agent works.
 */
export interface EmberField {
  readonly columns: number;
  readonly rows: number;
  /** Indices of the lit cells, row by row. */
  readonly cells: Int32Array;
  /** Each lit cell's light, 0 to `EMBER_PEAK`. */
  readonly light: Float32Array;
  /** Each lit cell's place in the wave, in radians. */
  readonly phase: Float32Array;
}

/** One swell of the working embers' wave, in seconds: slow, so it reads as breathing, not flicker. */
export const EMBER_WAVE_SECONDS = 6;
/** How far apart the wave's crests are, in CSS pixels (points). */
const EMBER_WAVELENGTH = 240;

/**
 * What is left of the new chat's cloud once a chat is open: its wisps along the `edges` of
 * a `columns`×`rows` grid, fading in from each edge (and the lower-right corner) over its
 * reach. The reach swells and ebbs so the inner rim is never a line, broad clumps leave
 * stretches of edge plain, and the whole leans toward the lower right like the cloud.
 * `cell` is how many CSS pixels (points) one cell is.
 */
export function emberTones(
  columns: number,
  rows: number,
  cell: number,
  edges: EmberEdges = CHAT_EMBER_EDGES,
): Uint8Array {
  const tones = new Uint8Array(columns * rows);
  emberTonesAt(emberField(columns, rows, cell, edges), 0, 0, 1, tones);
  return tones;
}

/**
 * The embers' tones at `time` seconds into the working wave: each lit cell's light scaled
 * by `gain` and swung by `swell` (a fraction of it) as the wave passes, then dithered.
 * Writes every lit cell of `out` (a `columns`×`rows` grid) and leaves the rest alone.
 */
export function emberTonesAt(
  field: EmberField,
  time: number,
  swell: number,
  gain: number,
  out: Uint8Array,
): void {
  const speed = (2 * Math.PI) / EMBER_WAVE_SECONDS;
  for (let lit = 0; lit < field.cells.length; lit++) {
    const index = field.cells[lit]!;
    const value =
      swell === 0
        ? field.light[lit]! * gain
        : field.light[lit]! * (gain + swell * Math.sin(speed * time + field.phase[lit]!));
    out[index] =
      value <= 0
        ? 0
        : dither(
            value * EMBER_TONES,
            index % field.columns,
            Math.floor(index / field.columns),
            EMBER_TONES,
          );
  }
}

/** The embers' lit cells for a `columns`×`rows` grid (see `emberTones`). */
export function emberField(
  columns: number,
  rows: number,
  cell: number,
  edges: EmberEdges = CHAT_EMBER_EDGES,
): EmberField {
  const width = columns * cell;
  const height = rows * cell;
  const near = (distance: number, edge: EmberEdge | undefined) =>
    edge === undefined || edge.reach <= 0
      ? 0
      : edge.strength * smooth(1 - distance / edge.reach) ** 1.5;
  // In a small window the corner keeps to a share of it; on a tall phone it climbs.
  const cornerEdge =
    edges.corner === undefined
      ? undefined
      : {
          ...edges.corner,
          reach: Math.min(
            edges.corner.reach,
            Math.max(width, height) * (edges.cornerShare ?? 0.38),
          ),
        };
  // Smooth at the scale of a few cells, so it is worked out on the coarse grid and only
  // the dither is per cell.
  const light = sampledField(columns, rows, (u, v, aspect) => {
    const x = u * rows * cell;
    const y = v * rows * cell;
    const grain = smokeTexture(u, v);
    // The reach swells and ebbs along each edge, and the wisps reach in further than the
    // gaps, so the inner rim is never a line.
    const stretch = (0.4 + 1.2 * smokeSwell(u, v)) * (0.65 + 0.65 * grain);
    const top = near(y / stretch, edges.top);
    const bottom = near((height - y) / stretch, edges.bottom);
    const left = near(x / stretch, edges.left);
    // The right edge rises from its lower half, the way the cloud climbed, never a ribbon.
    const right = near((width - x) / stretch, edges.right) * smooth((y / height - 0.35) / 0.45);
    // The corner's reach swells less, so it stays one mass; its grain still shows inside.
    const corner = near(
      Math.hypot(width - x, height - y) / (0.75 + 0.5 * smokeSwell(u, v)),
      cornerEdge,
    );
    const glow = 1 - (1 - top) * (1 - bottom) * (1 - left) * (1 - right) * (1 - corner);
    if (glow === 0) return -1;
    const raw =
      Math.min(1, 1.2 * glow * emberShape(u, v, aspect, edges.settle)) * (0.35 + 0.65 * grain);
    // Less a floor, so the gaps are plain background rather than a sprinkle of dots, and a
    // clump's outline fades in instead of starting at a cut. Capped below full so even the
    // hottest pocket keeps its dither instead of going solid.
    return Math.min(EMBER_PEAK, (raw - 0.07) / 0.93);
  });
  // Beyond every edge's farthest swell nothing shows; the middle is skipped unread.
  const farthest = (edge: EmberEdge | undefined) =>
    edge === undefined || edge.reach <= 0 ? 0 : edge.reach * EMBER_MAX_STRETCH;
  const [topFar, rightFar, bottomFar, leftFar] = [
    farthest(edges.top),
    farthest(edges.right),
    farthest(edges.bottom),
    farthest(edges.left),
  ];
  const cornerFar = farthest(cornerEdge);
  const innerFrom = Math.max(0, Math.ceil(leftFar / cell - 0.5));
  const innerTo = Math.min(
    columns,
    Math.floor((width - Math.max(rightFar, cornerFar)) / cell - 0.5) + 1,
  );
  const cells: number[] = [];
  const lights: number[] = [];
  const phases: number[] = [];
  const crest = (2 * Math.PI) / EMBER_WAVELENGTH;
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * cell;
    const rowInner = y >= topFar && height - y >= Math.max(bottomFar, cornerFar);
    for (let column = 0; column < columns; column++) {
      if (rowInner && column >= innerFrom && column < innerTo) {
        column = innerTo - 1;
        continue;
      }
      const value = light(column, row);
      if (value <= 0) continue;
      const x = (column + 0.5) * cell;
      cells.push(row * columns + column);
      lights.push(value);
      // Crests roll out of the corner, bent a little with the angle so they curl like smoke.
      const angle = Math.atan2(height - y, width - x);
      phases.push(-crest * Math.hypot(width - x, height - y) + 1.2 * Math.sin(angle * 3));
    }
  }
  return {
    columns,
    rows,
    cells: Int32Array.from(cells),
    light: Float32Array.from(lights),
    phase: Float32Array.from(phases),
  };
}

/** Colours for ember tones 1 to `EMBER_TONES`: the background mixed toward the tint (`emberMixes`). */
export function emberRamp(
  tint: readonly [number, number, number],
  background: readonly [number, number, number],
): Array<readonly [number, number, number]> {
  const mix = (index: 0 | 1 | 2, amount: number) =>
    Math.round(background[index] + (tint[index] - background[index]) * amount);
  return emberMixes(background).map(
    (amount) => [mix(0, amount), mix(1, amount), mix(2, amount)] as const,
  );
}

/**
 * How far each ember tone mixes the background toward the tint. On a dark background the
 * dense pockets carry real colour while the fringe stays quiet; on a light one the same
 * amounts read as a stain, so they are lighter.
 */
export function emberMixes(background: readonly [number, number, number]): readonly number[] {
  const luminance =
    (0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]) / 255;
  return luminance > 0.5 ? EMBER_MIXES_LIGHT : EMBER_MIXES_DARK;
}
export const EMBER_MIXES_DARK = [0.1, 0.25, 0.5] as const;
export const EMBER_MIXES_LIGHT = [0.08, 0.18, 0.3] as const;

/**
 * How far smoke tones 1–4 mix the background toward the harness tint; tone 5 is the hot core.
 * The body tops out short of the full tint so the cloud reads as copper light, not glare,
 * behind the new chat's translucent cards.
 */
export const SMOKE_MIXES = [0.2, 0.42, 0.64, 0.82] as const;

/**
 * The colours for tones 1 to `SMOKE_TONES`, as [r, g, b]: the background mixed into the
 * harness tint by `SMOKE_MIXES`, then `core` (the cloud's hot centre).
 */
export function smokeRamp(
  tint: readonly [number, number, number],
  background: readonly [number, number, number],
  core: readonly [number, number, number],
): Array<readonly [number, number, number]> {
  const mix = (from: readonly number[], to: readonly number[], amount: number) =>
    [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * amount)) as [
      number,
      number,
      number,
    ];
  return [
    ...SMOKE_MIXES.map((amount) => mix(background, tint, amount)),
    [...core] as [number, number, number],
  ];
}

// --- Mosaic -------------------------------------------------------------------------------
//
// The same light drawn as a lit panel: a grid of square tiles split by hairline gaps, our
// ordered dither kept at tile scale. Through the body of the light each tile picks between
// neighbouring shades by the Bayer matrix, so it reads as a dithered photo on a panel; where
// the light thins out, tiles drop out in Bayer order, so wisps fray the way the dither did.
// A renderer draws one tile per cell and clears `MOSAIC_GAP` along each cell's right and
// bottom edge, so the background shows between tiles.

/** CSS pixels (points) from one tile to the next. */
export const MOSAIC_CELL = 4;
/** The line between tiles, in CSS pixels (points): one device pixel on a Retina screen. */
export const MOSAIC_GAP = 0.5;
/** Shades between two neighbouring ramp colours; the dither picks between them per tile. */
export const MOSAIC_STEPS = 3;
/** How far each tile's brightness strays from its neighbours', as a fraction: a lit panel, not a gradient. */
const MOSAIC_JITTER = 0.06;
/** Below this (lifted) light tiles thin out in dither order instead of dimming. */
const MOSAIC_FRAY = 0.35;

/** Whole device pixels for the hairline gap at a screen density: never less than 1. */
export function mosaicGapPixels(density: number): number {
  return Math.max(1, Math.round(MOSAIC_GAP * density));
}

/**
 * Light 0–1 as a tile shade from 0 (off) to `levels * MOSAIC_STEPS`. The gaps take some of
 * each tile's area, so the light is lifted to read as bright as the dither did; each tile's
 * fixed jitter keeps the panel from reading as a smooth gradient and never flickers.
 */
export function mosaicShade(value: number, column: number, row: number, levels: number): number {
  if (value <= 0) return 0;
  const threshold = bayerThreshold(column, row);
  const lifted =
    Math.min(1, value * 1.3) ** 0.8 * (1 + MOSAIC_JITTER * (hash(column, row, 97) - 0.5) * 2);
  const top = levels * MOSAIC_STEPS;
  if (lifted < MOSAIC_FRAY) {
    // The fringe: fewer tiles as the light thins, each a dim shade of the light it frays from.
    if (lifted / MOSAIC_FRAY <= threshold) return 0;
    return Math.max(1, Math.round(MOSAIC_FRAY * top * (0.55 + 0.45 * (lifted / MOSAIC_FRAY))));
  }
  return Math.max(1, Math.min(top, dither(Math.min(1, lifted) * top, column, row, top)));
}

/** `smokeTones` as mosaic shades: 0 is off, `SMOKE_TONES * MOSAIC_STEPS` the hot core. */
export function smokeMosaic(columns: number, rows: number): Uint8Array {
  const field = sampledField(columns, rows);
  const shades = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      shades[row * columns + column] = mosaicShade(field(column, row), column, row, SMOKE_TONES);
    }
  }
  return shades;
}

/** `emberTones` as mosaic shades, 0 to `EMBER_TONES * MOSAIC_STEPS`. */
export function emberMosaic(
  columns: number,
  rows: number,
  cell: number,
  edges: EmberEdges = CHAT_EMBER_EDGES,
): Uint8Array {
  const shades = new Uint8Array(columns * rows);
  emberMosaicAt(emberField(columns, rows, cell, edges), 0, 0, 1, shades);
  return shades;
}

/**
 * `emberTonesAt` as mosaic shades, 0 to `EMBER_TONES * MOSAIC_STEPS`: each lit cell's light
 * scaled by `gain` and swung by `swell` as the wave passes. Writes every lit cell of `out`.
 */
export function emberMosaicAt(
  field: EmberField,
  time: number,
  swell: number,
  gain: number,
  out: Uint8Array,
): void {
  const speed = (2 * Math.PI) / EMBER_WAVE_SECONDS;
  for (let lit = 0; lit < field.cells.length; lit++) {
    const index = field.cells[lit]!;
    const value =
      swell === 0
        ? field.light[lit]! * gain
        : field.light[lit]! * (gain + swell * Math.sin(speed * time + field.phase[lit]!));
    out[index] = mosaicShade(
      value / EMBER_PEAK,
      index % field.columns,
      Math.floor(index / field.columns),
      EMBER_TONES,
    );
  }
}

/**
 * Tone opacity stops (0–1 for tones 1 to n, as `SMOKE_MIXES` and `EMBER_MIXES_DARK` give)
 * spread over mosaic shades 0 to `n * MOSAIC_STEPS` as alpha bytes (0–255).
 */
export function mosaicAlphaRamp(mixes: ReadonlyArray<number>): Uint8Array {
  const stops = [0, ...mixes];
  const alphas = new Uint8Array(mixes.length * MOSAIC_STEPS + 1);
  for (let shade = 1; shade <= mixes.length * MOSAIC_STEPS; shade++) {
    const at = shade / MOSAIC_STEPS;
    const below = Math.min(mixes.length, Math.floor(at));
    const from = stops[below]!;
    const to = stops[Math.min(mixes.length, below + 1)]!;
    alphas[shade] = Math.round((from + (to - from) * (at - below)) * 255);
  }
  return alphas;
}

/**
 * A tone ramp (colours for tones 1 to n, as `smokeRamp` and `emberRamp` give) spread over
 * the mosaic's shades 1 to `n * MOSAIC_STEPS`, starting from the background.
 */
export function mosaicRamp(
  background: readonly [number, number, number],
  ramp: ReadonlyArray<readonly [number, number, number]>,
): Array<readonly [number, number, number]> {
  const stops = [background, ...ramp];
  const shades: Array<readonly [number, number, number]> = [];
  for (let shade = 1; shade <= ramp.length * MOSAIC_STEPS; shade++) {
    const at = shade / MOSAIC_STEPS;
    const below = Math.min(ramp.length, Math.floor(at));
    const from = stops[below]!;
    const to = stops[Math.min(ramp.length, below + 1)]!;
    const amount = at - below;
    shades.push([
      Math.round(from[0] + (to[0] - from[0]) * amount),
      Math.round(from[1] + (to[1] - from[1]) * amount),
      Math.round(from[2] + (to[2] - from[2]) * amount),
    ]);
  }
  return shades;
}

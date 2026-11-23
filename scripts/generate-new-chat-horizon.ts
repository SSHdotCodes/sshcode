// @effect-diagnostics nodeBuiltinImport:off - Standalone Node asset generator.
/**
 * Dithered tile-mosaic masks for the chat backdrop. Run with node scripts/generate-new-chat-horizon.ts.
 *
 * Each scene is four gray+alpha masks: a wide glow and a thin hot rim along a rising planet arc,
 * and a sparse star field above it split into steady stars and a few that twinkle.
 * Clients tint them per harness, so no color is baked in. Each 4pt cell holds one square tile
 * separated by a transparent hairline gap (whole device pixels, at least 1) baked into every
 * density's pixels, with mosaic shade levels mapped to alpha.
 */
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import {
  EMBER_MAX_STRETCH,
  EMBER_MIXES_DARK,
  EMBER_TONES,
  type EmberEdges,
  emberMosaic,
  MOSAIC_CELL,
  MOSAIC_STEPS,
  mosaicAlphaRamp,
  mosaicGapPixels,
  mosaicShade,
  SMOKE_MIXES,
  smokeDissolveOrder,
  smokeMosaic,
} from "../packages/client-runtime/src/newChatSmoke.ts";

type Scene = {
  readonly name: string;
  /** Size in 4pt mosaic cells. */
  readonly width: number;
  readonly height: number;
  /** Planet radius and the arc's highest row, in cells. */
  readonly radius: number;
  readonly peak: number;
  /** Atmosphere falloff above the rim, in cells. */
  readonly sky: number;
  readonly haze: number;
  /** Fraction of the width over which the light gathers toward the arc's crown. */
  readonly crown: number;
  readonly edgeFade: number;
  /** Sky cells per star, and how far above the rim the first ones sit, in cells. */
  readonly starSpacing: number;
  readonly starClearance: number;
  /** Screen densities to pre-render (1x, 2x, 3x). */
  readonly densities: ReadonlyArray<number>;
};

const scenes: ReadonlyArray<Scene> = [
  {
    name: "new-chat-horizon",
    width: 512,
    height: 224,
    radius: 310,
    peak: 125,
    sky: 13,
    haze: 30,
    crown: 0.3,
    edgeFade: 0.12,
    starSpacing: 275,
    starClearance: 15,
    densities: [1, 2],
  },
  {
    name: "new-chat-horizon-mobile",
    width: 110,
    height: 100,
    radius: 95,
    peak: 70,
    sky: 8,
    haze: 20,
    crown: 0.42,
    edgeFade: 0.06,
    starSpacing: 120,
    starClearance: 11,
    densities: [1, 2, 3],
  },
];

const GLOW_LEVELS = 4;
const RIM_LEVELS = 3;

const smoothstep = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

function sample(scene: Scene, x: number, y: number) {
  const across = (x - scene.width / 2) / scene.width;
  // Signed distance from the planet's surface: positive is sky, negative is the planet.
  const distance = Math.hypot(x - scene.width / 2, y - (scene.peak + scene.radius)) - scene.radius;
  const crown = Math.exp(-((across / scene.crown) ** 2));
  // Outer ring of cells fades all the way to zero so fixed-size masks never leave a seam.
  const edge = smoothstep(
    Math.min(x - 0.5, scene.width - 0.5 - x) / (scene.width * scene.edgeFade),
  );
  const top = smoothstep((y - 0.5) / (scene.height * 0.35));
  const sky =
    distance > 0
      ? 0.62 * Math.exp(-distance / scene.sky) + 0.14 * Math.exp(-distance / scene.haze)
      : 0;
  const underglow = distance <= 0 ? 0.3 * Math.exp(distance / 2.8) : 0;
  const line = Math.exp(-((distance / 0.64) ** 2));
  const glow =
    sky * (0.35 + 0.65 * crown) +
    underglow * (0.4 + 0.6 * crown) +
    0.55 * line * (0.5 + 0.5 * crown);
  const rim =
    Math.exp(-((distance / 0.55) ** 2)) * (0.25 + 0.75 * crown) +
    (distance > 0 ? 0.45 * Math.exp(-distance / 3.6) * crown ** 2 : 0);
  return { glow: glow * edge * top, rim: rim * edge * top };
}

/** A fixed pseudo-random value in [0, 1) per cell, so every run draws the same sky. */
function cellNoise(x: number, y: number, salt: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const STAR_LEVELS = 3;
/**
 * Single-tile stars at three brightness steps, thinning toward the rim's haze, the art's
 * edges and the column the heading and prompt sit in. About one in six goes to the twinkle
 * mask instead, so clients can fade just those.
 */
function drawStars(scene: Scene) {
  const steady = new Uint8Array(scene.width * scene.height);
  const twinkle = new Uint8Array(scene.width * scene.height);
  const alpha = (level: number) => Math.round((level / STAR_LEVELS) * 255);
  for (let y = 1; y < scene.height - 1; y++) {
    for (let x = 1; x < scene.width - 1; x++) {
      const across = (x - scene.width / 2) / scene.width;
      const distance =
        Math.hypot(x + 0.5 - scene.width / 2, y + 0.5 - (scene.peak + scene.radius)) - scene.radius;
      const altitude = smoothstep((distance - scene.starClearance) / (scene.starClearance * 2));
      const edge = smoothstep(
        Math.min(x, scene.width - 1 - x) / (scene.width * scene.edgeFade * 1.6),
      );
      const top = smoothstep(y / (scene.height * 0.22));
      const column = 0.3 + 0.7 * smoothstep((Math.abs(across) - 0.08) / 0.1);
      if (cellNoise(x, y, 1) >= (altitude * edge * top * column) / scene.starSpacing) continue;
      const size = cellNoise(x, y, 2);
      const level = size > 0.9 ? 3 : size > 0.6 ? 2 : 1;
      const mask = cellNoise(x, y, 3) < 1 / 6 ? twinkle : steady;
      mask[y * scene.width + x] = alpha(mask === twinkle ? Math.max(2, level) : level);
    }
  }
  return { steady, twinkle };
}

/** Mosaic shade (0..levels * MOSAIC_STEPS) mapped evenly to alpha (0..255). */
function mosaicAlpha(intensity: number, levels: number, x: number, y: number): number {
  const top = levels * MOSAIC_STEPS;
  return Math.round((mosaicShade(intensity, x, y, levels) / top) * 255);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * White gray+alpha PNG with one square tile per 4pt cell and a transparent hairline gap along
 * each cell's right and bottom edge (`mosaicGapPixels(density)` device pixels). Repeated tile
 * and gap rows use the Up filter, which zeroes them.
 */
function encode(alpha: Uint8Array, width: number, height: number, density: number) {
  const pitch = MOSAIC_CELL * density;
  const gap = mosaicGapPixels(density);
  const tile = pitch - gap;
  const w = width * pitch;
  const h = height * pitch;
  const stride = w * 2 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const py = y % pitch;
    if (py !== 0 && py !== tile) {
      raw[row] = 2;
      continue;
    }
    if (py === tile) {
      for (let x = 0; x < w; x++) raw[row + 1 + x * 2] = 255;
      continue;
    }
    const cy = (y / pitch) | 0;
    for (let cx = 0; cx < width; cx++) {
      const value = alpha[cy * width + cx]!;
      const base = row + 1 + cx * pitch * 2;
      for (let px = 0; px < tile; px++) {
        raw[base + px * 2] = 255;
        raw[base + px * 2 + 1] = value;
      }
      for (let px = tile; px < pitch; px++) {
        raw[base + px * 2] = 255;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 4;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const directory = new URL("../packages/client-runtime/assets/", import.meta.url);
NodeFS.mkdirSync(directory, { recursive: true });
for (const scene of scenes) {
  const glow = new Uint8Array(scene.width * scene.height);
  const rim = new Uint8Array(scene.width * scene.height);
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const value = sample(scene, x + 0.5, y + 0.5);
      glow[y * scene.width + x] = mosaicAlpha(value.glow, GLOW_LEVELS, x, y);
      rim[y * scene.width + x] = mosaicAlpha(value.rim, RIM_LEVELS, x, y);
    }
  }
  const stars = drawStars(scene);
  for (const [layer, alpha] of [
    ["glow", glow],
    ["rim", rim],
    ["stars", stars.steady],
    ["twinkle", stars.twinkle],
  ] as const) {
    for (const density of scene.densities) {
      const suffix = density === 1 ? "" : `@${density}x`;
      NodeFS.writeFileSync(
        new URL(`${scene.name}-${layer}${suffix}.png`, directory),
        encode(alpha, scene.width, scene.height, density),
      );
    }
  }
}

/**
 * The phone's new-chat smoke (the web draws the same field live on a canvas). Two masks:
 * the cloud, whose alpha shades blend the background into the harness tint, and its hot
 * core, tinted lighter. 4pt mosaic cells, anchored to the screen's lower right; 440×960pt
 * covers every phone, smaller screens crop the upper left.
 */
const SMOKE = { name: "new-chat-smoke-mobile", width: 110, height: 240, densities: [1, 2, 3] };
const smokeCloudRamp = mosaicAlphaRamp(SMOKE_MIXES);
const smokeCoreRamp = mosaicAlphaRamp([1]);
const SMOKE_TINT_TOP = SMOKE_MIXES.length * MOSAIC_STEPS;
{
  const shades = smokeMosaic(SMOKE.width, SMOKE.height);
  const cloud = new Uint8Array(shades.length);
  const core = new Uint8Array(shades.length);
  for (let index = 0; index < shades.length; index++) {
    const shade = shades[index]!;
    cloud[index] = smokeCloudRamp[Math.min(shade, SMOKE_TINT_TOP)]!;
    core[index] = shade > SMOKE_TINT_TOP ? smokeCoreRamp[shade - SMOKE_TINT_TOP]! : 0;
  }
  for (const [layer, alpha] of [
    ["cloud", cloud],
    ["core", core],
  ] as const) {
    for (const density of SMOKE.densities) {
      const suffix = density === 1 ? "" : `@${density}x`;
      NodeFS.writeFileSync(
        new URL(`${SMOKE.name}-${layer}${suffix}.png`, directory),
        encode(alpha, SMOKE.width, SMOKE.height, density),
      );
    }
  }
}

/**
 * What a phone chat keeps once it is open, and how it gets there. The embers are the cloud's
 * remainder settled in the lower right: one strip along the bottom that holds the corner's
 * mass. A strip up the right edge read as a stray line on a narrow phone, so there is none.
 * The settle slices cut the cloud mask into `SETTLE_SLICES` parts in dissolve order (the far
 * wisps first, the core last), each the same share of the cloud: hiding them one after another
 * dissolves the cloud as dither, like the web's canvas does tile by tile. Same frame as the
 * smoke, so they line up.
 */
const SETTLE_SLICES = 8;
const SETTLE_CORE_SLICES = [5, 6, 7];
/** A phone's embers, in points: the lower-right corner's mass and a little along the bottom. */
const PHONE_EMBER_EDGES = {
  corner: { reach: 300, strength: 1 },
  bottom: { reach: 110, strength: 0.5 },
} as const satisfies EmberEdges;
/** Each strip's depth in points: its farthest swell, rounded up to whole 4pt mosaic cells. */
const stripDepth = (reach: number) =>
  MOSAIC_CELL * Math.ceil((reach * EMBER_MAX_STRETCH) / MOSAIC_CELL);
const PHONE_EMBER_STRIPS = [
  {
    edge: "bottom",
    width: SMOKE.width * MOSAIC_CELL,
    // The corner's reach swells at most 1.25 times (see emberField).
    height: Math.max(
      stripDepth(PHONE_EMBER_EDGES.bottom.reach),
      MOSAIC_CELL * Math.ceil((PHONE_EMBER_EDGES.corner.reach * 1.25) / MOSAIC_CELL),
    ),
  },
] as const;
{
  const shades = smokeMosaic(SMOKE.width, SMOKE.height);
  const order = smokeDissolveOrder(SMOKE.width, SMOKE.height, shades);
  const layers: Array<readonly [string, Uint8Array]> = [];
  for (let slice = 0; slice < SETTLE_SLICES; slice++) {
    const alpha = new Uint8Array(shades.length);
    for (let index = 0; index < shades.length; index++) {
      const shade = shades[index]!;
      if (shade === 0) continue;
      if (Math.min(SETTLE_SLICES - 1, Math.floor(order[index]! * SETTLE_SLICES)) !== slice)
        continue;
      alpha[index] = smokeCloudRamp[Math.min(shade, SMOKE_TINT_TOP)]!;
    }
    layers.push([`new-chat-settle-mobile-${slice}`, alpha]);
  }
  // The hot core lies in the last slices; it goes out with them.
  for (const slice of SETTLE_CORE_SLICES) {
    const alpha = new Uint8Array(shades.length);
    for (let index = 0; index < shades.length; index++) {
      const shade = shades[index]!;
      if (shade <= SMOKE_TINT_TOP) continue;
      const at = Math.min(SETTLE_SLICES - 1, Math.floor(order[index]! * SETTLE_SLICES));
      if (Math.max(SETTLE_CORE_SLICES[0]!, at) === slice) {
        alpha[index] = smokeCoreRamp[shade - SMOKE_TINT_TOP]!;
      }
    }
    layers.push([`new-chat-settle-mobile-core-${slice}`, alpha]);
  }
  // Ember mosaic shades map the background-toward-tint ramp on a dark Mac background to alpha;
  // the phone lowers the strips' opacity on a light one.
  const emberRamp = mosaicAlphaRamp(EMBER_MIXES_DARK);
  if (emberRamp.length !== EMBER_TONES * MOSAIC_STEPS + 1) {
    throw new Error("ember steps out of date");
  }
  const strips = [];
  for (const strip of PHONE_EMBER_STRIPS) {
    // The whole frame lit, so the strip shares the cloud's grain; the lower-right corner's
    // mass rides on the bottom strip, which is deep enough to hold it.
    const embers = emberMosaic(SMOKE.width, SMOKE.height, MOSAIC_CELL, PHONE_EMBER_EDGES);
    const columns = strip.width / MOSAIC_CELL;
    const rows = strip.height / MOSAIC_CELL;
    const left = 0;
    const top = SMOKE.height - rows;
    const alpha = new Uint8Array(columns * rows);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const shade = embers[(top + row) * SMOKE.width + left + column]!;
        alpha[row * columns + column] = emberRamp[shade]!;
      }
    }
    strips.push([`new-chat-embers-mobile-${strip.edge}`, alpha, columns, rows] as const);
  }
  for (const [name, alpha, columns, rows] of strips) {
    for (const density of SMOKE.densities) {
      const suffix = density === 1 ? "" : `@${density}x`;
      NodeFS.writeFileSync(
        new URL(`${name}${suffix}.png`, directory),
        encode(alpha, columns, rows, density),
      );
    }
  }
  for (const [name, alpha] of layers) {
    for (const density of SMOKE.densities) {
      const suffix = density === 1 ? "" : `@${density}x`;
      NodeFS.writeFileSync(
        new URL(`${name}${suffix}.png`, directory),
        encode(alpha, SMOKE.width, SMOKE.height, density),
      );
    }
  }
}

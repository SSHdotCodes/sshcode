import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import {
  EMBER_MIXES_DARK,
  MOSAIC_CELL,
  MOSAIC_STEPS,
  SMOKE_MIXES,
  mosaicAlphaRamp,
  mosaicGapPixels,
} from "@t3tools/client-runtime/new-chat-smoke";
import { describe, expect, it } from "vite-plus/test";

/** Decodes the generator's white gray+alpha PNGs, which use only the None and Up filters. */
function readMask(name: string) {
  const png = NodeFS.readFileSync(
    new URL(`../../../../../packages/client-runtime/assets/${name}.png`, import.meta.url),
  );
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([png[24], png[25]]).toEqual([8, 4]);
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 2 + 1;
  const alpha = new Uint8Array(width * height);
  const previous = new Uint8Array(width * 2);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    if (filter !== 0 && filter !== 2) throw new Error(`Unexpected PNG filter ${filter}`);
    for (let i = 0; i < width * 2; i++) {
      const value = raw[y * stride + 1 + i]! + (filter === 2 ? previous[i]! : 0);
      previous[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      if (previous[x * 2] !== 255) throw new Error("Masks must stay white so clients can tint");
      alpha[y * width + x] = previous[x * 2 + 1]!;
    }
  }
  return { width, height, alpha };
}

const evenLevels = (steps: number) =>
  new Set(Array.from({ length: steps + 1 }, (_, step) => Math.round((step / steps) * 255)));

/**
 * Verifies every cell in a mosaic mask: uniform allowed shade inside its square tile, and a
 * transparent hairline gap (`gap` pixels) along each cell's right and bottom edge.
 */
function assertMosaicGrid(
  mask: { width: number; height: number; alpha: Uint8Array },
  density: number,
  allowed: ReadonlySet<number>,
  label: string,
): number {
  const pitch = MOSAIC_CELL * density;
  const gap = mosaicGapPixels(density);
  const tile = pitch - gap;
  expect(mask.width % pitch).toBe(0);
  expect(mask.height % pitch).toBe(0);
  let litCells = 0;
  for (let y = 0; y < mask.height; y++) {
    const py = y % pitch;
    const cy = (y / pitch) | 0;
    for (let x = 0; x < mask.width; x++) {
      const px = x % pitch;
      const value = mask.alpha[y * mask.width + x]!;
      if (px >= tile || py >= tile) {
        if (value !== 0) {
          throw new Error(`${label}: lit pixel inside hairline gap at ${x}, ${y} (${value})`);
        }
        continue;
      }
      const origin = cy * pitch * mask.width + ((x / pitch) | 0) * pitch;
      if (!allowed.has(value) || value !== mask.alpha[origin]) {
        throw new Error(`${label}: soft or misaligned tile at ${x}, ${y} (${value})`);
      }
      if (px === 0 && py === 0 && value > 0) litCells++;
    }
  }
  return litCells;
}

describe("chat backdrop masks", () => {
  it.each([
    ["new-chat-horizon", 2048, 896, 1],
    ["new-chat-horizon@2x", 4096, 1792, 2],
    ["new-chat-horizon-mobile", 440, 400, 1],
    ["new-chat-horizon-mobile@2x", 880, 800, 2],
    ["new-chat-horizon-mobile@3x", 1320, 1200, 3],
  ] as const)(
    "keeps %s in crisp mosaic tiles with hairlines and no edge seam",
    (name, width, height, density) => {
      const [base, densitySuffix = ""] = name.split("@");
      const cells = (width / (MOSAIC_CELL * density)) * (height / (MOSAIC_CELL * density));
      for (const [layer, steps] of [
        ["glow", 4 * MOSAIC_STEPS],
        ["rim", 3 * MOSAIC_STEPS],
        ["stars", 3],
        ["twinkle", 3],
      ] as const) {
        const mask = readMask(`${base}-${layer}${densitySuffix ? `@${densitySuffix}` : ""}`);
        expect([mask.width, mask.height]).toEqual([width, height]);
        const litCells = assertMosaicGrid(mask, density, evenLevels(steps), `${name} ${layer}`);
        // A transparent border means no seam where the fixed-size art ends.
        for (let x = 0; x < width; x++) expect(mask.alpha[x]).toBe(0);
        for (let y = 0; y < height; y++) {
          expect(mask.alpha[y * width]).toBe(0);
          expect(mask.alpha[y * width + width - 1]).toBe(0);
        }
        const coverage = litCells / cells;
        if (layer === "stars" || layer === "twinkle") {
          // Sparse single-tile stars: present, yet never competing with the text over them.
          expect(coverage).toBeGreaterThan(0.0001);
          expect(coverage).toBeLessThan(0.01);
        } else {
          expect(coverage).toBeGreaterThan(0.02);
          expect(coverage).toBeLessThan(layer === "glow" ? 0.7 : 0.25);
        }
      }
    },
  );

  it("draws the same tile shades at every density", () => {
    for (const [base, densities] of [
      ["new-chat-horizon", [2]],
      ["new-chat-horizon-mobile", [2, 3]],
    ] as const) {
      for (const layer of ["glow", "rim", "stars", "twinkle"]) {
        const oneX = readMask(`${base}-${layer}`);
        const columns = oneX.width / MOSAIC_CELL;
        const rows = oneX.height / MOSAIC_CELL;
        for (const density of densities) {
          const hi = readMask(`${base}-${layer}@${density}x`);
          const pitch = MOSAIC_CELL * density;
          for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < columns; cx++) {
              const a = oneX.alpha[cy * MOSAIC_CELL * oneX.width + cx * MOSAIC_CELL];
              const b = hi.alpha[cy * pitch * hi.width + cx * pitch];
              if (a !== b)
                throw new Error(`${base}-${layer}@${density}x differs at cell ${cx}, ${cy}`);
            }
          }
        }
      }
    }
  });

  it.each([
    ["", 440, 960, 1],
    ["@2x", 880, 1920, 2],
    ["@3x", 1320, 2880, 3],
  ] as const)(
    "keeps the phone's smoke%s in crisp mosaic tiles of its shades",
    (densitySuffix, width, height, density) => {
      const cloudAllowed = new Set(mosaicAlphaRamp(SMOKE_MIXES));
      const coreAllowed = new Set(mosaicAlphaRamp([1]));
      for (const [layer, allowed] of [
        ["cloud", cloudAllowed],
        ["core", coreAllowed],
      ] as const) {
        const mask = readMask(`new-chat-smoke-mobile-${layer}${densitySuffix}`);
        expect([mask.width, mask.height]).toEqual([width, height]);
        const litCells = assertMosaicGrid(mask, density, allowed, `smoke ${layer}${densitySuffix}`);
        expect(litCells).toBeGreaterThan(0);
      }
    },
  );

  it("cuts the phone's cloud into settle slices that add back up to it, core last", () => {
    const cloud = readMask("new-chat-smoke-mobile-cloud");
    const core = readMask("new-chat-smoke-mobile-core");
    const slices = Array.from({ length: 8 }, (_, slice) =>
      readMask(`new-chat-settle-mobile-${slice}`),
    );
    const coreSlices = [5, 6, 7].map((slice) => readMask(`new-chat-settle-mobile-core-${slice}`));
    const sizes = slices.map((slice) => slice.alpha.filter((value) => value > 0).length);
    // One expect per pixel made this take seconds; collect the misses and check once.
    const misses: number[] = [];
    for (let index = 0; index < cloud.alpha.length; index++) {
      // Every lit pixel is in exactly one slice, at the cloud's own shade.
      let parts = 0;
      let shade = 0;
      for (const slice of slices) {
        if (slice.alpha[index]! > 0) {
          parts++;
          shade = slice.alpha[index]!;
        }
      }
      let coreParts = 0;
      let coreShade = 0;
      for (const slice of coreSlices) {
        if (slice.alpha[index]! > 0) {
          coreParts++;
          coreShade = slice.alpha[index]!;
        }
      }
      const lit = cloud.alpha[index]! > 0;
      const coreLit = core.alpha[index]! > 0;
      if (
        parts !== (lit ? 1 : 0) ||
        (lit && shade !== cloud.alpha[index]) ||
        coreParts !== (coreLit ? 1 : 0) ||
        (coreLit && coreShade !== core.alpha[index])
      ) {
        misses.push(index);
      }
    }
    expect(misses).toEqual([]);
    // Even shares, so the cloud thins at a steady rate.
    for (const size of sizes) expect(size / sizes[0]!).toBeCloseTo(1, 1);
  });

  it.each([
    ["", 1],
    ["@2x", 2],
    ["@3x", 3],
  ] as const)(
    "keeps the phone's embers%s in mosaic tiles settled in the lower right",
    (densitySuffix, density) => {
      const allowed = new Set(mosaicAlphaRamp(EMBER_MIXES_DARK));
      const strips = { bottom: [440, 376] } as const;
      for (const [edge, [width, height]] of Object.entries(strips)) {
        const mask = readMask(`new-chat-embers-mobile-${edge}${densitySuffix}`);
        expect([mask.width, mask.height]).toEqual([width * density, height * density]);
        assertMosaicGrid(mask, density, allowed, `embers ${edge}${densitySuffix}`);
        const at = (x: number, y: number) => mask.alpha[y * mask.width + x]!;
        let left = 0;
        let right = 0;
        for (let y = 0; y < mask.height; y++) {
          for (let x = 0; x < mask.width; x++) {
            const value = at(x, y);
            if (x < mask.width / 2) left += value;
            else right += value;
          }
        }
        // Heavier toward the right, and faded out before the strip's inner end.
        expect(right).toBeGreaterThan(left);
        for (let k = 0; k < mask.width; k++) {
          const value = at(k, 0);
          if (value !== 0) throw new Error(`embers ${edge}${densitySuffix}: lit at its inner end`);
        }
      }
    },
  );

  it("keeps single-tile stars in the sky, clear of the arc's light", () => {
    for (const scene of ["new-chat-horizon", "new-chat-horizon-mobile"]) {
      const glow = readMask(`${scene}-glow`);
      const columns = glow.width / MOSAIC_CELL;
      const rows = glow.height / MOSAIC_CELL;
      for (const layer of ["stars", "twinkle"]) {
        const stars = readMask(`${scene}-${layer}`);
        for (let cy = 0; cy < rows; cy++) {
          for (let cx = 0; cx < columns; cx++) {
            const index = cy * MOSAIC_CELL * stars.width + cx * MOSAIC_CELL;
            if (stars.alpha[index]! > 0 && glow.alpha[index]! > 128) {
              throw new Error(`${scene} ${layer}: a star sits in the arc's light at ${cx}, ${cy}`);
            }
          }
        }
      }
    }
  });
});

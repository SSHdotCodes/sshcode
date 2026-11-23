import { describe, expect, it } from "vite-plus/test";

import {
  EMBER_MIXES_DARK,
  EMBER_TONES,
  EMBER_WAVE_SECONDS,
  MOSAIC_CELL,
  MOSAIC_STEPS,
  SMOKE_MIXES,
  SMOKE_TONES,
  emberField,
  emberMosaic,
  emberRamp,
  emberTones,
  emberTonesAt,
  mosaicAlphaRamp,
  mosaicGapPixels,
  mosaicShade,
  smokeDissolveOrder,
  smokeMosaic,
  smokeRamp,
  smokeTones,
} from "./newChatSmoke.ts";

/** A deep equal over a few hundred thousand cells took seconds under load; this is instant. */
const sameCells = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

describe("new chat smoke", () => {
  const columns = 390;
  const rows = 280;
  const tones = smokeTones(columns, rows);
  const mean = (left: number, top: number, width: number, height: number) => {
    let sum = 0;
    for (let row = top; row < top + height; row++) {
      for (let column = left; column < left + width; column++)
        sum += tones[row * columns + column]!;
    }
    return sum / (width * height);
  };

  it("draws the same scene every time", () => {
    expect(sameCells(smokeTones(columns, rows), tones)).toBe(true);
  });

  it("lights the lower right, keeps the upper middle dark, and reaches the hot core", () => {
    expect(mean(300, 210, 90, 70)).toBeGreaterThan(2.5);
    expect(mean(110, 20, 100, 60)).toBeLessThan(0.3);
    expect(tones.some((tone) => tone === SMOKE_TONES)).toBe(true);
    expect(tones.every((tone) => tone <= SMOKE_TONES)).toBe(true);
  });

  it("blends the background into the tint, then the core", () => {
    const ramp = smokeRamp([200, 100, 50], [0, 0, 0], [250, 200, 180]);
    expect(ramp).toEqual([
      [40, 20, 10],
      [84, 42, 21],
      [128, 64, 32],
      [164, 82, 41],
      [250, 200, 180],
    ]);
  });
});

describe("open chat embers", () => {
  // A 1024x748 chat area in 2px cells.
  const columns = 512;
  const rows = 374;
  const tones = emberTones(columns, rows, 2);
  const mean = (left: number, top: number, width: number, height: number) => {
    let sum = 0;
    for (let row = top; row < top + height; row++) {
      for (let x = left; x < left + width; x++) sum += tones[row * columns + x]!;
    }
    return sum / (width * height);
  };

  it("leaves the middle plain, where the conversation is read", () => {
    expect(mean(120, 60, columns - 240, rows - 220)).toBe(0);
  });

  it("settles in the lower right, where the cloud was, and leaves the top and left plain", () => {
    const corner = (left: number, top: number) => mean(left, top, 60, 60);
    const lowerRight = corner(columns - 60, rows - 60);
    expect(lowerRight).toBeGreaterThan(1);
    expect(corner(0, rows - 60)).toBeLessThan(lowerRight / 5);
    expect(mean(0, 0, columns, 40)).toBe(0);
    expect(mean(0, 0, 40, rows - 60)).toBe(0);
  });

  it("climbs only the lower half of the right edge, never a ribbon up it", () => {
    expect(mean(columns - 30, 0, 30, Math.round(rows * 0.35))).toBe(0);
    expect(mean(columns - 30, Math.round(rows * 0.6), 30, Math.round(rows * 0.4))).toBeGreaterThan(
      0,
    );
  });

  it("stays in the lower right of a narrow window too", () => {
    // 760px wide: the left half holds the trail along the bottom, well short of the corner.
    const narrow = emberTones(380, rows, 2);
    const half = (from: number) => {
      let sum = 0;
      for (let row = 0; row < rows; row++) {
        for (let column = from; column < from + 190; column++) sum += narrow[row * 380 + column]!;
      }
      return sum;
    };
    expect(half(0)).toBeLessThan(half(190) * 0.6);
  });

  it("never ends in a straight line: how far the bottom glow climbs varies along it", () => {
    const depths: number[] = [];
    for (let x = 120; x < columns - 120; x++) {
      let depth = 0;
      for (let row = rows - 1; row > rows / 2; row--)
        if (tones[row * columns + x]! > 0) depth = rows - row;
      depths.push(depth);
    }
    expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(20);
  });

  it("keeps to three tones: real colour in the dense pockets on dark, lighter on light", () => {
    expect(tones.reduce((most, tone) => Math.max(most, tone), 0)).toBe(EMBER_TONES);
    expect(emberRamp([200, 100, 0], [0, 0, 0])).toEqual([
      [20, 10, 0],
      [50, 25, 0],
      [100, 50, 0],
    ]);
    expect(emberRamp([200, 100, 0], [255, 255, 255])).toEqual([
      [251, 243, 235],
      [245, 227, 209],
      [239, 209, 179],
    ]);
  });

  it("keeps the dither even in the hottest pocket: no solid 8x8 block of the top tone", () => {
    for (const [width, height] of [
      [512, 374],
      [900, 520],
      [380, 374],
    ] as const) {
      const grid = emberTones(width, height, 2);
      for (let top = 0; top + 8 <= height; top += 8) {
        for (let left = 0; left + 8 <= width; left += 8) {
          let top3 = 0;
          for (let row = top; row < top + 8; row++) {
            for (let column = left; column < left + 8; column++) {
              if (grid[row * width + column] === EMBER_TONES) top3++;
            }
          }
          if (top3 === 64) throw new Error(`solid block at ${left},${top} in ${width}x${height}`);
        }
      }
    }
  });

  it("draws the same embers every time", () => {
    expect(sameCells(emberTones(columns, rows, 2), tones)).toBe(true);
  });
});

describe("working embers", () => {
  const columns = 512;
  const rows = 374;
  const field = emberField(columns, rows, 2);
  const still = emberTones(columns, rows, 2);
  const at = (time: number, swell: number, gain = 1) => {
    const tones = new Uint8Array(columns * rows);
    emberTonesAt(field, time, swell, gain, tones);
    return tones;
  };

  it("matches the still embers with no swell", () => {
    expect(sameCells(at(0, 0), still)).toBe(true);
    expect(sameCells(at(1.3, 0), still)).toBe(true);
  });

  it("moves while working, only among the embers' own cells", () => {
    const a = at(0, 0.22);
    const b = at(EMBER_WAVE_SECONDS / 2, 0.22);
    const own = new Uint8Array(columns * rows);
    for (const index of field.cells) own[index] = 1;
    let changed = 0;
    let strays = 0;
    for (let index = 0; index < a.length; index++) {
      if (own[index] === 0) {
        if (a[index] !== 0 || b[index] !== 0) strays++;
      } else if (a[index] !== b[index]) {
        changed++;
      }
    }
    expect(strays).toBe(0);
    // Visible, but the corner keeps its shape: a minority of the lit cells change.
    expect(changed / field.cells.length).toBeGreaterThan(0.05);
    expect(changed / field.cells.length).toBeLessThan(0.6);
  });

  it("rolls its crests out of the corner", () => {
    // Phase falls with distance from the lower-right corner, so crests travel outward.
    let near = 0;
    let far = 0;
    let nearCount = 0;
    let farCount = 0;
    for (let lit = 0; lit < field.cells.length; lit++) {
      const index = field.cells[lit]!;
      const x = index % columns;
      const y = Math.floor(index / columns);
      const distance = Math.hypot(columns - x, rows - y);
      if (distance < 60) {
        near += field.phase[lit]!;
        nearCount++;
      } else if (distance > 140) {
        far += field.phase[lit]!;
        farCount++;
      }
    }
    expect(near / nearCount).toBeGreaterThan(far / farCount);
  });

  it("flares brighter when the agent needs you", () => {
    const flared = at(0, 0, 1.4);
    let brighter = 0;
    for (let index = 0; index < still.length; index++)
      if (flared[index]! > still[index]!) brighter++;
    expect(brighter).toBeGreaterThan(field.cells.length * 0.2);
  });
});

describe("cloud dissolve order", () => {
  const columns = 200;
  const rows = 140;
  const tones = smokeTones(columns, rows);
  const order = smokeDissolveOrder(columns, rows, tones);
  const litOrders = (left: number, top: number, width: number, height: number) => {
    const values: number[] = [];
    for (let row = top; row < top + height; row++) {
      for (let column = left; column < left + width; column++) {
        if (tones[row * columns + column]! > 0) values.push(order[row * columns + column]!);
      }
    }
    return values;
  };
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  it("spreads the lit cells evenly from 0 to 1, so the cloud thins at a steady rate", () => {
    const lit = litOrders(0, 0, columns, rows).sort((left, right) => left - right);
    expect(lit[0]).toBe(0);
    expect(lit.at(-1)).toBe(1);
    const half = lit.filter((value) => value < 0.5).length / lit.length;
    expect(half).toBeGreaterThan(0.49);
    expect(half).toBeLessThan(0.51);
  });

  it("lets the far wisps go first and the core in the lower right last", () => {
    expect(mean(litOrders(150, 100, 50, 40))).toBeGreaterThan(
      mean(litOrders(60, 30, 50, 40)) + 0.2,
    );
  });
});

describe("dithered tile mosaic", () => {
  it("keeps hairline gaps at least 1 device pixel at every density", () => {
    expect(mosaicGapPixels(1)).toBe(1);
    expect(mosaicGapPixels(2)).toBe(1);
    expect(mosaicGapPixels(3)).toBe(2);
  });

  it("frays thin light in Bayer order and shades the body up to levels * MOSAIC_STEPS", () => {
    const levels = 3;
    const top = levels * MOSAIC_STEPS;
    expect(mosaicShade(0, 0, 0, levels)).toBe(0);
    let thinLit = 0;
    let midMin = top;
    let midMax = 0;
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        const thin = mosaicShade(0.1, column, row, levels);
        if (thin > 0) thinLit++;
        const mid = mosaicShade(0.5, column, row, levels);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThanOrEqual(top);
        midMin = Math.min(midMin, mid);
        midMax = Math.max(midMax, mid);
      }
    }
    expect(thinLit).toBeGreaterThan(0);
    expect(thinLit).toBeLessThan(64);
    expect(midMax).toBeGreaterThan(midMin);
  });

  it("spreads opacity stops evenly across mosaic shades", () => {
    const smokeAlphas = mosaicAlphaRamp(SMOKE_MIXES);
    expect(smokeAlphas.length).toBe(SMOKE_MIXES.length * MOSAIC_STEPS + 1);
    expect(smokeAlphas[0]).toBe(0);
    expect(smokeAlphas[MOSAIC_STEPS]).toBe(51);
    expect(smokeAlphas[2 * MOSAIC_STEPS]).toBe(107);
    expect(smokeAlphas[3 * MOSAIC_STEPS]).toBe(163);
    expect(smokeAlphas[4 * MOSAIC_STEPS]).toBe(209);
    const emberAlphas = mosaicAlphaRamp(EMBER_MIXES_DARK);
    expect(emberAlphas[emberAlphas.length - 1]).toBe(128);
  });

  it("generates smoke and ember mosaic fields in range", () => {
    const smoke = smokeMosaic(88, 192);
    expect(smoke.some((shade) => shade === SMOKE_TONES * MOSAIC_STEPS)).toBe(true);
    expect(smoke.every((shade) => shade <= SMOKE_TONES * MOSAIC_STEPS)).toBe(true);
    const embers = emberMosaic(88, 192, MOSAIC_CELL);
    expect(embers.some((shade) => shade > 0)).toBe(true);
    expect(embers.every((shade) => shade <= EMBER_TONES * MOSAIC_STEPS)).toBe(true);
  });
});

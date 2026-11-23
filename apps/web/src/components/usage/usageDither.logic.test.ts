import { describe, expect, it } from "vite-plus/test";
import { AREA_BAND_ROWS, areaCells, areaLevel } from "./usageDither.logic";

describe("areaLevel", () => {
  it("is solid along the edge, then thins toward the baseline without emptying", () => {
    for (let depth = 0; depth < AREA_BAND_ROWS; depth++) expect(areaLevel(depth, 40)).toBe(1);
    const levels = Array.from({ length: 38 }, (_, index) => areaLevel(index + AREA_BAND_ROWS, 40));
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]!);
    }
    expect(levels[0]).toBeLessThan(1);
    expect(levels.at(-1)!).toBeGreaterThan(0.05);
  });
});

describe("areaCells", () => {
  // 1 column, 8 rows. Back area covers rows 2–7, front area rows 5–7.
  const column = (rows: number[]) =>
    Uint8Array.from({ length: 8 }, (_, row) => +rows.includes(row));
  const back = column([2, 3, 4, 5, 6, 7]);
  const front = column([5, 6, 7]);

  it("gives covered cells to the area in front, and keeps every area's top band", () => {
    const [behind, ahead] = areaCells([back, front], 1, 8);
    expect([...behind!.band]).toEqual([2]);
    expect([...behind!.fill]).toEqual([3, 4]);
    expect([...ahead!.band]).toEqual([5]);
    expect([...ahead!.fill]).toEqual([6, 7]);
  });

  it("measures each area's fade from its own top edge", () => {
    const [behind] = areaCells([back], 1, 8);
    expect([...behind!.fill]).toEqual([3, 4, 5, 6, 7]);
    expect(behind!.fillLevel[0]).toBeCloseTo(areaLevel(1, 6));
    expect(behind!.fillLevel[4]).toBeCloseTo(areaLevel(5, 6));
  });

  it("keeps a steep edge connected down to the lower neighbour's top", () => {
    // 2 columns, 10 rows: the left column starts at row 1, the right one at row 6.
    const mask = new Uint8Array(20);
    for (let row = 1; row < 10; row++) mask[row * 2] = 1;
    for (let row = 6; row < 10; row++) mask[row * 2 + 1] = 1;
    const [area] = areaCells([mask], 2, 10);
    const leftBand = [...area!.band].filter((cell) => cell % 2 === 0).map((cell) => cell / 2);
    expect(leftBand).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips columns an area does not reach", () => {
    const [empty] = areaCells([new Uint8Array(8)], 1, 8);
    expect(empty!.fill.length + empty!.band.length).toBe(0);
  });
});

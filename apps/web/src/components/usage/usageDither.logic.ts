import {
  bayerThreshold,
  MOSAIC_CELL,
  MOSAIC_GAP,
  MOSAIC_STEPS,
  mosaicGapPixels,
  mosaicShade,
} from "@t3tools/client-runtime/new-chat-smoke";

export { bayerThreshold, MOSAIC_CELL, MOSAIC_GAP, MOSAIC_STEPS, mosaicGapPixels, mosaicShade };

/** Tone levels per series in usage mosaic canvases (`USAGE_MOSAIC_LEVELS * MOSAIC_STEPS` shades). */
export const USAGE_MOSAIC_LEVELS = 3;

/** Rows of top-edge tiles along an area's curve: one 5px tile row reads as a crisp line. */
export const AREA_BAND_ROWS = 1;
const AREA_PEAK = 0.68;
const AREA_FLOOR = 0.08;
const AREA_CURVE = 1.35;

/**
 * How lit an area's tile is, `depth` rows under the area's top edge in a column
 * whose area is `span` rows tall: solid along the edge, then thinning and fraying
 * toward the baseline without ever emptying, so a tall area keeps its shape to the bottom.
 */
export function areaLevel(depth: number, span: number): number {
  if (depth < AREA_BAND_ROWS) return 1;
  const fall = Math.min(1, (depth - AREA_BAND_ROWS) / Math.max(1, span - AREA_BAND_ROWS));
  return AREA_FLOOR + (AREA_PEAK - AREA_FLOOR) * (1 - fall) ** AREA_CURVE;
}

export interface AreaCells {
  /** Cell indices below the top band that this area shows: no area in front covers them. */
  readonly fill: Int32Array;
  /** The level each `fill` cell reaches, before the reveal. */
  readonly fillLevel: Float32Array;
  /** The top band's cells, drawn over everything so a covered area's edge still shows. */
  readonly band: Int32Array;
}

/**
 * Splits a grid among areas listed back to front. `inside[area][row * columns + column]`
 * is non-zero where the area covers the cell's centre. A cell's fill belongs to the
 * front-most area covering it; every area's top band stays visible.
 */
export function areaCells(
  inside: ReadonlyArray<Uint8Array>,
  columns: number,
  rows: number,
): AreaCells[] {
  const owner = new Int16Array(columns * rows).fill(-1);
  inside.forEach((mask, area) => {
    for (let cell = 0; cell < mask.length; cell++) if (mask[cell]) owner[cell] = area;
  });
  return inside.map((mask, area) => {
    const tops = new Int32Array(columns).fill(-1);
    const bottoms = new Int32Array(columns).fill(-1);
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        if (!mask[row * columns + column]) continue;
        if (tops[column]! < 0) tops[column] = row;
        bottoms[column] = row;
      }
    }
    const fill: number[] = [];
    const fillLevel: number[] = [];
    const band: number[] = [];
    for (let column = 0; column < columns; column++) {
      const top = tops[column]!;
      if (top < 0) continue;
      const bottom = bottoms[column]!;
      // On a steep slope the edge runs down to the lower neighbour's top, so it stays one
      // connected line instead of breaking into steps.
      let bandEnd = top + AREA_BAND_ROWS - 1;
      for (const neighbour of [column - 1, column + 1]) {
        const neighbourTop = neighbour < 0 || neighbour >= columns ? -1 : tops[neighbour]!;
        if (neighbourTop > 0) bandEnd = Math.max(bandEnd, neighbourTop - 1);
      }
      const span = bottom - top + 1;
      for (let row = top; row <= bottom; row++) {
        const cell = row * columns + column;
        if (!mask[cell]) continue;
        if (row <= bandEnd) band.push(cell);
        else if (owner[cell] === area) {
          fill.push(cell);
          fillLevel.push(areaLevel(row - top, span));
        }
      }
    }
    return {
      fill: Int32Array.from(fill),
      fillLevel: Float32Array.from(fillLevel),
      band: Int32Array.from(band),
    };
  });
}

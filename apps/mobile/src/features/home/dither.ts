/**
 * Dithered tile mosaic for the home screen's sky and charts, drawn as SVG paths.
 *
 * Every tile sits on a 4pt (`MOSAIC_CELL`) pitch separated by a hairline gap (`mosaicGap`)
 * sized to whole device pixels at 1x, 2x and 3x, so tiles stay square and hairlines stay
 * crisp without smoothing. Within the body of the light, tiles pick between three shades per
 * tone in Bayer order; where the light thins, tiles fray out in Bayer order.
 */
import {
  bayerThreshold,
  MOSAIC_CELL,
  MOSAIC_GAP,
  MOSAIC_STEPS,
  mosaicGapPixels,
  mosaicShade,
} from "@t3tools/client-runtime/new-chat-smoke";

/** Pitch of one mosaic tile, in points. */
export const DOT = MOSAIC_CELL;

/** Tone levels per colour in SVG mosaic surfaces (`MOSAIC_LEVELS * MOSAIC_STEPS` shades). */
export const MOSAIC_LEVELS = 3;
const MOSAIC_TOP = MOSAIC_LEVELS * MOSAIC_STEPS;

/** The 8×8 Bayer threshold in (0, 1) at grid `column`, `row`. */
export const ditherThreshold = bayerThreshold;

/** Snaps a length in points down to the tile grid. */
export function snapToDots(points: number): number {
  return Math.max(0, Math.floor(points / DOT) * DOT);
}

/** Hairline gap width in points for a screen pixel ratio: whole device pixels, at least 1. */
export function mosaicGap(pixelRatio = 2): number {
  return mosaicGapPixels(pixelRatio) / pixelRatio;
}

export interface DitherShare {
  readonly color: string;
  readonly share: number;
}

export interface DitherLayer {
  readonly color: string;
  /** Shade opacity in (0, 1]: each mosaic shade sits in its own path. */
  readonly opacity: number;
  /** Which reveal step the tiles belong to: the dither's own order, sparse tiles first. */
  readonly slice: number;
  readonly d: string;
}

/**
 * Collects mosaic tiles into one path per colour, shade and reveal slice. A box's tiles split
 * between its colours by share: each tile's threshold picks a colour from the running shares,
 * so every colour spreads evenly over the box instead of stacking in bands.
 */
export class DitherCanvas {
  private readonly slices: number;
  private readonly side: number;
  private readonly parts = new Map<
    string,
    { color: string; opacity: number; slice: number; d: string[] }
  >();

  constructor(slices = 1, gap = MOSAIC_GAP) {
    this.slices = slices;
    this.side = Number((DOT - gap).toFixed(4));
  }

  private tile(color: string, opacity: number, slice: number, x: number, y: number) {
    const key = `${slice}|${opacity}|${color}`;
    let layer = this.parts.get(key);
    if (!layer) {
      layer = { color, opacity, slice, d: [] };
      this.parts.set(key, layer);
    }
    layer.d.push(`M${x} ${y}h${this.side}v${this.side}h-${this.side}z`);
  }

  /**
   * Fills the box at (x, y), `width` by `height` points, at `density` from 0 to 1.
   * `density` may be a function of the tile's position within the box (0 at the top or
   * left, 1 at the bottom or right) for a gradient.
   */
  box(
    x: number,
    y: number,
    width: number,
    height: number,
    density: number | ((across: number, down: number) => number),
    colors: ReadonlyArray<DitherShare>,
  ) {
    const total = colors.reduce((sum, entry) => sum + Math.max(0, entry.share), 0);
    if (total <= 0 || width <= 0 || height <= 0) return;
    const firstColumn = Math.round(x / DOT);
    const firstRow = Math.round(y / DOT);
    const columns = Math.max(1, Math.round(width / DOT));
    const rows = Math.max(1, Math.round(height / DOT));
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const level =
          typeof density === "number"
            ? density
            : density(
                columns === 1 ? 0 : column / (columns - 1),
                rows === 1 ? 0 : row / (rows - 1),
              );
        if (level <= 0) continue;
        const gc = firstColumn + column;
        const gr = firstRow + row;
        const shade = mosaicShade(level, gc, gr, MOSAIC_LEVELS);
        if (shade === 0) continue;
        const threshold = ditherThreshold(gc, gr);
        let color = colors[colors.length - 1]!.color;
        if (colors.length > 1) {
          let running = 0;
          for (const entry of colors) {
            running += Math.max(0, entry.share) / total;
            if (threshold < running) {
              color = entry.color;
              break;
            }
          }
        }
        const slice = Math.min(this.slices - 1, Math.floor(threshold * this.slices));
        this.tile(color, shade / MOSAIC_TOP, slice, x + column * DOT, y + row * DOT);
      }
    }
  }

  /**
   * Fills the box at `density`, its colours side by side in whole tile columns by share,
   * largest first: a mixed day reads as bands, not speckle. With `even`, every tile lights
   * at `density` as its opacity: a heatmap day, where a missing tile reads as a glitch.
   */
  columns(
    x: number,
    y: number,
    width: number,
    height: number,
    density: number,
    colors: ReadonlyArray<DitherShare>,
    even = false,
  ) {
    const total = colors.reduce((sum, entry) => sum + Math.max(0, entry.share), 0);
    const columns = Math.round(width / DOT);
    if (total <= 0 || columns <= 0) return;
    let start = 0;
    colors.forEach((entry, index) => {
      const last = index === colors.length - 1;
      const span = last
        ? columns - start
        : Math.max(1, Math.round((Math.max(0, entry.share) / total) * columns));
      const used = Math.min(span, columns - start);
      if (used <= 0) return;
      if (even) this.solid(x + start * DOT, y, used * DOT, height, entry.color, density);
      else
        this.box(x + start * DOT, y, used * DOT, height, density, [
          { color: entry.color, share: 1 },
        ]);
      start += used;
    });
  }

  /**
   * Tiles over a `columns` by `rows` grid from the origin, each with its own density and
   * colour: for fields like the home sky, where colour changes across one shape.
   */
  paint(
    columns: number,
    rows: number,
    density: (column: number, row: number) => number,
    color: (column: number, row: number) => string,
  ) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const level = density(column, row);
        if (level <= 0) continue;
        const shade = mosaicShade(level, column, row, MOSAIC_LEVELS);
        if (shade === 0) continue;
        const slice = Math.min(
          this.slices - 1,
          Math.floor(ditherThreshold(column, row) * this.slices),
        );
        this.tile(color(column, row), shade / MOSAIC_TOP, slice, column * DOT, row * DOT);
      }
    }
  }

  /** One tile at grid `column`, `row`, in the reveal `slice` and `opacity` the caller picks. */
  dotAt(column: number, row: number, slice: number, color: string, opacity = 1) {
    this.tile(
      color,
      opacity,
      Math.max(0, Math.min(this.slices - 1, slice)),
      column * DOT,
      row * DOT,
    );
  }

  /** A solid run of tiles at one `opacity`, for heatmap days or a leading edge. */
  solid(x: number, y: number, width: number, height: number, color: string, opacity = 1) {
    if (width <= 0 || height <= 0 || opacity <= 0) return;
    const firstColumn = Math.round(x / DOT);
    const firstRow = Math.round(y / DOT);
    const columns = Math.max(1, Math.round(width / DOT));
    const rows = Math.max(1, Math.round(height / DOT));
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const gc = firstColumn + column;
        const gr = firstRow + row;
        const slice = Math.min(this.slices - 1, Math.floor(ditherThreshold(gc, gr) * this.slices));
        this.tile(color, opacity, slice, x + column * DOT, y + row * DOT);
      }
    }
  }

  layers(): DitherLayer[] {
    const layers: DitherLayer[] = [];
    for (const layer of this.parts.values()) {
      layers.push({
        color: layer.color,
        opacity: layer.opacity,
        slice: layer.slice,
        d: layer.d.join(""),
      });
    }
    return layers;
  }
}

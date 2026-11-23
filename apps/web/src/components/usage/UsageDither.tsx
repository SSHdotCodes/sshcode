import { useEffect, useLayoutEffect, useRef } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import {
  areaCells,
  MOSAIC_CELL,
  MOSAIC_STEPS,
  mosaicGapPixels,
  mosaicShade,
  USAGE_MOSAIC_LEVELS,
  type AreaCells,
} from "./usageDither.logic";

const REVEAL_MS = 900;
const PULSE_MS = 1100;
const MOSAIC_TOP = USAGE_MOSAIC_LEVELS * MOSAIC_STEPS;

type Rgb = readonly [number, number, number];

let gapTile: { pitch: number; gap: number; canvas: HTMLCanvasElement } | null = null;
/**
 * The lines between mosaic tiles, as a pattern that clears them: one tile's square with
 * its right and bottom `gap` device pixels opaque, repeated every `pitch`.
 */
function gapPattern(
  context: CanvasRenderingContext2D,
  pitch: number,
  gap: number,
): CanvasPattern | string {
  if (gapTile === null || gapTile.pitch !== pitch || gapTile.gap !== gap) {
    const canvas = document.createElement("canvas");
    canvas.width = pitch;
    canvas.height = pitch;
    const tile = canvas.getContext("2d");
    if (tile !== null) {
      tile.fillStyle = "#000";
      tile.fillRect(pitch - gap, 0, gap, pitch);
      tile.fillRect(0, pitch - gap, pitch, gap);
    }
    gapTile = { pitch, gap, canvas };
  }
  return context.createPattern(gapTile.canvas, "repeat") ?? "transparent";
}

let swatch: CanvasRenderingContext2D | null = null;
/** Resolves any CSS colour (variables, hex, oklch) to sRGB bytes via a 1px canvas. */
function rgbOf(color: string, probe: HTMLElement): Rgb {
  probe.style.color = color;
  const resolved = getComputedStyle(probe).color;
  if (swatch === null) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    swatch = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (swatch === null) return [0, 0, 0];
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = resolved;
  swatch.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = swatch.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

export interface UsageDitherProps {
  readonly className?: string;
  /** Any CSS colour, variables included. */
  readonly color: string;
  /** CSS pixels from one mosaic tile to the next. */
  readonly cell?: number;
  /** Brightness 0–1 at a point of the unit square; brighter lights more and brighter tiles. */
  readonly intensity: (x: number, y: number) => number;
  /** Clips the field to an SVG path drawn in a `width`×`height` box stretched over it. */
  readonly clip?: { readonly path: string; readonly width: number; readonly height: number };
  /** The field dissolves in again whenever this changes. */
  readonly revealKey?: string | number;
  /** While true, a diagonal wave keeps crossing the field. */
  readonly pulse?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A dithered tile-mosaic texture: square tiles on a 5px pitch separated by crisp hairline
 * gaps, picking between shades by the Bayer matrix and fraying out where the light thins.
 * Decorative only.
 */
export function UsageDither({
  className,
  color,
  cell = MOSAIC_CELL,
  intensity,
  clip,
  revealKey,
  pulse = false,
}: UsageDitherProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read through a ref so a new closure each render does not restart the animation.
  const fieldRef = useRef({ intensity, clip, color, cell });
  const stateRef = useRef({
    revealStart: 0,
    revealedFor: "",
    pulseStart: 0,
    pulsing: false,
    frame: 0,
    theme: 0,
  });
  const drawRef = useRef<(now: number) => void>(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    // Test DOMs have a canvas element but nothing to draw on it with.
    if (canvas === null || typeof CanvasRenderingContext2D === "undefined") return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const state = stateRef.current;
    const still = prefersReducedMotion();
    let cells: HTMLCanvasElement | null = null;
    let image: ImageData | null = null;
    let resolvedColor: { raw: string; theme: number; rgb: Rgb } | null = null;

    const draw = (now: number) => {
      const field = fieldRef.current;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = window.devicePixelRatio || 1;
      const canvasWidth = Math.round(width * ratio);
      const canvasHeight = Math.round(height * ratio);
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      const columns = Math.max(1, Math.ceil(width / field.cell));
      const rows = Math.max(1, Math.ceil(height / field.cell));
      cells ??= document.createElement("canvas");
      const cellContext = cells.getContext("2d");
      if (cellContext === null) return;
      if (image === null || cells.width !== columns || cells.height !== rows) {
        cells.width = columns;
        cells.height = rows;
        image = cellContext.createImageData(columns, rows);
      }

      const reveal = still ? 1 : Math.min(1, (now - state.revealStart) / REVEAL_MS);
      const eased = 1 - (1 - reveal) ** 3;
      const wave = state.pulsing && !still ? ((now - state.pulseStart) % PULSE_MS) / PULSE_MS : -1;

      if (
        resolvedColor === null ||
        resolvedColor.raw !== field.color ||
        resolvedColor.theme !== state.theme
      ) {
        resolvedColor = {
          raw: field.color,
          theme: state.theme,
          rgb: rgbOf(field.color, canvas),
        };
      }
      const [r, g, b] = resolvedColor.rgb;
      const pixels = image.data;
      for (let row = 0; row < rows; row++) {
        const y = (row + 0.5) / rows;
        for (let column = 0; column < columns; column++) {
          const x = (column + 0.5) / columns;
          let level = field.intensity(x, y) * eased;
          if (wave >= 0 && level > 0) {
            // A soft diagonal band sweeping from the top left to the bottom right. It only
            // brightens tiles the field already reaches, so empty areas stay empty.
            const distance = Math.abs((x + y) / 2 - (wave * 1.4 - 0.2));
            level += Math.max(0, 0.22 - distance) * 1.4 * Math.min(1, level * 8);
          }
          const shade = mosaicShade(level, column, row, USAGE_MOSAIC_LEVELS);
          const offset = (row * columns + column) * 4;
          if (shade === 0) {
            pixels[offset + 3] = 0;
            continue;
          }
          pixels[offset] = r;
          pixels[offset + 1] = g;
          pixels[offset + 2] = b;
          pixels[offset + 3] = Math.round((shade / MOSAIC_TOP) * 255);
        }
      }
      cellContext.putImageData(image, 0, 0);

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      const pitch = Math.max(2, Math.round(field.cell * ratio));
      const gap = mosaicGapPixels(ratio);
      context.save();
      if (field.clip) {
        const path = new Path2D(field.clip.path);
        const scaled = new Path2D();
        scaled.addPath(
          path,
          new DOMMatrix().scale(canvas.width / field.clip.width, canvas.height / field.clip.height),
        );
        context.clip(scaled);
      }
      context.drawImage(cells, 0, 0, columns * pitch, rows * pitch);
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = gapPattern(context, pitch, gap);
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.restore();

      if (!still && (reveal < 1 || state.pulsing)) {
        state.frame = requestAnimationFrame(draw);
      } else {
        state.frame = 0;
      }
    };
    drawRef.current = (now) => {
      if (state.frame === 0) draw(now);
    };
    const stopResize = observeResize(canvas, () => drawRef.current(performance.now()));
    // Theme switches recolour the page without resizing anything.
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            state.theme += 1;
            drawRef.current(performance.now());
          });
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-theme-id"],
    });
    return () => {
      stopResize();
      themeObserver?.disconnect();
      if (state.frame !== 0) cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  // Layout effects run before the passive ones below, so they draw the latest field.
  useLayoutEffect(() => {
    fieldRef.current = { intensity, clip, color, cell };
  });

  const revealToken = String(revealKey ?? "");
  useEffect(() => {
    const state = stateRef.current;
    state.revealedFor = revealToken;
    state.revealStart = performance.now();
    drawRef.current(performance.now());
  }, [revealToken]);

  useEffect(() => {
    const state = stateRef.current;
    state.pulsing = pulse;
    if (pulse) state.pulseStart = performance.now();
    drawRef.current(performance.now());
  }, [pulse]);

  // A new field or colour repaints the still frame; a running animation picks it up itself.
  useEffect(() => {
    drawRef.current(performance.now());
  });

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}

export interface UsageDitherArea {
  /** SVG path in the view box, closed along the baseline. */
  readonly path: string;
  /** Any CSS colour, variables included. */
  readonly color: string;
  /** Drawn faint, for a series still loading. */
  readonly faded?: boolean;
}

/**
 * Chart areas drawn as dithered tile-mosaic cells, one colour per series: a bright band
 * of tiles along each area's top edge, thinning and fraying toward the baseline. Areas are
 * listed back to front; one in front hides the fill behind it but not the edge of the one
 * behind, so every series' shape stays readable.
 */
export function UsageDitherAreas({
  className,
  areas,
  viewWidth,
  viewHeight,
  cell = MOSAIC_CELL,
  revealKey,
}: {
  readonly className?: string;
  readonly areas: ReadonlyArray<UsageDitherArea>;
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** CSS pixels from one mosaic tile to the next. */
  readonly cell?: number;
  /** The areas dissolve in again whenever this changes. */
  readonly revealKey?: string | number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef({ areas, viewWidth, viewHeight, cell });
  const stateRef = useRef({ revealStart: 0, frame: 0, theme: 0 });
  const drawRef = useRef<(now: number) => void>(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof CanvasRenderingContext2D === "undefined") return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const state = stateRef.current;
    const still = prefersReducedMotion();
    const cells = document.createElement("canvas");
    const probe = document.createElement("canvas");
    let image: ImageData | null = null;
    // Rebuilt only when the areas or the grid change; animation frames reuse it.
    let layout: {
      areas: ReadonlyArray<UsageDitherArea>;
      columns: number;
      rows: number;
      split: AreaCells[];
    } | null = null;
    let colors: { areas: ReadonlyArray<UsageDitherArea>; theme: number; values: Rgb[] } | null =
      null;

    const draw = (now: number) => {
      const field = fieldRef.current;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = window.devicePixelRatio || 1;
      const canvasWidth = Math.round(width * ratio);
      const canvasHeight = Math.round(height * ratio);
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      const columns = Math.max(1, Math.ceil(width / field.cell));
      const rows = Math.max(1, Math.ceil(height / field.cell));
      if (
        layout === null ||
        layout.areas !== field.areas ||
        layout.columns !== columns ||
        layout.rows !== rows
      ) {
        // One filled path per area at grid size: a tile is inside where its centre is covered.
        probe.width = columns;
        probe.height = rows;
        const probeContext = probe.getContext("2d", { willReadFrequently: true });
        if (probeContext === null) return;
        // The view box is stretched over the canvas, and a tile is `cell` CSS pixels.
        const toGrid = new DOMMatrix().scale(
          width / (field.viewWidth * field.cell),
          height / (field.viewHeight * field.cell),
        );
        const inside = field.areas.map((area) => {
          probeContext.clearRect(0, 0, columns, rows);
          const path = new Path2D();
          path.addPath(new Path2D(area.path), toGrid);
          // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- A canvas fill, not Array#fill.
          probeContext.fill(path);
          const alpha = probeContext.getImageData(0, 0, columns, rows).data;
          const mask = new Uint8Array(columns * rows);
          for (let index = 0; index < mask.length; index++)
            mask[index] = alpha[index * 4 + 3]! >= 128 ? 1 : 0;
          return mask;
        });
        layout = { areas: field.areas, columns, rows, split: areaCells(inside, columns, rows) };
      }
      if (colors === null || colors.areas !== field.areas || colors.theme !== state.theme) {
        colors = {
          areas: field.areas,
          theme: state.theme,
          values: field.areas.map((area) => rgbOf(area.color, canvas)),
        };
      }

      const reveal = still ? 1 : Math.min(1, (now - state.revealStart) / REVEAL_MS);
      const eased = 1 - (1 - reveal) ** 3;
      const cellContext = cells.getContext("2d");
      if (cellContext === null) return;
      if (image === null || cells.width !== columns || cells.height !== rows) {
        cells.width = columns;
        cells.height = rows;
        image = cellContext.createImageData(columns, rows);
      }
      const pixels = image.data;
      pixels.fill(0);
      const paint = (pass: "fill" | "band") => {
        layout!.split.forEach((split, index) => {
          const [r, g, b] = colors!.values[index]!;
          const fade = field.areas[index]?.faded ? 0.4 : 1;
          const list = pass === "fill" ? split.fill : split.band;
          for (let item = 0; item < list.length; item++) {
            const at = list[item]!;
            const column = at % columns;
            const row = (at - column) / columns;
            const level = (pass === "fill" ? split.fillLevel[item]! : 1) * eased;
            const shade = mosaicShade(level, column, row, USAGE_MOSAIC_LEVELS);
            if (shade === 0) continue;
            const offset = at * 4;
            pixels[offset] = r;
            pixels[offset + 1] = g;
            pixels[offset + 2] = b;
            pixels[offset + 3] = Math.round((shade / MOSAIC_TOP) * fade * 255);
          }
        });
      };
      // Fills first, then every edge, so no series hides another's outline.
      paint("fill");
      paint("band");
      cellContext.putImageData(image, 0, 0);

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      const pitch = Math.max(2, Math.round(field.cell * ratio));
      const gap = mosaicGapPixels(ratio);
      context.drawImage(cells, 0, 0, columns * pitch, rows * pitch);
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = gapPattern(context, pitch, gap);
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";
      state.frame = !still && reveal < 1 ? requestAnimationFrame(draw) : 0;
    };
    drawRef.current = (now) => {
      if (state.frame === 0) draw(now);
    };
    const stopResize = observeResize(canvas, () => drawRef.current(performance.now()));
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            state.theme += 1;
            drawRef.current(performance.now());
          });
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-theme-id"],
    });
    return () => {
      stopResize();
      themeObserver?.disconnect();
      if (state.frame !== 0) cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  useLayoutEffect(() => {
    fieldRef.current = { areas, viewWidth, viewHeight, cell };
  });

  const revealToken = String(revealKey ?? "");
  useEffect(() => {
    stateRef.current.revealStart = performance.now();
    drawRef.current(performance.now());
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new key restarts the reveal.
  }, [revealToken]);

  useEffect(() => {
    drawRef.current(performance.now());
  });

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}

import { useLayoutEffect, useRef } from "react";
import {
  emberField,
  emberMosaicAt,
  emberRamp,
  type EmberField,
  MOSAIC_CELL,
  MOSAIC_GAP,
  MOSAIC_STEPS,
  mosaicRamp,
  smokeDissolveOrder,
  smokeMosaic,
  smokeRamp,
} from "@t3tools/client-runtime/new-chat-smoke";

import { observeResize } from "../../lib/observeResize";

/** CSS pixels from one mosaic tile to the next. */
const CELL = MOSAIC_CELL;
/** How long the cloud takes to settle into embers after the first message. */
const DISSOLVE_MS = 900;
/** How far ahead of going out a dense cell flares to the full tint. */
const SPARK = 0.045;
/** Frames a second for the working embers: chunky cells read fine at a slow rate. */
const PULSE_FPS = 10;
/** How far the wave swings each cell's light while the agent works, as a fraction of it. */
const PULSE_SWELL = 0.16;
/** How long the wave takes to rise when work starts, or to settle when it stops. */
const PULSE_EASE_MS = 700;
/** The embers brighten this much once when the agent needs you, and fade back over FLARE_MS. */
const FLARE = 0.4;
const FLARE_MS = 1100;

export type ChatDitherMode = "cloud" | "embers";
/** What the chat's agent is doing: the embers drift while it works and flare when it needs you. */
export type ChatDitherActivity = "idle" | "working" | "needsYou";

type Rgb = readonly [number, number, number];

/** Small caches: reopening a chat at the same size costs nothing. */
function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    value = make();
    cache.set(key, value);
  }
  return value;
}
const cloudCache = new Map<string, Uint8Array>();
const emberCache = new Map<string, EmberField>();
const orderCache = new Map<string, Float32Array>();

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
/**
 * A CSS colour (a variable, hex, oklch, anything the page can resolve) as sRGB bytes. The
 * computed colour keeps the theme's own notation, so a 1px canvas does the conversion.
 */
function rgbOf(color: string, probe: HTMLElement): [number, number, number] {
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

/** One frame's geometry and colours. */
interface Scene {
  readonly columns: number;
  readonly rows: number;
  readonly ratio: number;
  readonly cloudRamp: ReadonlyArray<Rgb>;
  readonly emberRamp: ReadonlyArray<Rgb>;
}

function cloudTones(scene: Scene) {
  return cached(cloudCache, `${scene.columns}x${scene.rows}`, () =>
    smokeMosaic(scene.columns, scene.rows),
  );
}

function embersOf(scene: Scene): EmberField {
  return cached(emberCache, `${scene.columns}x${scene.rows}`, () =>
    emberField(scene.columns, scene.rows, CELL),
  );
}

function tonesOf(mode: ChatDitherMode, scene: Scene): Uint8Array {
  if (mode === "cloud") return cloudTones(scene);
  const tones = new Uint8Array(scene.columns * scene.rows);
  emberMosaicAt(embersOf(scene), 0, 0, 1, tones);
  return tones;
}

/** Writes `tones` as RGBA into `pixels`: the ramp's colour, or transparent for none. */
function writePixels(
  tones: Uint8Array,
  ramp: ReadonlyArray<Rgb>,
  pixels: Uint8ClampedArray,
  cells?: Int32Array,
) {
  const count = cells === undefined ? tones.length : cells.length;
  for (let at = 0; at < count; at++) {
    const index = cells === undefined ? at : cells[at]!;
    const tone = tones[index]!;
    const offset = index * 4;
    if (tone === 0) {
      pixels[offset + 3] = 0;
      continue;
    }
    const color = ramp[tone - 1]!;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  }
}

/** A mode's cells as RGBA, transparent where the background shows. */
function pixelsOf(mode: ChatDitherMode, scene: Scene): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(scene.columns * scene.rows * 4);
  writePixels(tonesOf(mode, scene), mode === "cloud" ? scene.cloudRamp : scene.emberRamp, pixels);
  return pixels;
}

/**
 * The dissolve under way, if any. Sending the first message swaps the draft's view for the
 * thread's mid-dissolve; the new canvas picks the animation up where the old one was.
 */
let running: {
  from: ChatDitherMode;
  to: ChatDitherMode;
  /** Animation time played so far, in ms. */
  elapsed: number;
  /** When it last advanced. */
  at: number;
} | null = null;
/**
 * The most one frame advances the animation. Sending a message keeps the main thread busy
 * for a few hundred ms; a wall clock would spend the dissolve in that stall and jump to
 * the end, so a stall only pauses it.
 */
const MAX_FRAME_MS = 34;

/** Quick at first, slow at the end: the wisps go fast, the core settles. */
const settleCurve = (t: number) => 1 - (1 - t) ** 2;

/**
 * A chat's dithered backdrop, one canvas from the new chat into the conversation. The new
 * chat shows a cloud of the harness's light rising from the lower right; once a chat is
 * open only its embers stay, settled in the lower-right corner away from the text.
 * Sending the first message dissolves the cloud into the embers cell by cell, in dither
 * order: the thin wisps and the far corner go first, dense cells flare once before they
 * go out, and the core sinks into the lower right. While the agent works a slow wave rolls
 * out of the corner through the embers; they flare once when it needs you and go still
 * when it stops. Whole 2px cells, never smoothed.
 */
export function ChatDither(props: {
  mode: ChatDitherMode;
  tint: string;
  /** The cloud's hot core on dark and on light themes. */
  coreDark: string;
  coreLight: string;
  activity?: ChatDitherActivity;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  const changeRef = useRef<(from: ChatDitherMode) => void>(() => {});
  const redrawRef = useRef<() => void>(() => {});
  const activityChangeRef = useRef<(from: ChatDitherActivity) => void>(() => {});
  const shownRef = useRef<ChatDitherMode>(props.mode);
  const activityShownRef = useRef<ChatDitherActivity>(props.activity ?? "idle");

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof CanvasRenderingContext2D === "undefined") return;
    const context = canvas.getContext("2d");
    const cells = document.createElement("canvas");
    const cellContext = cells.getContext("2d");
    if (context === null || cellContext === null) return;
    let painted = "";
    let animation = 0;
    // The working wave: its frame request, how far it swings now, when a flare began.
    let pulse = 0;
    let pulseAt = 0;
    let swell = 0;
    let flareAt: number | null = null;
    let lastScene: Scene | null = null;
    let pulseTones: Uint8Array | null = null;
    let pulsePixels: Uint8ClampedArray | null = null;
    let image: ImageData | null = null;
    const reduceMotion = () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    const measure = (): Scene | null => {
      const area = canvas.getBoundingClientRect();
      if (area.width === 0 || area.height === 0) return null;
      const { tint, coreDark, coreLight } = propsRef.current;
      const background = rgbOf("var(--background)", canvas);
      const tintRgb = rgbOf(tint, canvas);
      const dark = document.documentElement.classList.contains("dark");
      return {
        columns: Math.ceil(area.width / CELL),
        rows: Math.ceil(area.height / CELL),
        ratio: window.devicePixelRatio || 1,
        cloudRamp: mosaicRamp(
          background,
          smokeRamp(tintRgb, background, rgbOf(dark ? coreDark : coreLight, canvas)),
        ),
        emberRamp: mosaicRamp(background, emberRamp(tintRgb, background)),
      };
    };

    // Sizes only change on a resize; the wave repaints a dozen times a second.
    const paint = (scene: Scene, pixels: Uint8ClampedArray) => {
      if (image === null || cells.width !== scene.columns || cells.height !== scene.rows) {
        cells.width = scene.columns;
        cells.height = scene.rows;
        image = cellContext.createImageData(scene.columns, scene.rows);
      }
      image.data.set(pixels);
      cellContext.putImageData(image, 0, 0);
      const width = Math.round(canvas.clientWidth * scene.ratio);
      const height = Math.round(canvas.clientHeight * scene.ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      } else {
        context.clearRect(0, 0, width, height);
      }
      context.imageSmoothingEnabled = false;
      // Whole device pixels per tile and gap, so every tile is the same size and edge.
      const pitch = Math.max(2, Math.round(CELL * scene.ratio));
      context.drawImage(cells, 0, 0, scene.columns * pitch, scene.rows * pitch);
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = gapPattern(
        context,
        pitch,
        Math.max(1, Math.round(MOSAIC_GAP * scene.ratio)),
      );
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
    };

    const pulseTick = (now: number) => {
      pulse = 0;
      const scene = lastScene;
      if (animation !== 0 || shownRef.current !== "embers" || scene === null) return;
      if (pulseAt !== 0 && now - pulseAt < 1000 / PULSE_FPS - 4) {
        pulse = requestAnimationFrame(pulseTick);
        return;
      }
      const elapsed = pulseAt === 0 ? 1000 / PULSE_FPS : Math.min(250, now - pulseAt);
      pulseAt = now;
      const target = propsRef.current.activity === "working" ? PULSE_SWELL : 0;
      const ease = (PULSE_SWELL * elapsed) / PULSE_EASE_MS;
      swell = target > swell ? Math.min(target, swell + ease) : Math.max(target, swell - ease);
      let flare = 0;
      if (flareAt !== null) {
        const t = (now - flareAt) / FLARE_MS;
        if (t >= 1) flareAt = null;
        // Up quickly, down slowly.
        else flare = FLARE * (t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8);
      }
      const field = embersOf(scene);
      const size = scene.columns * scene.rows;
      if (pulseTones === null || pulseTones.length !== size) {
        pulseTones = new Uint8Array(size);
        pulsePixels = new Uint8ClampedArray(size * 4);
      }
      emberMosaicAt(field, now / 1000, swell, 1 + flare, pulseTones);
      writePixels(pulseTones, scene.emberRamp, pulsePixels!, field.cells);
      paint(scene, pulsePixels!);
      if (swell > 0 || target > 0 || flareAt !== null) {
        pulse = requestAnimationFrame(pulseTick);
        return;
      }
      // Still again: back to the plain embers.
      pulseAt = 0;
      painted = "";
      settle();
    };

    /** Starts the wave if the agent works or a flare is due, unless motion is reduced. */
    const kick = () => {
      if (pulse !== 0 || animation !== 0 || shownRef.current !== "embers") return;
      if (propsRef.current.activity !== "working" && swell === 0 && flareAt === null) return;
      if (reduceMotion()) {
        swell = 0;
        flareAt = null;
        return;
      }
      pulseAt = 0;
      pulse = requestAnimationFrame(pulseTick);
    };

    const settle = () => {
      if (animation !== 0) return;
      const scene = measure();
      if (scene === null) return;
      lastScene = scene;
      // A running wave paints this scene on its next frame.
      if (pulse !== 0) return;
      const mode = shownRef.current;
      const key = JSON.stringify([mode, scene]);
      if (key !== painted) {
        painted = key;
        paint(scene, pixelsOf(mode, scene));
      }
      kick();
    };

    const dissolve = (from: ChatDitherMode, to: ChatDitherMode, elapsed: number) => {
      if (animation !== 0) cancelAnimationFrame(animation);
      animation = 0;
      const scene = measure();
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      // Only a canvas redraws, never layout, so it runs unless motion is reduced.
      if (scene === null || from === to || reduce) {
        running = null;
        painted = "";
        settle();
        return;
      }
      const state = { from, to, elapsed, at: performance.now() };
      running = state;
      const before = pixelsOf(from, scene);
      const after = pixelsOf(to, scene);
      const dense = cloudTones(scene);
      const order = cached(orderCache, `${scene.columns}x${scene.rows}`, () =>
        smokeDissolveOrder(scene.columns, scene.rows, dense),
      );
      // The full tint, the fourth of the smoke's five colours.
      const spark = scene.cloudRamp[4 * MOSAIC_STEPS - 1]!;
      const out = to === "embers";
      const frame = new Uint8ClampedArray(before.length);
      const step = (now: number) => {
        state.elapsed += Math.min(MAX_FRAME_MS, Math.max(0, now - state.at));
        state.at = now;
        const progress = settleCurve(Math.min(1, state.elapsed / DISSOLVE_MS));
        for (let index = 0; index < order.length; index++) {
          const at = out ? order[index]! : 1 - order[index]!;
          const offset = index * 4;
          if (progress >= at) {
            frame[offset] = after[offset]!;
            frame[offset + 1] = after[offset + 1]!;
            frame[offset + 2] = after[offset + 2]!;
            frame[offset + 3] = after[offset + 3]!;
          } else if (out && progress > at - SPARK && dense[index]! >= 2 * MOSAIC_STEPS) {
            frame[offset] = spark[0];
            frame[offset + 1] = spark[1];
            frame[offset + 2] = spark[2];
            frame[offset + 3] = 255;
          } else {
            frame[offset] = before[offset]!;
            frame[offset + 1] = before[offset + 1]!;
            frame[offset + 2] = before[offset + 2]!;
            frame[offset + 3] = before[offset + 3]!;
          }
        }
        paint(scene, frame);
        if (progress < 1) {
          animation = requestAnimationFrame(step);
          return;
        }
        animation = 0;
        if (running === state) running = null;
        painted = "";
        settle();
      };
      // The first frame now, so a canvas that takes over never shows the end state first.
      step(performance.now());
    };

    changeRef.current = (from) => {
      if (pulse !== 0) cancelAnimationFrame(pulse);
      pulse = 0;
      dissolve(from, shownRef.current, 0);
    };
    redrawRef.current = settle;
    activityChangeRef.current = (from) => {
      if (propsRef.current.activity === "needsYou" && from !== "needsYou") {
        flareAt = performance.now();
      }
      kick();
    };
    const inherited = running;
    // A dissolve the previous view was playing, interrupted by the swap a moment ago.
    if (
      inherited !== null &&
      inherited.to === shownRef.current &&
      performance.now() - inherited.at < 1000
    ) {
      dissolve(inherited.from, inherited.to, inherited.elapsed);
    } else {
      settle();
    }

    let queued = 0;
    const schedule = () => {
      if (queued === 0)
        queued = requestAnimationFrame(() => {
          queued = 0;
          settle();
        });
    };
    const stopResize = observeResize(canvas, schedule);
    // A theme switch recolours the page without resizing anything.
    const themeObserver = new MutationObserver(schedule);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-theme-id"],
    });
    return () => {
      stopResize();
      themeObserver.disconnect();
      if (queued !== 0) cancelAnimationFrame(queued);
      if (animation !== 0) cancelAnimationFrame(animation);
      if (pulse !== 0) cancelAnimationFrame(pulse);
    };
  }, []);

  // Before the mode effect below, so a change reads this render's colours.
  useLayoutEffect(() => {
    propsRef.current = props;
  });
  const { mode, tint, coreDark, coreLight } = props;
  const activity = props.activity ?? "idle";
  useLayoutEffect(() => {
    const from = shownRef.current;
    if (from === mode) return;
    shownRef.current = mode;
    changeRef.current(from);
  }, [mode]);
  useLayoutEffect(() => {
    const from = activityShownRef.current;
    if (from === activity) return;
    activityShownRef.current = activity;
    activityChangeRef.current(from);
  }, [activity]);
  useLayoutEffect(() => {
    redrawRef.current();
  }, [tint, coreDark, coreLight]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 h-full w-full bg-background"
    />
  );
}

// Pets rendered from their makers' own 3D models (render-devin-otter.mjs writes the frames)
// rather than drawn in code. Each frame gets SSHCode's shared bulb, heart, sleep and speech
// marks, and runs of frames that barely change become one longer frame to keep sheets small.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import sharp from "sharp";
import { rigMarks, svg } from "./drawn.mjs";

const OTTER_INK = "#3b2414";
const DEVIN_BLUE = "#3969ca";
const VARIANTS = {
  idle: [
    ["default", 4],
    ["curious", 2],
    ["snooze", 1],
  ],
  greet: [["default", 1]],
  working: [["default", 1]],
  waiting: [["default", 1]],
  done: [
    ["default", 3],
    ["dance", 2],
    ["hearts", 1],
  ],
  failed: [["default", 1]],
  idea: [["default", 1]],
};
// The frame a still picture of each state uses: the dots out, a tear on its way, the bulb lit.
const POSTER_MS = {
  "greet-default": 700,
  "working-default": 600,
  "waiting-default": 1300,
  "done-default": 1500,
  "failed-default": 1500,
  "idea-default": 1300,
};
// Neighbouring frames whose pixels differ by less than this (mean per channel) merge.
const STILL = 0.35;

async function loadPet(directory) {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "manifest.json"), "utf8"),
  );
  const art = {};
  for (const [state, choices] of Object.entries(VARIANTS)) {
    for (const [variant] of choices) {
      const name = `${state}-${variant}`;
      const entry = manifest[name];
      if (!entry) throw new Error(`${directory}: no rendered frames for ${name}`);
      const frames = [];
      const durations = [];
      let previous = null;
      for (let index = 0; index < entry.frames; index++) {
        const file = NodePath.join(directory, name, `${String(index).padStart(3, "0")}.png`);
        const marks = rigMarks(
          {
            bulb: 0,
            heart: 0,
            zed: 0,
            dots: 0,
            ...entry.marks[index],
          },
          OTTER_INK,
          DEVIN_BLUE,
        );
        const png = await sharp(file)
          // The marks sit a little lower than on the drawn pets, just above the otter's ear.
          .composite(
            marks
              ? [{ input: Buffer.from(svg(`<g transform="translate(0 4)">${marks}</g>`)) }]
              : [],
          )
          .png()
          .toBuffer();
        const pixels = await sharp(png).raw().ensureAlpha().toBuffer();
        if (previous !== null && difference(previous, pixels) < STILL) {
          durations[durations.length - 1] += entry.ms;
          continue;
        }
        frames.push(png);
        durations.push(entry.ms);
        previous = pixels;
      }
      art[name] = {
        frames,
        durations,
        ...(POSTER_MS[name] === undefined ? {} : { posterMs: POSTER_MS[name] }),
      };
    }
  }
  return art;
}

function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Loads the rendered pets found in the mascot source directory. */
export async function renderedPets(source) {
  const pets = {};
  const variants = {};
  const devin = NodePath.join(source, "devin/render");
  if (NodeFS.existsSync(NodePath.join(devin, "manifest.json"))) {
    const art = await loadPet(devin);
    pets.devin = {
      draw: (state, variant) => art[`${state}-${variant}`] ?? art[`${state}-default`],
      dark: false,
    };
    variants.devin = VARIANTS;
  }
  return { pets, variants };
}

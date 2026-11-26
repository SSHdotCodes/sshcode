#!/usr/bin/env node
// Usage: node scripts/generate-harness-mascots.mjs <source-directory> [preview-directory]
// Inputs: decoded Clawd Quest JSON and, for Codex, the pet Byte (a Codex
// custom pet from the GPT-6 Astra CD, laid out like the official Codex
// spritesheet v6, which stays in the source directory). Grok Bot, Le Chonk
// (Mistral) and Capy (Qwen) are drawn in code after their makers' own art, in
// scripts/harness-mascots/drawn.mjs. Other pets use an image-generated sheet in
// that layout when <id>/sheet/ has one, otherwise the original vector drawings
// below. Clients share frame coordinates; native Clawd uses a denser integer
// scale for the 96pt hero.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { drawnPets, drawnVariants } from "./harness-mascots/drawn.mjs";
import { renderedPets } from "./harness-mascots/rendered.mjs";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const source = NodePath.resolve(
  process.argv[2] ?? NodePath.resolve(root, "../t3code-fork-mascot-src"),
);
const preview = process.argv[3];
// Devin's otter is rendered from Devin Desktop's own 3D model (render-devin-otter.mjs).
const rendered = await renderedPets(source);
Object.assign(drawnPets, rendered.pets);
Object.assign(drawnVariants, rendered.variants);
const cell = 216;
const columns = 8;
const states = ["idle", "greet", "working", "waiting", "done", "failed", "idea"];
const clawd = JSON.parse(
  await NodeFSP.readFile(NodePath.resolve(source, "clawd/clawd-sprites.decoded.json"), "utf8"),
);
const codex = await NodeFSP.readFile(NodePath.resolve(source, "codex/byte/spritesheet.webp"));
const output = ["apps/web/public/mascots", "apps/mobile/assets/mascots"].map((p) =>
  NodePath.resolve(root, p),
);
for (const directory of output) await NodeFSP.mkdir(directory, { recursive: true });
const manifest = {};
const contacts = [];
const variantContacts = [];
const pixelFrames = {};

const wrap = (content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="216" height="216" viewBox="0 0 96 96">${content}</svg>`;
const ellipse = (cx, cy, rx, ry, fill, extra = "") =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
const path = (d, fill, extra = "") => `<path d="${d}" fill="${fill}" ${extra}/>`;
const line = (d, color, width = 1.5) =>
  path(
    d,
    "none",
    `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`,
  );
const gradient = (id, light, dark) =>
  `<linearGradient id="${id}" x2=".7" y2="1"><stop stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`;

// Shared stage directions keep the seven states legible in tiny slots. Each
// pet below has its own silhouette, appendages and idle movement.
function vectorPet(id, state, frame, count, variant) {
  const phase = (frame / count) * Math.PI * 2;
  const swell = Math.sin((frame / (count - 1)) * Math.PI);
  const wave = Math.sin(phase);
  const celebrate = state === "done" || state === "greet";
  const sleeping = variant === "snooze";
  const curious = variant === "curious";
  const dance = variant === "dance";
  const lift = celebrate ? -swell * (dance ? 4 : 7) : wave * 0.7;
  const tilt =
    state === "failed"
      ? -7
      : state === "waiting"
        ? -5
        : curious
          ? wave * 7
          : dance
            ? wave * 10
            : wave * 1.5;
  const gaze = state === "waiting" ? -2 : curious ? wave * 4 : wave * 0.7;
  const blink = sleeping || (state === "idle" && (frame === 4 || (curious && frame === 8)));
  const happy = state === "done";
  const dark = "#26313b";
  const face = (y = 44, color = dark, spacing = 8) => {
    const eyes = [48 - spacing, 48 + spacing]
      .map((x) =>
        happy || blink
          ? line(`M${x - 2.5} ${y}q2.5 ${happy ? -4 : 2} 5 0`, color, 2.2)
          : `${ellipse(x + gaze, y, 2.3, state === "failed" ? 2.1 : 3.4, color)}${ellipse(x + gaze - 0.6, y - 1, 0.65, 0.8, "#fff")}`,
      )
      .join("");
    return `${eyes}${line(`M45 ${y + 9}q3 ${state === "failed" ? -3 : sleeping ? 0 : 3} 6 0`, color, 1.4)}${state === "failed" ? line(`M36 ${y - 5}l6 2m12 0 6-2`, color, 1.2) : ""}`;
  };
  const hand = (x, y, color, angle = 0) =>
    ellipse(x, y, 5, 7, color, `transform="rotate(${angle} ${x} ${y})"`);
  const paws = (color) =>
    state === "working"
      ? `${hand(35, 65 + Math.sin(phase * 2) * 1.5, color, -50)}${hand(61, 65 - Math.sin(phase * 2) * 1.5, color, 50)}`
      : `${hand(24, happy ? 46 - swell * 9 : 59, color, happy ? 40 : -20)}${hand(72, state === "greet" ? 32 + wave * 4 : state === "waiting" ? 50 : happy ? 46 - swell * 9 : 59, color, state === "greet" ? 30 + wave * 20 : 20)}`;
  const keyboard =
    state === "working"
      ? `<rect x="27" y="66" width="42" height="11" rx="3" fill="#dce4e8" stroke="#81929c" stroke-width=".8"/>${line("M32 70h32m-32 3h32m-25-5v6m7-6v6m7-6v6m7-6v6", "#94a5af", 0.8)}`
      : "";
  let character;
  if (id === "cursor") {
    // Nib is a round silver fox: big ears, white muzzle and bib, and a swishing tail.
    character = `<g transform="rotate(${wave * 6} 60 66)">${path("M57 69C79 70 88 52 79 37C76 33 70 34 71 39C76 52 68 59 57 60Z", "#8f99a3", 'stroke="#67717c" stroke-width=".8"')}${path("M79 37C76 33 70 34 71 39C72 42 74 44 76 46C80 44 81 40 79 37Z", "#f6f4ef")}</g>${ellipse(39, 77, 7.5, 4, "#535c67")}${ellipse(57, 77, 7.5, 4, "#535c67")}${path("M48 45C29 45 27 60 28 67S35 77 48 77 66 74 68 67 67 45 48 45Z", "url(#coat)", 'stroke="#67717c" stroke-width=".8"')}${ellipse(48, 64, 10, 8.5, "#faf8f1")}${path("M29 33 31 11 45 25Z", "url(#coat)", 'stroke="#67717c" stroke-width=".8" stroke-linejoin="round"')}${path("M67 33 65 11 51 25Z", "url(#coat)", 'stroke="#67717c" stroke-width=".8" stroke-linejoin="round"')}${path("M32 28 33 17 41 25Z", "#323943")}${path("M64 28 63 17 55 25Z", "#323943")}${ellipse(48, 40, 22, 17.5, "url(#coat)", 'stroke="#67717c" stroke-width=".8"')}${ellipse(48, 48, 12, 7.5, "#faf8f1")}${face(40, dark, 9)}${path("m45.5 45 2.5-1.5 2.5 1.5-2.5 2.2Z", "#444c58")}${keyboard}${paws("#adb5bd")}`;
  } else if (id === "opencode") {
    // Otto is a little terminal: a rounded monitor body whose screen is its face,
    // with a prompt and a blinking cursor in the corner.
    const cursorOn = state === "working" ? frame % 4 < 2 : frame % 6 < 3;
    character = `${ellipse(36, 77, 8, 4, "#4a565c")}${ellipse(60, 77, 8, 4, "#4a565c")}<rect x="40" y="66" width="16" height="8" rx="3" fill="#5d6a71"/><rect x="19" y="20" width="58" height="49" rx="14" fill="url(#coat)" stroke="#4a565c" stroke-width="1"/><rect x="29" y="26" width="38" height="35" rx="9" fill="#141d1c" stroke="#3e5a52" stroke-width=".8"/>${line("M33 30.5l2.5 2-2.5 2", "#62d6a0", 1.1)}${cursorOn ? '<rect x="37.5" y="33.4" width="3.2" height="1.3" rx=".4" fill="#62d6a0"/>' : ""}${face(43, "#8ff0c4", 8)}${ellipse(70, 64.5, 1.3, 1.3, "#7fe0b5")}${keyboard}${paws("#c3ccd1")}`;
  } else if (id === "pi") {
    // Pip is a pear-shaped ink bird with a soft belly and a three-feather crest.
    character = `${path("M36 73v7l-7 1m29-8v7l7 1", "none", 'stroke="#d69a66" stroke-width="3.2" stroke-linecap="round"')}${path(`M43 22q-10-17-12-10 0 7 12 13m4-2q-2-18 4-14 4 4-1 15m0 0q11-13 14-7 1 5-12 11`, "#404f5b")}${path("M48 22C31 22 29 39 26 52S25 76 48 77 73 65 69 51 64 22 48 22Z", "url(#coat)", 'stroke="#283743" stroke-width=".8"')}${ellipse(48, 54, 17, 20, "#f5f0df")}${face(42)}${path("m45 48 3-2 4 2-4 3Z", "#d89b61")}${keyboard}${paws("#536373")}`;
  } else if (id === "mistral") {
    // Ember is a warm little salamander: a round head with flame tufts, a soft
    // belly and a curling, glowing tail.
    character = `${path(`M66 64C85 ${51 - wave * 4} 88 73 74 78Q58 83 58 68`, "none", 'stroke="#dd633e" stroke-width="8" stroke-linecap="round"')}${path(`M72 72q10 ${-3 - wave * 3} 8-8`, "none", 'stroke="#ffcb62" stroke-width="3" stroke-linecap="round"')}${ellipse(37, 77, 7.5, 4, "#c95537")}${ellipse(59, 77, 7.5, 4, "#c95537")}${path("M48 44C29 44 27 59 29 66S36 77 48 77 66 74 67 66 67 44 48 44Z", "url(#coat)", 'stroke="#cb673e" stroke-width=".8"')}${ellipse(48, 64, 12, 9, "#ffe5a1")}${path(`M29 42Q${18 + wave} 40 18 31Q22 35 25 33Q22 28 25 24Q28 32 33 34Z`, "#f59a52", 'stroke="#cb673e" stroke-width=".6" stroke-linejoin="round"')}${path(`M67 42Q${78 - wave} 40 78 31Q74 35 71 33Q74 28 71 24Q68 32 63 34Z`, "#f59a52", 'stroke="#cb673e" stroke-width=".6" stroke-linejoin="round"')}${path(`M43 25Q${45 + wave} 14 52 11Q49 18 55 24Z`, "#ffd47d")}${ellipse(48, 40, 21, 17, "url(#coat)", 'stroke="#cb673e" stroke-width=".8"')}${ellipse(33, 47, 3.6, 2, "#ef7b5c", 'opacity=".5"')}${ellipse(63, 47, 3.6, 2, "#ef7b5c", 'opacity=".5"')}${face(41, "#663a31", 8)}${keyboard}${paws("#f3a05a")}`;
  } else {
    // Patch is the ACP fallback and the face of unthemed agents: a small, round
    // helper robot with a screen face, ear bolts and a bobbing antenna.
    const glow = state === "working" ? 0.55 + Math.abs(Math.sin(phase * 2)) * 0.45 : 0.8;
    character = `${ellipse(37, 77, 7.5, 4, "#7b6f99")}${ellipse(59, 77, 7.5, 4, "#7b6f99")}${line(`M48 23Q${48 + wave * 2} 17 ${48 + wave * 3} 13`, "#8b7aa8", 2)}${ellipse(48 + wave * 3, 12, 3.6, 3.6, "#9fe3c9", 'stroke="#6fb59a" stroke-width=".8"')}<rect x="20" y="37" width="7" height="13" rx="3" fill="#a995c6"/><rect x="69" y="37" width="7" height="13" rx="3" fill="#a995c6"/><rect x="25" y="22" width="46" height="53" rx="19" fill="url(#coat)" stroke="#8b7aa8" stroke-width=".9"/><rect x="31" y="30" width="34" height="24" rx="10" fill="#2e2a40"/>${ellipse(40, 33.5, 5, 1.6, "#ffffff", 'opacity=".12"')}${ellipse(36.5, 47.5, 3, 1.6, "#f2a7c3", 'opacity=".55"')}${ellipse(59.5, 47.5, 3, 1.6, "#f2a7c3", 'opacity=".55"')}${face(41, "#c9f5e3", 7)}${ellipse(48, 63, 2.6, 2.6, "#9fe3c9", `opacity="${glow}"`)}${keyboard}${paws("#c5aedc")}`;
  }
  const palettes = {
    cursor: ["#e4e7eb", "#8b97a5"],
    opencode: ["#9aa6ad", "#5d6a71"],
    pi: ["#65788b", "#304250"],
    mistral: ["#ffcd77", "#ee8650"],
    acp: ["#e4d9f3", "#a995c6"],
  };
  const [light, shade] = palettes[id];
  const spark = (x, y, size, color) =>
    path(
      `M${x} ${y - size}q0 ${size} ${size} ${size}q-${size} 0-${size} ${size}q0-${size}-${size}-${size}q${size} 0 ${size}-${size}Z`,
      color,
    );
  const accents = happy
    ? `<g opacity="${0.3 + swell * 0.7}">${
        variant === "hearts"
          ? path("M15 30c-8-6-9 5 0 9 9-4 8-15 0-9Zm66-8c-8-6-9 5 0 9 9-4 8-15 0-9Z", "#e39aa8")
          : `${spark(15, 28 - swell * 3, 4, shade)}${spark(81, 23 + swell * 2, 3, "#d8af62")}${spark(78, 67, 2, light)}`
      }</g>`
    : state === "waiting"
      ? `<g fill="${shade}">${[0, 1, 2].map((i) => ellipse(73 + i * 5, 20 - i * 3, 1.7, 1.7, shade, `opacity="${0.35 + (((frame + i * 3) % count) / count) * 0.65}"`)).join("")}</g>`
      : state === "idea"
        ? `<g transform="translate(78 15) rotate(${wave * 5})"><circle r="6" fill="#ffe6a0" stroke="#d4a95b" stroke-width="1"/>${line("M-2 6v3h4V6m-2-14v-3m-8 5-2-1m18 1 2-1", "#caa05c", 1.4)}</g>`
        : state === "failed"
          ? path("M77 34q-7 10 0 10t0-10Z", "#9ac8de")
          : sleeping
            ? `<text x="75" y="24" fill="${shade}" font-family="sans-serif" font-size="9">z</text>`
            : "";
  return wrap(
    `<defs>${gradient("coat", light, shade)}</defs>${ellipse(48, 84, 24 - Math.abs(lift) * 0.4, 2.5, "#344754", 'opacity=".12"')}<g transform="translate(${dance ? wave * 3 : 0} ${lift}) rotate(${tilt} 48 54)">${character}</g>${accents}`,
  );
}
function grok(state, frame, count, variant = "default") {
  const phase = (frame / count) * Math.PI * 2;
  const bounce =
    state === "done" || state === "greet"
      ? -Math.sin((frame / (count - 1)) * Math.PI) * 7
      : Math.sin(phase) * 0.8;
  let turn =
    state === "waiting" ? -10 : state === "working" ? Math.sin(phase) * 7 : Math.sin(phase) * 2;
  let scan =
    state === "working" ? Math.sin(phase) * 5 : state === "waiting" ? -3 : Math.sin(phase) * 1.5;
  if (variant === "spin") turn = (frame / (count - 1)) * 360;
  if (variant === "roll") turn = Math.sin(phase) * 22;
  if (variant === "wobble") turn = Math.sin(phase * 2) * 12;
  if (variant === "orbit") {
    turn = Math.sin(phase) * 10;
    scan = Math.cos(phase) * 5;
  }
  if (variant === "proud") turn = -8 + Math.sin(phase) * 5;
  if (variant === "look-around") scan = Math.sin(phase) * 8;
  if (variant === "tilt") turn = -15 + Math.sin(phase) * 4;
  const blink =
    variant === "doze" ||
    (state === "idle" && (variant === "double-blink" ? frame === 3 || frame === 7 : frame === 5))
      ? 0.12
      : 1;
  const eyes =
    state === "failed" && variant !== "squint"
      ? `<path d="m34 39 7 8m0-8-7 8m19-8 7 8m0-8-7 8" stroke="#17191c" stroke-width="3.5" stroke-linecap="round"/>`
      : `<g transform="translate(${scan} 0)"><rect x="32" y="33" width="9" height="${20 * (variant === "squint" ? 0.2 : blink)}" rx="4.5" fill="#15171b" transform="rotate(-29 36.5 43)"/><rect x="53" y="30" width="9" height="${20 * (variant === "squint" ? 0.2 : blink)}" rx="4.5" fill="#15171b" transform="rotate(-29 57.5 40)"/></g>`;
  const glints =
    (state === "done" || variant === "burst") && frame > 2 && frame < 11
      ? `<g fill="none" stroke="#a5acb5" stroke-width="1.2" stroke-linecap="round" opacity="${Math.sin((frame / (count - 1)) * Math.PI)}"><path d="m13 24 3 3m-5 3h3m68-9-3 3m5 3h-3"/></g>`
      : "";
  return wrap(
    `<defs><radialGradient id="orb" cx="32%" cy="23%" r="79%"><stop stop-color="#fff"/><stop offset=".5" stop-color="#eef0f2"/><stop offset=".8" stop-color="#c4c9cf"/><stop offset="1" stop-color="#8d969f"/></radialGradient><radialGradient id="shine"><stop stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>${ellipse(48, 83, 23, 2.8, "#151b24", 'opacity=".1"')}<g transform="translate(0 ${bounce}) rotate(${turn} 48 48)"><circle cx="48" cy="47" r="31" fill="url(#orb)" stroke="#aeb5bd" stroke-width=".65"/><path d="M23 36C29 20 48 12 65 24" fill="none" stroke="white" stroke-width="1.5" opacity=".9"/>${ellipse(36, 28, 15, 8, "url(#shine)")}${eyes}</g>${glints}${variant === "burst" ? `<g stroke="#b8a36d" stroke-width="1.4" stroke-linecap="round" opacity="${Math.sin((frame / (count - 1)) * Math.PI)}"><path d="m14 50-5 1m72-1 5 1M28 14l-3-4m43 4 3-4m-23 0V5"/></g>` : ""}${state === "idea" ? '<path d="m79 15 1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5Z" fill="#b8a36d"/>' : ""}`,
  );
}
function jolly(state, frame, count, variant = "default") {
  const phase = (frame / count) * Math.PI * 2 * (variant === "tippy-tap" ? 2 : 1);
  let lift =
    state === "done" || state === "greet"
      ? -Math.sin((frame / (count - 1)) * Math.PI) * 5
      : Math.sin(phase) * 0.6;
  let tilt =
    state === "waiting" ? -7 : state === "failed" ? Math.sin(phase) * 3 : Math.sin(phase) * 1.2;
  if (variant === "sway" || variant === "dance") tilt = Math.sin(phase) * 9;
  if (variant === "curious" || variant === "ponder") tilt = -10 + Math.sin(phase) * 4;
  if (variant === "star-hop") lift = -Math.abs(Math.sin(phase)) * 8;
  const blink = variant === "snooze" || (state === "idle" && frame === 5);
  const happy = state === "done";
  let eyes = happy
    ? '<path d="M35 44q3-5 6 0m14 0q3-5 6 0" fill="none" stroke="#302c28" stroke-width="2.5" stroke-linecap="round"/>'
    : [38, 58]
        .map(
          (x) =>
            `${ellipse(x, 43, 2.7, blink ? 0.65 : 3.4, "#302c28")}${blink ? "" : ellipse(x - 0.7, 42, 0.7, 0.9, "#fff8e9")}`,
        )
        .join("");
  if (variant === "curious")
    eyes = `<g transform="translate(${Math.sin(phase) * 3} 0)">${eyes}</g>`;
  // A softly scalloped silhouette and individually placed tufts read as plush
  // at portrait size without a noisy fur texture in the tiny status rows.
  const fur = Array.from({ length: 34 }, (_, i) => {
    const angle = (i / 34) * Math.PI * 2;
    return ellipse(48 + Math.cos(angle) * 29, 46 + Math.sin(angle) * 28, 4.3, 4.2, "#ede3cd");
  }).join("");
  const paws =
    state === "working"
      ? `${ellipse(35, 65 + Math.sin(phase * 2) * 2, 5.5, 4.2, "#eee3cc", 'stroke="#cabb9f" stroke-width=".6"')}${ellipse(61, 65 - Math.sin(phase * 2) * 2, 5.5, 4.2, "#eee3cc", 'stroke="#cabb9f" stroke-width=".6"')}`
      : `${ellipse(19, 54, 5.5, 8, "#eee3cc", `transform="rotate(-22 19 54)"`)}${ellipse(77, state === "greet" ? 31 + Math.sin(phase) * 3 : 54, 5.5, 8, "#eee3cc", `transform="rotate(${state === "greet" ? 32 : 22} 77 47)"`)}`;
  const keyboard =
    state === "working"
      ? '<path d="m26 64 44 0 6 12H20Z" fill="#cbc7bd" stroke="#a39d90" stroke-width=".8"/><path d="M27 68h42M25 71h46M23 74h50m-40-7-1 6m9-6v6m8-6v6m8-6 1 6m8-6 1 6" stroke="#f5f2eb" stroke-width="1.1"/>'
      : "";
  return wrap(
    `<defs><radialGradient id="plush" cx="36%" cy="23%" r="80%"><stop stop-color="#fffbed"/><stop offset=".62" stop-color="#f4ebd8"/><stop offset="1" stop-color="#d9c9ac"/></radialGradient></defs>${ellipse(48, 83, 23, 2.8, "#312a20", 'opacity=".1"')}<g transform="translate(0 ${lift}) rotate(${tilt} 48 49)">${ellipse(35, 75, 8, 5, "#dfd0b4")}${ellipse(61, 75, 8, 5, "#dfd0b4")}${fur}<ellipse cx="48" cy="46" rx="30" ry="29" fill="url(#plush)"/><path d="m35 21 2-4 3 3m7-1 3-5 2 5m8 2 4-2" stroke="#fff9e8" stroke-width="2" stroke-linecap="round" fill="none"/>${ellipse(29, 50, 5.5, 3.5, "#eaa5a1", 'opacity=".65"')}${ellipse(67, 50, 5.5, 3.5, "#eaa5a1", 'opacity=".65"')}${eyes}<path d="${state === "failed" ? "M45 54q3-3 6 0" : "M45 52q3 3 6 0"}" fill="none" stroke="#7a6556" stroke-width="1.3" stroke-linecap="round"/>${keyboard}${paws}</g>${state === "idea" ? '<path d="m80 14 1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5Z" fill="#b8a36d"/>' : ""}${variant === "hearts" ? `<g fill="#dfaaa8" opacity="${Math.sin((frame / (count - 1)) * Math.PI)}"><path d="M15 27c-8-6-9 5 0 9 9-4 8-15 0-9Zm66-5c-8-6-9 5 0 9 9-4 8-15 0-9Z"/></g>` : ""}${variant === "star-hop" ? '<path d="m14 27 1 4 4 1-4 1-1 4-1-4-4-1 4-1Zm67-8 1 4 4 1-4 1-1 4-1-4-4-1 4-1Z" fill="#c6a66c"/>' : ""}`,
  );
}
const variants = {
  claude: {
    idle: [
      ["LookingAroundEyesOnly", 4],
      ["LookingAround", 3],
      ["Meditating", 3],
      ["Swaying", 2],
      ["CrabWalking", 0.25],
      ["Turning", 0.25],
    ],
    greet: [
      ["Waving", 10],
      ["Pointing", 3],
      ["Excited", 2],
      ["Hula", 0.25],
    ],
    working: [
      ["Laptop", 1],
      ["Desktop", 1],
    ],
    waiting: [
      ["Thinking", 2],
      ["Pointing", 1],
    ],
    done: [
      ["Excited", 3],
      ["DancingHappy", 3],
      ["JumpingHappy", 2],
      ["Confetti", 0.5, true],
      ["BreakDancing", 0.25, true],
    ],
    failed: [
      ["Disappointed", 1],
      ["Dizzy", 1],
      ["Facepalm", 1],
    ],
    idea: [
      ["Lightbulb", 2],
      ["Spark", 1],
    ],
  },
  codex: {
    idle: [
      ["default", 4],
      ["look-around", 2],
      ["running-left", 0.25],
      ["running-right", 0.25],
      ["wink", 2],
      ["content", 2],
      ["stretch", 0.25],
    ],
    greet: [
      ["default", 3],
      ["jumping", 1],
    ],
    working: [
      ["default", 8],
      ["running-left", 1],
      ["running-right", 1],
    ],
    waiting: [
      ["default", 2],
      ["look-around", 1],
    ],
    done: [
      ["default", 2],
      ["jumping", 1],
      ["happy-dance", 2],
      ["double-hop", 1],
      ["victory-lap", 0.25, true],
    ],
    failed: [
      ["default", 1],
      ["sad", 1],
    ],
    idea: [
      ["default", 1],
      ["review", 1],
    ],
  },
  grok: {
    idle: [
      ["default", 3],
      ["look-around", 2],
      ["double-blink", 2],
      ["orbit", 1],
      ["doze", 1],
    ],
    greet: [
      ["default", 3],
      ["spin", 1],
    ],
    working: [
      ["default", 2],
      ["roll", 1],
    ],
    waiting: [
      ["default", 1],
      ["tilt", 1],
    ],
    done: [
      ["default", 2],
      ["spin", 1],
      ["burst", 1],
      ["wobble", 1],
      ["proud", 1],
    ],
    failed: [
      ["default", 1],
      ["squint", 1],
    ],
    idea: [
      ["default", 2],
      ["burst", 1],
    ],
  },
  muse: {
    idle: [
      ["default", 4],
      ["sway", 2],
      ["curious", 2],
      ["snooze", 1],
    ],
    greet: [
      ["default", 3],
      ["sway", 1],
    ],
    working: [
      ["default", 3],
      ["tippy-tap", 1],
    ],
    waiting: [
      ["default", 2],
      ["ponder", 1],
    ],
    done: [
      ["default", 3],
      ["dance", 2],
      ["hearts", 1],
      ["star-hop", 0.5],
    ],
    failed: [["default", 1]],
    idea: [["default", 1]],
  },
};
const vectorPets = ["cursor", "opencode", "pi", "acp"];
for (const id of vectorPets) {
  variants[id] = {
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
}
// Mistral keeps its place in the order; Qwen joins at the end.
variants.mistral = drawnVariants.mistral;
Object.assign(variants, drawnVariants);
// Pets with an image-generated sheet in the Codex custom-pet layout (like Byte)
// at <source>/<id>/sheet/spritesheet.webp replace their vector drawing.
const sheets = { codex };
for (const id of Object.keys(variants)) {
  const file = NodePath.resolve(source, id, "sheet/spritesheet.webp");
  if (id === "codex" || id === "claude" || drawnPets[id]) continue;
  try {
    sheets[id] = await NodeFSP.readFile(file);
  } catch {
    continue;
  }
  variants[id] = {
    idle: [
      ["default", 4],
      ["running-left", 0.25],
      ["running-right", 0.25],
      ["wave", 0.25],
      ["calm", 2],
    ],
    greet: [
      ["default", 3],
      ["cheer", 1],
    ],
    working: [
      ["default", 8],
      ["running-left", 1],
      ["running-right", 1],
    ],
    waiting: [
      ["default", 2],
      ["pace", 1],
    ],
    done: [
      ["default", 2],
      ["happy-dance", 2],
      ["wave", 1],
      ["victory-lap", 0.25, true],
    ],
    failed: [
      ["default", 1],
      ["sad", 1],
    ],
    idea: [
      ["default", 2],
      ["eureka", 1],
    ],
  };
}
// Recuts of the standard sheet rows (0 idle, 1-2 walk, 3 wave, 4 idea,
// 6 waiting, 8 celebrate) as [row, column, milliseconds].
const sheetSequences = {
  calm: [0, 1, 2, 3, 4, 5].map((i) => [0, i, [2400, 900, 900, 1100, 1100, 2800][i]]),
  wave: [0, 1, 2, 3, 0, 1, 2, 3].map((i) => [3, i, i === 3 ? 220 : 140]),
  cheer: [0, 1, 2, 3, 4, 5].map((i) => [8, i, i === 5 ? 280 : 150]),
  pace: [1, 2].flatMap((row) => Array.from({ length: 8 }, (_, i) => [row, i, 130])),
  "happy-dance": [0, 1, 2, 3, 4, 5, 4, 3, 2, 1].map((i) => [8, i, i === 5 ? 220 : 140]),
  "victory-lap": [
    ...[1, 2].flatMap((row) => Array.from({ length: 8 }, (_, i) => [row, i, 100])),
    [8, 4, 450],
  ],
  eureka: [
    ...[0, 1, 2, 3, 4].map((i) => [4, i, 140]),
    ...[0, 1, 2, 3, 4, 5].map((i) => [8, i, i === 5 ? 280 : 150]),
  ],
};
const clawdMargin = 6;
// Each Clawd Quest animation records where Clawd's 24x16 body sits (`a0`);
// props such as the laptop, bubble or bulb extend beyond it. Centre the whole
// drawing across and Clawd's body down, so every pose shares one body height
// and lines up with text beside small slots. Poses too tall for that (the
// bubble and bulb) centre as a whole.
function clawdPlacement(animation, clawdScale) {
  let minX = animation.w,
    minY = animation.h,
    maxX = -1,
    maxY = -1;
  for (const frame of animation.frames)
    frame.forEach((index, pixel) => {
      if (index === 255) return;
      const x = pixel % animation.w,
        y = Math.floor(pixel / animation.w);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
  const [, bodyY, , bodyHeight] = animation.a0;
  const left = Math.floor((cell - (maxX - minX + 1) * clawdScale) / 2) - minX * clawdScale;
  const bodyCentred = Math.round(cell / 2 - (bodyY + bodyHeight / 2) * clawdScale);
  const fits =
    bodyCentred + minY * clawdScale >= clawdMargin &&
    bodyCentred + (maxY + 1) * clawdScale <= cell - clawdMargin;
  const top = fits
    ? bodyCentred
    : Math.floor((cell - (maxY - minY + 1) * clawdScale) / 2) - minY * clawdScale;
  return {
    left: Math.round(left / clawdScale) * clawdScale,
    top: Math.round(top / clawdScale) * clawdScale,
  };
}
const codexRows = [0, 3, 7, 6, 8, 5, 4];
const codexTimes = [
  [1680, 660, 660, 840, 840, 1920],
  [140, 140, 140, 280],
  [120, 120, 120, 120, 120, 220],
  [150, 150, 150, 150, 150, 260],
  [150, 150, 150, 150, 150, 280],
  [140, 140, 140, 140, 140, 140, 140, 240],
  [140, 140, 140, 140, 280],
];
// Recut Byte's existing poses; its original sheets and timings stay untouched.
// Each entry is [source row, source column, duration in milliseconds].
const byteSequences = {
  wink: [
    [0, 0, 2000],
    [0, 6, 160],
    [0, 0, 180],
    [0, 6, 160],
    [0, 0, 2600],
  ],
  content: [
    [0, 0, 1500],
    [0, 1, 160],
    [0, 2, 800],
    [0, 1, 160],
    [0, 0, 2600],
  ],
  stretch: [
    [4, 0, 200],
    [4, 1, 180],
    [4, 2, 350],
    [4, 3, 180],
    [4, 4, 400],
  ],
  "happy-dance": [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 4, 5].map((i) => [8, i, i === 4 ? 220 : 140]),
  "double-hop": [...[0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map((i) => [4, i, 130]), [8, 4, 350]],
  "victory-lap": [
    ...Array.from({ length: 8 }, (_, i) => [1, i, 100]),
    ...Array.from({ length: 8 }, (_, i) => [2, i, 100]),
    [8, 4, 450],
  ],
};
const mascotIds = Object.keys(variants);
for (const [mascotIndex, id] of mascotIds.entries()) {
  const animations = {};
  for (const [stateIndex, state] of states.entries()) {
    animations[state] = [];
    const choices = variants[id]?.[state] ?? [["default", 1]];
    for (const [variantIndex, [variant, weight, longTurnOnly = false]] of choices.entries()) {
      const buffers = [];
      let durations;
      let pixelSize = null;
      let pixels;
      // The same frames in light ink, for a flat pet that would vanish on a dark theme.
      let darkBuffers = null;
      let posterMs;
      const render = (frames) =>
        Promise.all(
          frames.map((frame) =>
            Buffer.isBuffer(frame) ? frame : sharp(Buffer.from(frame)).png().toBuffer(),
          ),
        );
      if (drawnPets[id]) {
        const art = drawnPets[id].draw(state, variant, false);
        durations = art.durations;
        pixelSize = art.pixelSize ?? null;
        posterMs = art.posterMs;
        buffers.push(...(await render(art.frames)));
        if (drawnPets[id].dark)
          darkBuffers = await render(drawnPets[id].draw(state, variant, true).frames);
      } else if (id === "claude") {
        const source = clawd[variant];
        const clawdScale = source.w > 36 || source.h > 36 ? 3 : 6;
        pixelSize = cell / clawdScale;
        // While working, Clawd keeps typing: loop the laptop animation's typing
        // frames (17-31 repeat seamlessly) rather than its get-out and put-away.
        // A four-second breakdance excerpt fits the temporary turn-result labels.
        const animation =
          variant === "Laptop"
            ? { ...source, frames: source.frames.slice(17, 32) }
            : variant === "BreakDancing"
              ? { ...source, frames: source.frames.slice(0, 48) }
              : source;
        durations = animation.frames.map(() => 1000 / animation.fps);
        const { left, top } = clawdPlacement(animation, clawdScale);
        // Native image views smooth even integer-sized sprites. Keep compact paths
        // for Clawd so the existing SVG renderer can draw exact source-pixel edges.
        pixels = animation.frames.map((frame) => {
          const paths = animation.palette.map(() => "");
          for (let y = 0; y < animation.h; y++) {
            for (let x = 0; x < animation.w;) {
              const color = frame[y * animation.w + x];
              let end = x + 1;
              while (end < animation.w && frame[y * animation.w + end] === color) end++;
              if (color !== 255)
                paths[color] += String.fromCharCode(
                  x + left / clawdScale + 33,
                  y + top / clawdScale + 33,
                  end - x + 33,
                );
              x = end;
            }
          }
          return paths
            .map((d, index) => (d ? [animation.palette[index], d] : null))
            .filter(Boolean);
        });
        for (const frame of animation.frames) {
          const rgba = Buffer.alloc(animation.w * animation.h * 4);
          frame.forEach((index, pixel) => {
            if (index === 255) return;
            const color = animation.palette[index].slice(1);
            for (let c = 0; c < 3; c++)
              rgba[pixel * 4 + c] = parseInt(color.slice(c * 2, c * 2 + 2), 16);
            rgba[pixel * 4 + 3] = 255;
          });
          const width = animation.w * clawdScale,
            height = animation.h * clawdScale;
          const input = await sharp(rgba, {
            raw: { width: animation.w, height: animation.h, channels: 4 },
          })
            .resize(width, height, { kernel: "nearest" })
            .png()
            .toBuffer();
          buffers.push(
            await sharp({
              create: { width: cell, height: cell, channels: 4, background: "#00000000" },
            })
              .composite([{ input, left, top }])
              .png()
              .toBuffer(),
          );
        }
      } else if (sheets[id]) {
        const extraRow = { "running-right": 1, "running-left": 2, jumping: 4, review: 8 }[variant];
        const sequence = (id === "codex" ? byteSequences : sheetSequences)[variant];
        durations = sequence
          ? sequence.map(([, , duration]) => duration)
          : state === "failed"
            ? codexTimes[5].slice(variant === "sad" ? 4 : 0, variant === "sad" ? 8 : 4)
            : variant === "look-around"
              ? Array(16).fill(400)
              : extraRow === 1 || extraRow === 2
                ? [120, 120, 120, 120, 120, 120, 120, 220]
                : extraRow === 4
                  ? codexTimes[6]
                  : extraRow === 8
                    ? codexTimes[4]
                    : codexTimes[stateIndex];
        for (let i = 0; i < durations.length; i++)
          buffers.push(
            await sharp(sheets[id])
              .extract({
                left: (sequence?.[i][1] ?? (i + (variant === "sad" ? 4 : 0)) % 8) * 192,
                top:
                  (sequence?.[i][0] ??
                    (variant === "look-around"
                      ? 9 + Math.floor(i / 8)
                      : (extraRow ?? codexRows[stateIndex]))) * 208,
                width: 192,
                height: 208,
              })
              .extend({ left: 12, right: 12, top: 4, bottom: 4, background: "#00000000" })
              .png()
              .toBuffer(),
          );
      } else {
        const count = state === "idle" ? 12 : 16;
        durations = Array.from({ length: count }, (_, i) =>
          state === "idle" ? (i === count - 1 ? 2400 : 200) : 100,
        );
        for (let i = 0; i < count; i++)
          buffers.push(
            await sharp(
              Buffer.from(
                id === "grok"
                  ? grok(state, i, count, variant)
                  : id === "muse"
                    ? jolly(state, i, count, variant)
                    : vectorPet(id, state, i, count, variant),
              ),
            )
              .png()
              .toBuffer(),
          );
      }
      if (preview) {
        await NodeFSP.mkdir(preview, { recursive: true });
        const rawFrames = await Promise.all(
          buffers.map((input) =>
            sharp(input)
              .flatten({ background: "#faf8f3" })
              .resize(144, 144, { kernel: id === "claude" ? "nearest" : "lanczos3" })
              .removeAlpha()
              .raw()
              .toBuffer(),
          ),
        );
        await sharp(Buffer.concat(rawFrames), {
          raw: { width: 144, height: 144 * rawFrames.length, channels: 3, pageHeight: 144 },
        })
          .gif({ delay: durations.map(Math.round), loop: 0 })
          .toFile(NodePath.resolve(preview, `${id}-${state}-${variant}.gif`));
      }
      if (preview) {
        const index = variantContacts.length / 2;
        const left = (index % 6) * 144;
        const top = Math.floor(index / 6) * 180;
        variantContacts.push({
          input: await sharp(buffers[state === "idle" ? 2 : Math.floor(buffers.length / 3)])
            .resize(144, 144, { kernel: id === "claude" ? "nearest" : "lanczos3" })
            .png()
            .toBuffer(),
          left,
          top,
        });
        variantContacts.push({
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="36"><text x="4" y="12" font-family="sans-serif" font-size="11" fill="#333">${id} / ${state}</text><text x="4" y="27" font-family="sans-serif" font-size="10" fill="#555">${variant}</text></svg>`,
          ),
          left,
          top: top + 144,
        });
      }
      const rows = Math.ceil(buffers.length / columns);
      const compose = async (frames) => {
        const composite = sharp({
          create: {
            width: columns * cell,
            height: rows * cell,
            channels: 4,
            background: "#00000000",
          },
        }).composite(
          frames.map((input, i) => ({
            input,
            left: (i % columns) * cell,
            top: Math.floor(i / columns) * cell,
          })),
        );
        if (id === "gemini") {
          // A shared palette keeps the Twins' repeated transparent glows inside the sheet budget.
          const indexed = await composite.png({ palette: true, dither: 0 }).toBuffer();
          return sharp(indexed).webp({ lossless: true, effort: 6 }).toBuffer();
        }
        // Pixel-art and flat-colour sheets stay lossless so their hard edges don't ring.
        return composite
          .webp(
            id === "claude" || (sheets[id] && id !== "codex") || id === "grok" || id === "mistral"
              ? { lossless: true, effort: 6 }
              : // Rendered fur carries far more detail than flat drawings; this keeps its sheets
                // inside the per-sheet budget.
                rendered.pets[id]
                ? { quality: 75, alphaQuality: 85, effort: 6 }
                : { quality: 85, alphaQuality: 95, effort: 6 },
          )
          .toBuffer();
      };
      const sheet = await compose(buffers);
      const darkSheet = darkBuffers ? await compose(darkBuffers) : null;
      let file = `${id}-${state}${variantIndex === 0 ? "" : `-${variant.toLowerCase()}`}.webp`;
      if (id === "claude" && variant === "Pointing") file = "claude-waiting-pointing.webp";
      if (id === "claude" && variant === "Excited") file = "claude-done.webp";
      if (sheets[id] && variant.startsWith("running-")) file = `${id}-idle-${variant}.webp`;
      if (id === "codex") {
        if (variant === "jumping") file = "codex-idea.webp";
        if (variant === "review") file = "codex-done.webp";
        if (variant === "look-around") file = "codex-idle-look-around.webp";
        if (variant.startsWith("running-")) file = `codex-idle-${variant}.webp`;
      }
      if (pixels) pixelFrames[file] = pixels;
      const darkFile = darkSheet ? file.replace(`${id}-`, `${id}-dark-`) : null;
      for (const directory of output) {
        if (darkSheet) await NodeFSP.writeFile(NodePath.resolve(directory, darkFile), darkSheet);
        // Eight device pixels per Clawd pixel at the 96pt/3x hero; smaller native
        // slots use the pixel paths below to avoid native image filtering.
        const platformSheet =
          id === "claude" && directory.includes("apps/mobile")
            ? await sharp(sheet)
                .resize(columns * 288, rows * 288, { kernel: "nearest" })
                .webp({ lossless: true })
                .toBuffer()
            : sheet;
        await NodeFSP.writeFile(NodePath.resolve(directory, file), platformSheet);
      }
      animations[state].push({
        variant,
        weight,
        longTurnOnly,
        pixelSize,
        file,
        ...(darkFile ? { darkFile } : {}),
        ...(posterMs === undefined ? {} : { posterMs }),
        columns,
        rows,
        durations,
        // Like the Codex app, its pet plays every state but idle three times and
        // then settles into the slow idle loop, rather than looping fast frames.
        repeats:
          (state === "idle" &&
            ![
              "CrabWalking",
              "Turning",
              "running-left",
              "running-right",
              "stretch",
              "wave",
            ].includes(variant)) ||
          (id !== "codex" && ["working", "waiting"].includes(state))
            ? null
            : state === "greet"
              ? 1
              : id === "codex"
                ? 3
                : // Rendered pets' celebrations are full four-second loops already.
                  state === "done" &&
                    !rendered.pets[id] &&
                    !["DancingHappy", "Confetti", "BreakDancing"].includes(variant)
                  ? 2
                  : 1,
      });
      const thumb = await sharp(
        buffers[
          state === "idle" ? 0 : Math.min(buffers.length - 1, Math.floor(buffers.length / 3))
        ],
      )
        .resize(108, 108, { kernel: id === "claude" ? "nearest" : "lanczos3" })
        .png()
        .toBuffer();
      if (variantIndex === 0)
        contacts.push({ input: thumb, left: stateIndex * 112 + 2, top: mascotIndex * 128 + 18 });
      if (
        preview &&
        variantIndex === 0 &&
        (id === "grok" || id === "muse") &&
        state === "working"
      ) {
        await NodeFSP.mkdir(preview, { recursive: true });
        await sharp({
          create: { width: cell * 4, height: cell * 2, channels: 4, background: "#faf8f3" },
        })
          .composite(
            buffers
              .filter((_, i) => i % 2 === 0)
              .map((input, i) => ({ input, left: (i % 4) * cell, top: Math.floor(i / 4) * cell })),
          )
          .png()
          .toFile(NodePath.resolve(preview, `${id}-working-contact.png`));
      }
      console.log(`${file}: ${sheet.length} bytes, ${buffers.length} frames`);
    }
  }
  manifest[id] = animations;
}
const usedFiles = new Set(
  Object.values(manifest).flatMap((animations) =>
    Object.values(animations).flatMap((choices) =>
      choices.flatMap((animation) => [animation.file, animation.darkFile].filter(Boolean)),
    ),
  ),
);
for (const directory of output) {
  for (const file of await NodeFSP.readdir(directory)) {
    if (
      mascotIds.some((id) => file.startsWith(`${id}-`)) &&
      file.endsWith(".webp") &&
      !usedFiles.has(file)
    )
      await NodeFSP.unlink(NodePath.resolve(directory, file));
  }
}
await NodeFSP.writeFile(
  NodePath.resolve(root, "packages/shared/src/harnessMascotAnimations.ts"),
  `// Generated by scripts/generate-harness-mascots.mjs.\n// Build-time aggregate for Quest. Clients use the per-pet harnessMascotLoaders.\nexport const HARNESS_MASCOT_ANIMATIONS = ${JSON.stringify(manifest, null, 2)} as const;\n`,
);
const dataDirectory = NodePath.resolve(root, "packages/shared/src/harnessMascotData");
const assetsDirectory = NodePath.resolve(root, "apps/mobile/src/components/harnessMascotAssets");
await NodeFSP.mkdir(dataDirectory, { recursive: true });
await NodeFSP.mkdir(assetsDirectory, { recursive: true });
for (const [id, animations] of Object.entries(manifest)) {
  await NodeFSP.writeFile(
    NodePath.resolve(dataDirectory, `${id}.ts`),
    `// Generated by scripts/generate-harness-mascots.mjs.\nexport default ${JSON.stringify(animations, null, 2)} as const;\n`,
  );
  // Native Clawd renders source pixels directly and does not need raster assets.
  const requires =
    id === "claude"
      ? {}
      : Object.fromEntries(
          Object.values(animations).flatMap((choices) =>
            choices.flatMap((animation) =>
              [animation.file, animation.darkFile]
                .filter(Boolean)
                .map((file) => [file, `REQUIRE:${file}`]),
            ),
          ),
        );
  await NodeFSP.writeFile(
    NodePath.resolve(assetsDirectory, `${id}.ts`),
    `// Generated by scripts/generate-harness-mascots.mjs.\nexport const sprites = ${JSON.stringify(requires, null, 2).replace(/"REQUIRE:([^"]+)"/g, (_, file) => `require("../../../assets/mascots/${file}")`)};\n${id === "claude" ? 'export { default as pixels } from "../../../assets/mascots/clawd-pixels.json";\n' : ""}`,
  );
}
await NodeFSP.writeFile(
  NodePath.resolve(root, "packages/shared/src/harnessMascotLoaders.ts"),
  `// Generated by scripts/generate-harness-mascots.mjs.\nexport const harnessMascotLoaders = {\n${mascotIds.map((id) => `  ${id}: () => import("./harnessMascotData/${id}.ts"),`).join("\n")}\n};\n`,
);
await NodeFSP.writeFile(
  NodePath.resolve(root, "apps/mobile/assets/mascots/clawd-pixels.json"),
  JSON.stringify(pixelFrames),
);
await NodeFSP.writeFile(
  NodePath.resolve(root, "apps/mobile/src/components/harnessMascotAssets.ts"),
  `// Generated by scripts/generate-harness-mascots.mjs.\nimport type { HarnessMascotId } from "@t3tools/shared/harnessMascots";\nexport type HarnessMascotAssetData = {\n  readonly sprites: Readonly<Record<string, number>>;\n  readonly pixels?: Readonly<Record<string, string[][][]>>;\n};\nconst loaders = {\n${mascotIds.map((id) => `  ${id}: () => import("./harnessMascotAssets/${id}"),`).join("\n")}\n};\nexport function loadHarnessMascotAssets(id: HarnessMascotId): Promise<HarnessMascotAssetData> {\n  return loaders[id]();\n}\n`,
);
if (preview) {
  await NodeFSP.mkdir(preview, { recursive: true });
  await sharp({
    create: {
      width: 864,
      height: Math.ceil(variantContacts.length / 12) * 180,
      channels: 4,
      background: "#faf8f3",
    },
  })
    .composite(variantContacts)
    .png()
    .toFile(NodePath.resolve(preview, "mascot-variants-contact.png"));
  for (const [appearance, background, textColor] of [
    ["light", "#faf8f3", "#333"],
    ["dark", "#202126", "#eee"],
  ]) {
    const labels = mascotIds.flatMap((id, index) =>
      states.map((state, stateIndex) => ({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="18"><text x="3" y="13" font-family="sans-serif" font-size="10" fill="${textColor}">${id} / ${state}</text></svg>`,
        ),
        left: stateIndex * 112,
        top: index * 128,
      })),
    );
    const contact = await sharp({
      create: { width: 784, height: mascotIds.length * 128, channels: 4, background },
    })
      .composite([...contacts, ...labels])
      .png()
      .toBuffer();
    await NodeFSP.writeFile(NodePath.resolve(preview, `mascot-contact-${appearance}.png`), contact);
    for (const id of vectorPets) {
      await sharp(contact)
        .extract({ left: 0, top: mascotIds.indexOf(id) * 128, width: 784, height: 128 })
        .png()
        .toFile(NodePath.resolve(preview, `${id}-contact-${appearance}.png`));
    }
  }
}

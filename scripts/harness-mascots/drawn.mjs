// Pets drawn in code with their own timing, for scripts/generate-harness-mascots.mjs.
//
// Grok Bot follows SpaceXAI's own icon: a flat orb with two pill eyes that morphs
// between states (three loading dots, an exclamation mark, a notification dot). It
// is one flat colour, so it comes in two inks: dark for light themes, light for dark.
//
// Le Chonk is Mistral's cat as drawn on its Mistral Large 4 page: a 17 x 15 mosaic
// of squares in six colours. It moves the way Mistral's own sitting cat does, a
// square at a time, and renders on the pixel grid so every square stays sharp.
//
// Capy is Qwen's capybara as its own banners draw it: tan, round ears, a tuft of
// hair, half-shut deadpan eyes, a white T-shirt with the purple mark.
//
// Each pet returns { frames: [svg], durations: [ms], pixelSize? } per state and variant.

export const svg = (content, size = 96, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="216" height="216" viewBox="0 0 ${size} ${size}" ${extra}>${content}</svg>`;
const n = (value) => Math.round(value * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;
const EASE = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t * t * t,
  back: (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2,
};

/**
 * Plays a list of steps from a starting set of numbers. A step moves the numbers it
 * names over `ms` and holds the rest. Frames are sampled at `fps`; a hold becomes one
 * long frame, so sheets stay small.
 */
function play(start, steps, draw, fps = 16) {
  const frames = [];
  const durations = [];
  const push = (image, ms) => {
    if (frames.length > 0 && frames[frames.length - 1] === image) {
      durations[durations.length - 1] += ms;
    } else {
      frames.push(image);
      durations.push(ms);
    }
  };
  let current = { ...start };
  for (const step of steps) {
    const { ms, ease = "inOut", fps: stepFps = fps, ...to } = step;
    const from = current;
    const target = { ...from, ...to };
    if (Object.keys(to).length === 0) {
      push(draw(from), ms);
      continue;
    }
    const count = Math.max(1, Math.round((ms / 1000) * stepFps));
    for (let i = 1; i <= count; i++) {
      const t = EASE[ease](i / count);
      const now = {};
      for (const key of Object.keys(target)) now[key] = lerp(from[key], target[key], t);
      push(draw(now), ms / count);
    }
    current = target;
  }
  return { frames, durations: durations.map((ms) => Math.round(ms)) };
}

// ---------------------------------------------------------------- Grok Bot

const eyes = (a, b) => ({
  e1x: a[0],
  e1y: a[1],
  e1w: a[2],
  e1h: a[3],
  e1r: a[4],
  e2x: b[0],
  e2y: b[1],
  e2w: b[2],
  e2h: b[3],
  e2r: b[4],
});
// Eye poses, relative to the orb's centre: [x, y, width, height, lean].
const LOOK = {
  rest: eyes([6, -13, 4.8, 11.5, -24], [18.5, -15.5, 4.4, 10.5, -24]),
  front: eyes([-7, -4, 6, 15, 14], [8, -2, 6, 15, 14]),
  happy: eyes([-6, 5, 9.5, 23, 15], [12, 9, 9, 21, 15]),
  left: eyes([-19, -9, 4.4, 10.5, 22], [-7, -11.5, 4.8, 11.5, 22]),
  sleepy: eyes([-12, -6, 5, 12, 8], [5, -2, 13, 2.8, 10]),
  bored: eyes([-10, -4, 10, 2.8, 8], [6, -2, 11, 2.8, 8]),
  wide: eyes([-11, 2, 10, 13.5, -8], [8, -1, 13, 13, 0]),
  sad: eyes([-9, -1, 5, 11.5, 28], [9, -1, 5, 11.5, -28]),
  wink: eyes([-7, -4, 6, 15, 14], [8, -2, 12, 2.8, 14]),
};
const blinked = (look) => ({ e1h: Math.min(look.e1h, 1.8), e2h: Math.min(look.e2h, 1.8) });
const GROK_START = {
  bx: 48,
  by: 48,
  bw: 62,
  bh: 62,
  br: 0,
  ...LOOK.rest,
  eo: 1, // eyes
  dots: 0,
  dp: 0, // the two loading dots beside the body, and where the pulse is
  bang: 0, // the dot under the exclamation mark
  note: 0,
  ping: 0, // notification dot and its ring
  sat: 0,
  sa: 0, // satellites and their angle
};

function grokFrame(p, dark) {
  const ink = dark ? "#f4f4f5" : "#0b0b0d";
  const paper = dark ? "#0b0b0d" : "#fafafa";
  const pill = (x, y, w, h, r, fill, opacity = 1) =>
    w <= 0.05 || h <= 0.05 || opacity <= 0.01
      ? ""
      : `<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(w, h) / 2)}" fill="${fill}"${opacity < 0.995 ? ` opacity="${n(opacity)}"` : ""}${Math.abs(r) > 0.05 ? ` transform="rotate(${n(r)} ${n(x)} ${n(y)})"` : ""}/>`;
  const satellite = (angle) => {
    const x = p.bx + Math.cos(angle) * 41;
    const y = p.by + Math.sin(angle) * 7;
    return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(4.2 * p.sat)}" fill="${ink}" opacity="${n(0.55 + 0.45 * Math.sin(angle))}"/>`;
  };
  const sats = p.sat > 0.02 ? [p.sa, p.sa + Math.PI] : [];
  const behind = sats
    .filter((a) => Math.sin(a) < 0)
    .map(satellite)
    .join("");
  const infront = sats
    .filter((a) => Math.sin(a) >= 0)
    .map(satellite)
    .join("");
  const pulse = (k) => 0.3 + 0.7 * Math.max(0, Math.cos(p.dp - (k * Math.PI * 2) / 3)) ** 2;
  const side = (k, x) =>
    p.dots > 0.02
      ? `<circle cx="${n(p.bx + x * p.dots)}" cy="${n(p.by)}" r="${n(5.5 * p.dots)}" fill="${ink}" opacity="${n(pulse(k))}"/>`
      : "";
  const body = pill(p.bx, p.by, p.bw, p.bh, 0, ink, p.dots > 0.5 ? pulse(1) : 1);
  const face =
    pill(p.bx + p.e1x, p.by + p.e1y, p.e1w, p.e1h, p.e1r, paper, p.eo) +
    pill(p.bx + p.e2x, p.by + p.e2y, p.e2w, p.e2h, p.e2r, paper, p.eo);
  const bang =
    p.bang > 0.02
      ? `<circle cx="${n(p.bx)}" cy="${n(p.by + p.bh / 2 + 9)}" r="${n(5.6 * p.bang)}" fill="${ink}"/>`
      : "";
  const noteX = p.bx + 22.5;
  const noteY = p.by - 22.5;
  const note =
    p.note > 0.02
      ? `${p.ping > 0.02 && p.ping < 0.98 ? `<circle cx="${n(noteX)}" cy="${n(noteY)}" r="${n(6 + 9 * p.ping)}" fill="none" stroke="#1d9bf0" stroke-width="1.6" opacity="${n(1 - p.ping)}"/>` : ""}<circle cx="${n(noteX)}" cy="${n(noteY)}" r="${n(7 * p.note)}" fill="${paper}"/><circle cx="${n(noteX)}" cy="${n(noteY)}" r="${n(5 * p.note)}" fill="#1d9bf0"/>`
      : "";
  return svg(
    `${behind}${side(0, -18)}${side(2, 18)}<g${Math.abs(p.br) > 0.05 ? ` transform="rotate(${n(p.br)} ${n(p.bx)} ${n(p.by)})"` : ""}>${body}${face}${bang}</g>${note}${infront}`,
  );
}

const hop = (look, height = 16) => [
  { ms: 110, by: 51, bw: 68, bh: 55, ease: "out" },
  { ms: 170, by: 48 - height, bw: 57, bh: 68, ...look, ease: "out" },
  { ms: 150, by: 51, bw: 69, bh: 54, ease: "in" },
  { ms: 150, by: 48, bw: 62, bh: 62, ease: "back" },
];
const blink = (look) => [
  { ms: 70, ...blinked(look), ease: "in" },
  { ms: 100, ...look, ease: "out" },
];
const GROK = {
  idle: {
    default: [
      { ms: 1500 },
      ...blink(LOOK.rest),
      { ms: 700 },
      { ms: 520, bw: 63.5, bh: 63.5, by: 47.4 },
      { ms: 520, bw: 62, bh: 62, by: 48 },
      { ms: 900 },
    ],
    "look-around": [
      { ms: 500 },
      { ms: 340, ...LOOK.front },
      { ms: 520 },
      { ms: 380, ...LOOK.left },
      { ms: 640 },
      ...blink(LOOK.left),
      { ms: 300 },
      { ms: 340, ...LOOK.front },
      { ms: 380, ...LOOK.rest },
      { ms: 700 },
    ],
    curious: [
      { ms: 500 },
      { ms: 200, ...LOOK.wide, bw: 64.5, bh: 64.5, ease: "back" },
      { ms: 760 },
      ...blink(LOOK.wide),
      { ms: 420 },
      { ms: 340, ...LOOK.rest, bw: 62, bh: 62 },
      { ms: 800 },
    ],
    doze: [
      { ms: 500 },
      { ms: 480, ...LOOK.sleepy },
      { ms: 800 },
      { ms: 420, ...LOOK.bored, by: 49.5, bh: 59.5, bw: 63.5 },
      { ms: 900 },
      { ms: 700, by: 48.6, bh: 61, bw: 62.6 },
      { ms: 700, by: 49.5, bh: 59.5, bw: 63.5 },
      { ms: 900 },
      { ms: 460, ...LOOK.rest, by: 48, bh: 62, bw: 62 },
      { ms: 600 },
    ],
  },
  greet: {
    default: [
      { ms: 1, bw: 5, bh: 5, eo: 0, ...LOOK.front },
      { ms: 120 },
      { ms: 240, bw: 68, bh: 68, ease: "out" },
      { ms: 130, bw: 60, bh: 60 },
      { ms: 110, bw: 62, bh: 62 },
      { ms: 160, eo: 1 },
      { ms: 240, ...LOOK.happy },
      { ms: 560 },
      ...blink(LOOK.happy),
      { ms: 300 },
      { ms: 360, ...LOOK.rest },
      { ms: 500 },
    ],
    hop: [
      { ms: 200, ...LOOK.front },
      ...hop(LOOK.happy, 15),
      ...hop(LOOK.happy, 9),
      { ms: 420 },
      { ms: 360, ...LOOK.rest },
      { ms: 500 },
    ],
  },
  working: {
    default: [
      { ms: 260, ...LOOK.front },
      { ms: 320, e1x: -15, e2x: 0, br: -5 },
      { ms: 240 },
      { ms: 520, e1x: 1, e2x: 16, br: 5 },
      { ms: 240 },
      { ms: 320, ...LOOK.front, br: 0 },
      ...blink(LOOK.front),
      { ms: 260 },
      { ms: 320, e1x: -15, e2x: 0, br: -5 },
      { ms: 200 },
      { ms: 520, e1x: 1, e2x: 16, br: 5 },
      { ms: 200 },
      { ms: 320, ...LOOK.front, br: 0 },
      { ms: 300 },
      { ms: 300, ...LOOK.rest },
      { ms: 200 },
    ],
    dots: [
      { ms: 200 },
      { ms: 130, eo: 0 },
      { ms: 280, bw: 11, bh: 11, ease: "in" },
      { ms: 200, dots: 1, ease: "back" },
      { ms: 1900, dp: Math.PI * 6, ease: "linear", fps: 12 },
      { ms: 150, dots: 0, ease: "in" },
      { ms: 260, bw: 66, bh: 66, ease: "out" },
      { ms: 130, bw: 62, bh: 62 },
      { ms: 160, eo: 1 },
      { ms: 500 },
    ],
    orbit: [
      { ms: 260, ...LOOK.front },
      { ms: 220, sat: 1, ease: "back" },
      { ms: 2200, sa: Math.PI * 4, ease: "linear", fps: 14 },
      { ms: 180, sat: 0, ease: "in" },
      ...blink(LOOK.front),
      { ms: 300 },
      { ms: 300, ...LOOK.rest },
      { ms: 200 },
    ],
  },
  waiting: {
    default: [
      { ms: 420, ...LOOK.sleepy },
      { ms: 1100 },
      { ms: 380, ...LOOK.left },
      { ms: 620 },
      { ms: 400, ...LOOK.sleepy },
      { ms: 500 },
      { ms: 300, ...LOOK.bored },
      { ms: 700 },
      { ms: 300, ...LOOK.sleepy },
      { ms: 800 },
      { ms: 380, ...LOOK.rest },
      { ms: 300 },
    ],
    tap: [
      { ms: 380, ...LOOK.bored },
      { ms: 520, br: -7 },
      { ms: 620, br: 7 },
      { ms: 620, br: -7 },
      { ms: 620, br: 7 },
      { ms: 420, br: 0 },
      { ms: 500 },
      { ms: 380, ...LOOK.rest },
      { ms: 300 },
    ],
  },
  done: {
    default: [
      { ms: 160, ...LOOK.front },
      ...hop(LOOK.happy, 17),
      { ms: 520 },
      ...blink(LOOK.happy),
      { ms: 360 },
      { ms: 360, ...LOOK.rest },
      { ms: 300 },
    ],
    spin: [
      { ms: 160, ...LOOK.happy },
      { ms: 110, by: 51, bw: 68, bh: 55, ease: "out" },
      { ms: 240, by: 31, bw: 59, bh: 66, br: 180, ease: "out" },
      { ms: 240, by: 51, bw: 68, bh: 55, br: 360, ease: "in" },
      { ms: 160, by: 48, bw: 62, bh: 62, ease: "back" },
      { ms: 1, br: 0 },
      { ms: 600 },
      { ms: 360, ...LOOK.rest },
      { ms: 300 },
    ],
    wink: [
      { ms: 240, ...LOOK.front },
      { ms: 300 },
      { ms: 110, ...LOOK.wink, br: 6 },
      { ms: 620 },
      { ms: 160, ...LOOK.front, br: 0 },
      { ms: 240, ...LOOK.happy },
      { ms: 600 },
      { ms: 360, ...LOOK.rest },
      { ms: 300 },
    ],
  },
  failed: {
    default: [
      { ms: 200 },
      { ms: 120, eo: 0 },
      { ms: 260, bw: 12.5, bh: 36, by: 41, br: 13, ease: "back" },
      { ms: 150, bang: 1, ease: "back" },
      { ms: 90, br: 5 },
      { ms: 90, br: 20 },
      { ms: 90, br: 8 },
      { ms: 90, br: 13 },
      { ms: 1300 },
      { ms: 120, bang: 0, ease: "in" },
      { ms: 260, bw: 62, bh: 62, by: 48, br: 0, ease: "out" },
      { ms: 1, ...LOOK.sad },
      { ms: 180, eo: 1 },
      { ms: 900 },
      { ms: 400, ...LOOK.rest },
      { ms: 300 },
    ],
    sad: [
      { ms: 200 },
      { ms: 380, ...LOOK.sad, by: 51, bh: 58, bw: 64 },
      { ms: 1000 },
      ...blink(LOOK.sad),
      { ms: 500 },
      { ms: 600, bh: 56.5, bw: 65 },
      { ms: 600, bh: 58, bw: 64 },
      { ms: 700 },
      { ms: 420, ...LOOK.rest, by: 48, bh: 62, bw: 62 },
      { ms: 300 },
    ],
  },
  idea: {
    default: [
      { ms: 200 },
      { ms: 170, ...LOOK.wide, bw: 64, bh: 64, ease: "back" },
      { ms: 200, note: 1, ease: "back" },
      { ms: 560, ping: 1, ease: "out" },
      { ms: 1, ping: 0 },
      { ms: 300 },
      { ms: 560, ping: 1, ease: "out" },
      { ms: 1, ping: 0 },
      { ms: 300, ...LOOK.rest, bw: 62, bh: 62 },
      { ms: 900 },
      { ms: 160, note: 0, ease: "in" },
      { ms: 300 },
    ],
    eureka: [
      { ms: 160, ...LOOK.front },
      ...hop(LOOK.wide, 14),
      { ms: 180, note: 1, ease: "back" },
      { ms: 560, ping: 1, ease: "out" },
      { ms: 1, ping: 0 },
      { ms: 300, ...LOOK.happy },
      { ms: 800 },
      { ms: 160, note: 0, ease: "in" },
      { ms: 340, ...LOOK.rest },
      { ms: 300 },
    ],
  },
};

// Where a still picture of each state is taken from its first animation, in ms.
const GROK_POSTER = { working: 700, waiting: 1000, done: 520, failed: 1300, idea: 900 };
const CAT_POSTER = { working: 500, done: 300, failed: 600, idea: 200 };
const CAPY_POSTER = { working: 600, waiting: 1300, done: 420, failed: 900, idea: 700 };
const poster = (table, state, variant) =>
  variant === "default" && table[state] !== undefined ? { posterMs: table[state] } : {};

export function grokBot(state, variant, dark = false) {
  const steps = GROK[state]?.[variant] ?? GROK[state]?.default ?? GROK.idle.default;
  return {
    ...play(GROK_START, steps, (p) => grokFrame(p, dark)),
    ...poster(GROK_POSTER, state, variant),
  };
}

// ---------------------------------------------------------------- Le Chonk

// Mistral's cat, square for square, from the Mistral Large 4 page.
const CAT = [
  ".....a...a.......",
  ".....aa.ab.......",
  "....acccccb......",
  "...aacececab.....",
  "...acccecccb.....",
  "....ddddddd......",
  "...acccfcccb.....",
  "...acccccaab.....",
  "...bacccacccb....",
  "...acaacccaaab...",
  "..bccccccacacb...",
  "..aaaaacccccab...",
  "..bcaccccaaacb...",
  "..acccccccccabb..",
  "bbbbbbbbbbbbbb...",
];
const CAT_COLORS = {
  a: "#FF6529",
  b: "#FA500F",
  c: "#FF8204",
  d: "#E51300",
  e: "#171722",
  f: "#FEC63A",
  g: "#FFF1B8",
};
// The tail, as [column, row] squares: up (as drawn), straight, curled in, and low.
const TAILS = [
  [
    [15, 7],
    [16, 8],
    [16, 9],
    [16, 10],
    [15, 11],
    [15, 12],
  ],
  [
    [16, 6],
    [16, 7],
    [16, 8],
    [16, 9],
    [16, 10],
    [15, 11],
    [15, 12],
  ],
  [
    [14, 7],
    [15, 8],
    [16, 9],
    [16, 10],
    [15, 11],
    [15, 12],
  ],
  [
    [16, 11],
    [16, 12],
    [15, 12],
    [16, 10],
  ],
];
const GLYPHS = {
  dots1: [[12, 4]],
  dots2: [
    [12, 4],
    [14, 4],
  ],
  dots3: [
    [12, 4],
    [14, 4],
    [16, 4],
  ],
  ask: [
    [13, 0],
    [14, 0],
    [15, 1],
    [14, 2],
    [14, 4],
  ],
  bulb: [
    [14, 0],
    [13, 1],
    [14, 1],
    [15, 1],
    [14, 2],
  ],
  zed: [
    [13, 1],
    [14, 1],
    [14, 2],
    [13, 3],
    [14, 3],
  ],
};
const SPARKS = [
  [1, 2],
  [13, 1],
  [16, 4],
  [0, 7],
  [14, 3],
  [2, 0],
];
const UNIT = 12;
const CAT_LEFT = 6;
const CAT_TOP = 24;

/**
 * One pose of the cat. head: columns the head leans (-1, 0, 1); lift: squares off
 * the ground; shut: eyes closed; ears: "up", "left" (left ear folded) or "flat".
 */
function catFrame({
  tail = 0,
  head = 0,
  lift = 0,
  shut = false,
  ears = "up",
  paw = null,
  glyph = null,
  lit = false,
  sparks = [],
}) {
  const cells = new Map();
  const put = (column, row, color) => {
    if (column < 0 || column > 16 || row < -2 || row > 14) return;
    cells.set(`${column},${row}`, color);
  };
  CAT.forEach((line, row) => {
    const ground = row === 14;
    [...line].forEach((color, column) => {
      if (color === ".") return;
      if (ground) {
        // The floor stays put; it shortens under a jump, like a shadow.
        if (lift === 0 || (column >= lift * 2 && column <= 13 - lift * 2)) put(column, row, color);
        return;
      }
      if (row === 0 && (ears === "flat" || (ears === "left" && column === 5))) return;
      const shifted = row <= 4 ? column + head : column;
      const eye = row === 3 && (column === 6 || column === 8);
      put(shifted, row - lift, eye && shut ? "b" : color);
    });
  });
  for (const [column, row] of TAILS[tail]) put(column, row - lift, "b");
  if (paw === "low") {
    put(1, 12 - lift, "a");
    put(0, 11 - lift, "b");
  } else if (paw === "high") {
    put(1, 11 - lift, "a");
    put(1, 10 - lift, "b");
  }
  for (const [column, row] of glyph ? GLYPHS[glyph] : []) put(column, row, lit ? "g" : "f");
  for (const index of sparks) put(SPARKS[index][0], SPARKS[index][1], "f");
  // One path per colour, each row merged into runs, so no seams show between squares.
  const paths = {};
  for (let row = -2; row <= 14; row++) {
    for (let column = 0; column <= 16;) {
      const color = cells.get(`${column},${row}`);
      if (!color) {
        column++;
        continue;
      }
      let end = column + 1;
      while (end <= 16 && cells.get(`${end},${row}`) === color) end++;
      paths[color] =
        (paths[color] ?? "") +
        `M${CAT_LEFT + column * UNIT} ${CAT_TOP + row * UNIT}h${(end - column) * UNIT}v${UNIT}h-${(end - column) * UNIT}z`;
      column = end;
    }
  }
  return svg(
    Object.entries(paths)
      .map(([color, d]) => `<path d="${d}" fill="${CAT_COLORS[color]}"/>`)
      .join(""),
    216,
    'shape-rendering="crispEdges"',
  );
}

const flick = [
  [{ tail: 1 }, 170],
  [{}, 170],
  [{ tail: 1 }, 170],
];
const CAT_MOVES = {
  idle: {
    default: [
      [{}, 1900],
      [{ shut: true }, 130],
      [{}, 800],
      ...flick,
      [{}, 1100],
      [{ ears: "left" }, 120],
      [{}, 700],
    ],
    look: [
      [{}, 600],
      [{ head: -1 }, 620],
      [{ head: -1, shut: true }, 120],
      [{ head: -1 }, 380],
      [{}, 320],
      [{ head: 1, tail: 2 }, 700],
      [{ tail: 2 }, 300],
      [{}, 900],
    ],
    tail: [
      [{}, 700],
      [{ tail: 2 }, 340],
      [{}, 300],
      [{ tail: 1 }, 340],
      [{}, 300],
      [{ tail: 2 }, 340],
      [{ tail: 2, shut: true }, 130],
      [{ tail: 2 }, 500],
      [{}, 900],
    ],
    nap: [
      [{}, 500],
      [{ shut: true, tail: 2 }, 1500],
      [{ shut: true, tail: 2, glyph: "zed" }, 1100],
      [{ shut: true, tail: 2, ears: "left" }, 140],
      [{ shut: true, tail: 2, glyph: "zed" }, 1300],
      [{ shut: true, tail: 2 }, 600],
      [{ tail: 2 }, 400],
      [{}, 700],
    ],
  },
  greet: {
    default: [
      [{ paw: "low" }, 160],
      [{ paw: "high" }, 160],
      [{ paw: "low", head: -1 }, 160],
      [{ paw: "high", head: -1 }, 160],
      [{ paw: "low", head: -1, shut: true }, 160],
      [{ paw: "high" }, 160],
      [{ paw: "low" }, 200],
      [{ tail: 1 }, 200],
      [{}, 500],
    ],
    hop: [
      [{ lift: 1, paw: "high" }, 100],
      [{ lift: 2, paw: "high", tail: 1 }, 150],
      [{ lift: 1, paw: "low" }, 100],
      [{ paw: "low" }, 130],
      [{ lift: 1, paw: "high", shut: true }, 100],
      [{ lift: 2, paw: "high", tail: 1, shut: true }, 150],
      [{ lift: 1, paw: "low" }, 100],
      [{}, 600],
    ],
  },
  working: {
    default: [
      [{ glyph: "dots1" }, 240],
      [{ glyph: "dots2", tail: 1 }, 240],
      [{ glyph: "dots3" }, 240],
      [{ glyph: "dots3", tail: 1, shut: true }, 130],
      [{ tail: 1 }, 220],
      [{ glyph: "dots1", head: -1 }, 240],
      [{ glyph: "dots2", head: -1, tail: 2 }, 240],
      [{ glyph: "dots3", head: -1 }, 240],
      [{ tail: 2 }, 260],
    ],
    focus: [
      [{ head: -1, tail: 2 }, 520],
      [{ head: -1, tail: 2, ears: "left" }, 120],
      [{ head: -1 }, 420],
      [{ head: -1, shut: true }, 120],
      [{ tail: 1 }, 300],
      [{ head: 1, glyph: "dots3" }, 520],
      [{ head: 1, glyph: "dots2", tail: 1 }, 300],
      [{ glyph: "dots1" }, 300],
    ],
  },
  waiting: {
    default: [
      [{ glyph: "ask", head: 1 }, 1100],
      [{ glyph: "ask", head: 1, shut: true }, 130],
      [{ glyph: "ask", head: 1, tail: 1 }, 420],
      [{ glyph: "ask" }, 700],
      [{ glyph: "ask", tail: 2 }, 420],
      [{ glyph: "ask", head: 1 }, 600],
      [{ head: 1 }, 380],
    ],
    tail: [
      [{ head: 1 }, 700],
      [{ head: 1, tail: 1 }, 320],
      [{ head: 1 }, 320],
      [{ head: 1, tail: 1 }, 320],
      [{ glyph: "ask" }, 900],
      [{ glyph: "ask", shut: true }, 130],
      [{ glyph: "ask", tail: 2 }, 600],
    ],
  },
  done: {
    default: [
      [{ lift: 1, shut: true }, 90],
      [{ lift: 2, shut: true, tail: 1, sparks: [0, 1] }, 150],
      [{ lift: 2, shut: true, tail: 1, sparks: [2, 3] }, 130],
      [{ lift: 1, shut: true, sparks: [0, 4] }, 90],
      [{ shut: true, sparks: [1, 5] }, 140],
      [{ sparks: [2, 3] }, 140],
      [{ tail: 1, sparks: [0, 4] }, 140],
      [{ sparks: [5] }, 140],
      [{}, 500],
    ],
    dance: [
      [{ head: -1, tail: 1, shut: true }, 160],
      [{ lift: 1, head: -1, shut: true, sparks: [1] }, 150],
      [{ head: 1, tail: 2, shut: true }, 160],
      [{ lift: 1, head: 1, shut: true, sparks: [0] }, 150],
      [{ head: -1, tail: 1, shut: true }, 160],
      [{ lift: 1, head: -1, shut: true, sparks: [4] }, 150],
      [{ head: 1, tail: 2 }, 160],
      [{ lift: 1, sparks: [2, 3] }, 150],
      [{}, 500],
    ],
    purr: [
      [{ shut: true, tail: 2 }, 500],
      [{ shut: true, tail: 2, sparks: [1] }, 240],
      [{ shut: true, tail: 1, sparks: [0, 2] }, 240],
      [{ shut: true, tail: 2, sparks: [4] }, 240],
      [{ shut: true, tail: 1, sparks: [3, 5] }, 240],
      [{ tail: 2 }, 400],
      [{}, 500],
    ],
  },
  failed: {
    default: [
      [{ ears: "flat" }, 300],
      [{ ears: "flat", shut: true, tail: 3 }, 1500],
      [{ ears: "flat", tail: 3 }, 500],
      [{ ears: "flat", shut: true, tail: 3 }, 1100],
      [{ ears: "flat", tail: 3 }, 600],
      [{ tail: 3 }, 500],
    ],
    shake: [
      [{ ears: "flat", head: -1 }, 110],
      [{ ears: "flat", head: 1 }, 110],
      [{ ears: "flat", head: -1 }, 110],
      [{ ears: "flat", head: 1, shut: true }, 110],
      [{ ears: "flat", shut: true, tail: 3 }, 1200],
      [{ ears: "flat", tail: 3 }, 700],
      [{ tail: 3 }, 500],
    ],
  },
  idea: {
    default: [
      [{ lift: 1, glyph: "bulb" }, 140],
      [{ lift: 1, glyph: "bulb", lit: true }, 150],
      [{ glyph: "bulb", tail: 1 }, 150],
      [{ glyph: "bulb", lit: true }, 150],
      [{ glyph: "bulb", tail: 1 }, 150],
      [{ glyph: "bulb", lit: true, head: 1 }, 800],
      [{ glyph: "bulb", head: 1, shut: true }, 130],
      [{ glyph: "bulb", head: 1 }, 500],
    ],
    eureka: [
      [{ lift: 1, glyph: "bulb", lit: true }, 100],
      [{ lift: 2, glyph: "bulb", sparks: [0, 3] }, 150],
      [{ lift: 1, glyph: "bulb", lit: true }, 100],
      [{ glyph: "bulb", sparks: [0] }, 150],
      [{ glyph: "bulb", lit: true, tail: 1 }, 150],
      [{ glyph: "bulb", head: 1 }, 700],
      [{ glyph: "bulb", lit: true, head: 1 }, 400],
    ],
  },
};

export function leChonk(state, variant) {
  const moves = CAT_MOVES[state]?.[variant] ?? CAT_MOVES[state]?.default ?? CAT_MOVES.idle.default;
  return {
    frames: moves.map(([pose]) => catFrame(pose)),
    durations: moves.map(([, ms]) => ms),
    // 216 px across at 12 px a square: 18 squares, so clients can keep them sharp.
    pixelSize: 216 / UNIT,
    ...poster(CAT_POSTER, state, variant),
  };
}

// ---------------------------------------------------------------- Capy

// Colours sampled from Qwen's own capybara art.
const FUR = "#c3a67a";
const FUR_DARK = "#a3805a";
const OUTLINE = "#4b3020";
// Qwen's own mark (three bars in a pinwheel), not a four-point sparkle: that one is Gemini's.
const QWEN_MARK = "#615ced";

const CAPY_START = {
  y: 0, // whole body, up is negative
  sx: 1,
  sy: 1, // squash about the feet
  hy: 0,
  ht: 0, // head: down, tilt
  eye: 1,
  look: 0, // eye openness (0 shut, 1 deadpan, 1.3 wide), glance
  al: 14,
  ar: -14, // arm angles; 0 hangs straight down
  laptop: 0,
  bulb: 0,
  sweat: 0,
  heart: 0,
  zed: 0,
  dots: 0,
};

function capyFrame(p) {
  const stroke = `stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
  const arm = (x, angle) =>
    `<g transform="translate(${x} 63.5) rotate(${n(angle)})"><rect x="-4" y="1" width="8" height="16.5" rx="4" fill="${FUR}" ${stroke}/><rect x="-5.2" y="-2" width="10.4" height="8" rx="3.4" fill="#fbfaf6" ${stroke}/></g>`;
  // A raised or typing arm is in front of the head; a hanging one is behind it.
  const front = (angle) => p.laptop > 0.5 || Math.abs(angle) > 60;
  const shut = p.eye < 0.3;
  // Qwen draws the eyes half shut: a thick, level lid with the pupil peeking out
  // under it. No brow line above the eye: that reads as a frown.
  const eye = (x) => {
    if (shut)
      return `<path d="M${n(x - 3.4)} 36.6h6.8" fill="none" ${stroke.replace('"2"', '"2.4"')}/>`;
    if (p.eye > 1.15) {
      const open = Math.min(1, (p.eye - 1.15) / 0.15);
      return `<ellipse cx="${n(x + p.look)}" cy="36.2" rx="2.3" ry="${n(1.9 + open * 0.8)}" fill="${OUTLINE}"/><circle cx="${n(x + p.look + 0.8)}" cy="${n(35.3 - open * 0.4)}" r=".7" fill="#fbfaf6"/>`;
    }
    const peek = n(1.9 * Math.min(1, p.eye));
    return `<path d="M${n(x + p.look - 2.2)} 36.2a2.2 ${peek} 0 0 0 4.4 0Z" fill="${OUTLINE}"/><path d="M${n(x - 3.6)} 36.2h7.2" fill="none" ${stroke.replace('"2"', '"2.4"')}/>`;
  };
  const head = `<g transform="translate(0 ${n(p.hy)}) rotate(${n(p.ht)} 48 58)">
<circle cx="28.5" cy="22.5" r="6.8" fill="${FUR}" ${stroke}/><circle cx="67.5" cy="22.5" r="6.8" fill="${FUR}" ${stroke}/>
<circle cx="28.5" cy="22.5" r="3" fill="${FUR_DARK}"/><circle cx="67.5" cy="22.5" r="3" fill="${FUR_DARK}"/>
<path d="M29.5 21C36 13.5 60 13.5 66.5 21C74 29 76.5 44 73 52C70 59.5 58 61.5 48 61.5C38 61.5 26 59.5 23 52C19.5 44 22 29 29.5 21Z" fill="${FUR}" ${stroke.replace('"2"', '"2.2"')}/>
<path d="M41.3 16.4q2.4-5.4 4.7-.7q1.9-5.5 4.5-.2q2.2-4.7 4.4.7" fill="${FUR}" ${stroke}/>
<rect x="40.2" y="37.6" width="15.6" height="20.6" rx="7.6" fill="${FUR_DARK}"/>
<ellipse cx="48" cy="42.6" rx="3" ry="2.1" fill="${OUTLINE}"/>
<path d="M48 44.6V49.4M48 49.4Q46.4 50.2 45.4 51.9M48 49.4Q49.6 50.2 50.6 51.9" fill="none" stroke="${OUTLINE}" stroke-width="1.6" stroke-linecap="round"/>
${eye(35.8)}${eye(60.2)}
<path d="M19.4 45.6h3.2M19.8 48.8h3M73.4 45.6h3.2M73.2 48.8h3" fill="none" stroke="${OUTLINE}" stroke-width="1.6" stroke-linecap="round"/>
${p.sweat > 0.02 ? `<path d="M73.5 ${n(27 + p.sweat * 7)}q3 4.6 0 6.4q-3-1.8 0-6.4Z" fill="#7cc4f4" stroke="#3c8fc4" stroke-width=".8" opacity="${n(Math.min(1, p.sweat * 3))}"/>` : ""}
</g>`;
  const laptop =
    p.laptop > 0.02
      ? `<g transform="translate(48 ${n(77.5 + (1 - p.laptop) * 12)})" opacity="${n(Math.min(1, p.laptop * 1.5))}"><rect x="-14" y="-9" width="28" height="15" rx="2.6" fill="#dfe1e8" ${stroke}/><circle cx="0" cy="-1.6" r="2.3" fill="#615ced"/></g>`
      : "";
  const bulb =
    p.bulb > 0.02
      ? `<g transform="translate(78 12) scale(${n(p.bulb)})"><path d="M-7.5 0h-3M7.5 0h3M0-8.5v-3M-5.6-5.6l-2-2M5.6-5.6l2-2" fill="none" stroke="#f2b632" stroke-width="1.5" stroke-linecap="round"/><circle r="5.4" fill="#ffd45c" stroke="#b9831c" stroke-width="1.2"/><rect x="-2.4" y="4.6" width="4.8" height="3.4" rx="1" fill="#b9831c"/></g>`
      : "";
  const heart =
    p.heart > 0.02
      ? `<path transform="translate(76 ${n(22 - p.heart * 12)}) scale(${n(0.5 + p.heart * 0.5)})" d="M0 4.8C-7.5-.2-5.4-6.6-1.6-6.2C-.6-6.1 0-5.2 0-4.4C0-5.2.6-6.1 1.6-6.2C5.4-6.6 7.5-.2 0 4.8Z" fill="#ff6f91" stroke="#c7385c" stroke-width="1" opacity="${n(Math.min(1, (1 - p.heart) * 2.5 + 0.35))}"/>`
      : "";
  const zed =
    p.zed > 0.02
      ? `<g fill="none" stroke="#615ced" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="${n(Math.min(1, p.zed * 2) * (p.zed > 0.75 ? (1 - p.zed) * 4 : 1))}"><path d="M${n(73)} ${n(22 - p.zed * 8)}h5l-5 5h5"/><path d="M${n(80)} ${n(12 - p.zed * 6)}h3.6l-3.6 3.6h3.6"/></g>`
      : "";
  const dots =
    p.dots > 0.4
      ? `<g><path d="M62 4.5h23a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-14l-5 4 1-4h-5a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" fill="#fbfaf6" ${stroke.replace('"2"', '"1.6"')}/>${[
          0, 1, 2,
        ]
          .map((k) =>
            p.dots > k + 0.4
              ? `<circle cx="${68.5 + k * 6}" cy="11.5" r="1.7" fill="${OUTLINE}"/>`
              : "",
          )
          .join("")}</g>`
      : "";
  return svg(
    `<ellipse cx="48" cy="90" rx="${n(21 + p.y * 0.35)}" ry="3" fill="#2a1a10" opacity=".14"/>
<g transform="translate(0 ${n(p.y)}) translate(48 89) scale(${n(p.sx)} ${n(p.sy)}) translate(-48 -89)">
<ellipse cx="39.5" cy="85" rx="6.5" ry="4.2" fill="${FUR}" ${stroke}/><ellipse cx="56.5" cy="85" rx="6.5" ry="4.2" fill="${FUR}" ${stroke}/>
<path d="M32.5 62C32 57 64 57 63.5 62L66 80C66 85.5 30 85.5 30 80Z" fill="#fbfaf6" ${stroke}/>
<path transform="translate(42.6 67.4) scale(.45)" d="M19.713 2.825h-5.907c0-.251-.066-.503-.196-.728L12.819.728A1.46 1.46 0 0 0 11.559 0h-1.58c-.52 0-1 .275-1.26.728l-2.42 4.19a1.45 1.45 0 0 0 0 1.453l.791 1.37c.26.448.74.727 1.26.727h11.36c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-.79-1.37a1.46 1.46 0 0 0-1.26-.728zM.195 9.905l2.951 5.115a1.46 1.46 0 0 0-.531.531l-.791 1.37a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h4.84c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451L5.086 7.083a1.46 1.46 0 0 0-1.26-.728h-1.58c-.52 0-1 .276-1.26.728l-.79 1.37a1.45 1.45 0 0 0 0 1.452m15.888 13.367 2.951-5.115c.217.125.469.196.728.196h1.582c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-2.42-4.191a1.46 1.46 0 0 0-1.259-.728h-1.582c-.52 0-1 .276-1.259.728l-5.678 9.838a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h1.582c.52 0 1-.275 1.26-.728z" fill="${QWEN_MARK}"/>
${front(p.al) ? "" : arm(33.5, p.al)}${front(p.ar) ? "" : arm(62.5, p.ar)}${head}${laptop}${front(p.al) ? arm(33.5, p.al) : ""}${front(p.ar) ? arm(62.5, p.ar) : ""}
</g>${bulb}${heart}${zed}${dots}`,
  );
}

const capyBlink = [
  { ms: 80, eye: 0, ease: "in" },
  { ms: 110, eye: 1, ease: "out" },
];
const capyHop = (height, extra = {}) => [
  { ms: 110, sy: 0.92, sx: 1.06, ease: "out" },
  { ms: 190, y: -height, sy: 1.05, sx: 0.96, ...extra, ease: "out" },
  { ms: 170, y: 0, sy: 0.92, sx: 1.06, ease: "in" },
  { ms: 150, sy: 1, sx: 1, ease: "back" },
];
const tap = (times) =>
  Array.from({ length: times }, (_, i) => [
    { ms: 110, al: i % 2 ? -34 : -22, ar: i % 2 ? 22 : 34, ease: "linear" },
  ]).flat();
const CAPY = {
  idle: {
    default: [
      { ms: 1300 },
      ...capyBlink,
      { ms: 600 },
      { ms: 600, y: -1, sy: 1.012 },
      { ms: 600, y: 0, sy: 1 },
      { ms: 900 },
    ],
    curious: [
      { ms: 500 },
      { ms: 300, ht: -9, look: -1.6, eye: 1.3, ease: "back" },
      { ms: 800 },
      ...capyBlink,
      { ms: 120, eye: 1.3 },
      { ms: 500 },
      { ms: 340, ht: 7, look: 1.6 },
      { ms: 600 },
      { ms: 340, ht: 0, look: 0, eye: 1 },
      { ms: 700 },
    ],
    snooze: [
      { ms: 500 },
      { ms: 400, eye: 0, hy: 2, ht: 5 },
      { ms: 1300, zed: 1, sy: 1.02, y: -0.6, ease: "linear", fps: 10 },
      { ms: 1, zed: 0 },
      { ms: 1300, zed: 1, sy: 1, y: 0, ease: "linear", fps: 10 },
      { ms: 1, zed: 0 },
      { ms: 700 },
      { ms: 380, eye: 1, hy: 0, ht: 0 },
      { ms: 700 },
    ],
  },
  greet: {
    default: [
      { ms: 240, ar: -150, ht: 5, ease: "back" },
      { ms: 140, ar: -128 },
      { ms: 140, ar: -158 },
      { ms: 140, ar: -128 },
      { ms: 140, ar: -158 },
      ...capyBlink,
      { ms: 140, ar: -128 },
      { ms: 300, ar: -14, ht: 0 },
      { ms: 500 },
    ],
  },
  working: {
    default: [
      { ms: 220, laptop: 1, hy: 1.6, al: -26, ar: 26, ease: "out" },
      ...tap(8),
      ...capyBlink,
      ...tap(8),
      { ms: 260, look: 1.4 },
      ...tap(6),
      { ms: 200, look: 0 },
    ],
  },
  waiting: {
    default: [
      { ms: 300, ht: 6 },
      { ms: 1, dots: 1 },
      { ms: 380 },
      { ms: 1, dots: 2 },
      { ms: 380 },
      { ms: 1, dots: 3 },
      { ms: 900 },
      ...capyBlink,
      { ms: 500 },
      { ms: 1, dots: 0 },
      { ms: 300, ht: -4 },
      { ms: 500 },
      { ms: 300, ht: 6 },
    ],
  },
  done: {
    default: [
      { ms: 140, eye: 0 },
      ...capyHop(13, { al: 150, ar: -150 }),
      ...capyHop(8),
      { ms: 500 },
      { ms: 300, al: 14, ar: -14, eye: 1 },
      { ms: 400 },
    ],
    dance: [
      { ms: 200, ht: -8, al: 150, eye: 0 },
      { ms: 200, ht: 8, al: 14, ar: -150, y: -3 },
      { ms: 200, ht: -8, al: 150, ar: -14, y: 0 },
      { ms: 200, ht: 8, al: 14, ar: -150, y: -3 },
      { ms: 200, ht: -8, al: 150, ar: -14, y: 0 },
      { ms: 200, ht: 8, al: 14, ar: -150, y: -3 },
      { ms: 260, ht: 0, ar: -14, y: 0, eye: 1 },
      { ms: 400 },
    ],
    hearts: [
      { ms: 200, eye: 0, ht: 6 },
      { ms: 900, heart: 1, ease: "out" },
      { ms: 1, heart: 0 },
      { ms: 900, heart: 1, ease: "out" },
      { ms: 1, heart: 0 },
      { ms: 300, eye: 1, ht: 0 },
      { ms: 400 },
    ],
  },
  failed: {
    default: [
      { ms: 380, hy: 3.4, eye: 0, y: 0.8, sy: 0.985, al: 6, ar: -6 },
      { ms: 900, sweat: 1, ease: "in" },
      { ms: 1, sweat: 0 },
      { ms: 900 },
      { ms: 160, eye: 1 },
      { ms: 700 },
      { ms: 420, hy: 0, y: 0, sy: 1, al: 14, ar: -14 },
      { ms: 400 },
    ],
  },
  idea: {
    default: [
      { ms: 180, eye: 1.3, ease: "back" },
      { ms: 220, bulb: 1, ar: -128, y: -2, ease: "back" },
      { ms: 200, y: 0 },
      { ms: 160, bulb: 0.82 },
      { ms: 160, bulb: 1 },
      { ms: 700 },
      ...capyBlink,
      { ms: 120, eye: 1.3 },
      { ms: 500 },
      { ms: 260, bulb: 0, ar: -14, eye: 1 },
      { ms: 300 },
    ],
  },
};

export function capy(state, variant) {
  const steps = CAPY[state]?.[variant] ?? CAPY[state]?.default ?? CAPY.idle.default;
  return { ...play(CAPY_START, steps, capyFrame, 12), ...poster(CAPY_POSTER, state, variant) };
}

// ---------------------------------------------------------------- Brand pets
//
// Five pets drawn from their makers' own art: Moby is DeepSeek's whale, Kimi is Kimi's
// own glass orb with its glancing pill eyes (moves after its Rive avatar, kimiavator_web),
// Twins are Gemini's sparkle as two plush floating twins, Zippy is GLM's pixel-stair blob with Z.ai's Z,
// and Wavy is MiniMax's waveform. All but Kimi share one set of moves.

const TAU = Math.PI * 2;
const RIG_START = {
  y: 0,
  sx: 1,
  sy: 1,
  tilt: 0,
  eye: 1, // 0 shut, 1 open, 1.3 wide
  look: 0,
  lookY: 0,
  happy: 0,
  sad: 0,
  gray: 0, // drained of colour
  work: 0,
  phase: 0, // the pet's own cycle (tail, ears, waves); a loop ends on whole turns
  wave: 0,
  fx: 0, // the pet's own flourish: spout, spray, sparkles
  bulb: 0,
  sweat: 0,
  heart: 0,
  zed: 0,
  dots: 0,
};

/** Spreads `turns` whole cycles of the pet's own motion evenly over a loop. */
function spin(steps, turns) {
  const total = steps.reduce((sum, step) => sum + step.ms, 0);
  let at = 0;
  return steps.map((step) => {
    at += step.ms;
    return { ease: "linear", ...step, phase: (turns * TAU * at) / total };
  });
}
const rigBlink = [
  { ms: 80, eye: 0, ease: "in" },
  { ms: 110, eye: 1, ease: "out" },
];
const rigHop = (height, extra = {}) => [
  { ms: 110, sy: 0.92, sx: 1.06, ease: "out" },
  { ms: 190, y: -height, sy: 1.05, sx: 0.96, ...extra, ease: "out" },
  { ms: 170, y: 0, sy: 0.92, sx: 1.06, ease: "in" },
  { ms: 150, sy: 1, sx: 1, ease: "back" },
];
const RIG = {
  idle: {
    default: spin(
      [
        { ms: 1300 },
        ...rigBlink,
        { ms: 600 },
        { ms: 600, y: -1.2, sy: 1.012, ease: "inOut" },
        { ms: 600, y: 0, sy: 1, ease: "inOut" },
        { ms: 900 },
      ],
      2,
    ),
    curious: spin(
      [
        { ms: 400 },
        { ms: 300, tilt: -8, look: -1.6, eye: 1.3, ease: "back" },
        { ms: 800 },
        ...rigBlink,
        { ms: 120, eye: 1.3 },
        { ms: 500 },
        { ms: 340, tilt: 7, look: 1.6, ease: "inOut" },
        { ms: 600 },
        { ms: 340, tilt: 0, look: 0, eye: 1, ease: "inOut" },
        { ms: 600 },
      ],
      2,
    ),
    snooze: spin(
      [
        { ms: 400 },
        { ms: 400, eye: 0, y: 1.4, tilt: 4, ease: "inOut" },
        { ms: 1300, zed: 1, sy: 1.02 },
        { ms: 1, zed: 0 },
        { ms: 1300, zed: 1, sy: 1 },
        { ms: 1, zed: 0 },
        { ms: 600 },
        { ms: 380, eye: 1, y: 0, tilt: 0, ease: "inOut" },
        { ms: 600 },
      ],
      0,
    ),
  },
  greet: {
    default: spin(
      [
        { ms: 240, wave: 1, happy: 1, tilt: 4, ease: "back" },
        { ms: 150, wave: 0.35 },
        { ms: 150, wave: 1 },
        { ms: 150, wave: 0.35 },
        { ms: 150, wave: 1 },
        ...rigHop(6),
        { ms: 300, wave: 0, happy: 0, tilt: 0, ease: "inOut" },
        { ms: 500 },
      ],
      1,
    ),
  },
  working: {
    default: spin(
      [
        { ms: 1, work: 1 },
        { ms: 600, look: 1.4, ease: "inOut" },
        { ms: 500 },
        ...rigBlink,
        { ms: 600, look: -1.4, ease: "inOut" },
        { ms: 500 },
        { ms: 400, look: 0, ease: "inOut" },
      ],
      4,
    ),
  },
  waiting: {
    default: spin(
      [
        { ms: 300, tilt: 6, ease: "inOut" },
        { ms: 1, dots: 1 },
        { ms: 380 },
        { ms: 1, dots: 2 },
        { ms: 380 },
        { ms: 1, dots: 3 },
        { ms: 900 },
        ...rigBlink,
        { ms: 500 },
        { ms: 1, dots: 0 },
        { ms: 300, tilt: -4, ease: "inOut" },
        { ms: 500 },
        { ms: 300, tilt: 0, ease: "inOut" },
      ],
      0,
    ),
  },
  done: {
    default: spin(
      [
        { ms: 140, happy: 1 },
        ...rigHop(12, { fx: 1 }),
        ...rigHop(7),
        { ms: 250 },
        { ms: 300, happy: 0, fx: 0, ease: "inOut" },
        { ms: 100 },
      ],
      1,
    ),
    dance: spin(
      [
        { ms: 200, tilt: -9, happy: 1, wave: 1 },
        { ms: 200, tilt: 9, y: -3, wave: 0.3 },
        { ms: 200, tilt: -9, y: 0, wave: 1 },
        { ms: 200, tilt: 9, y: -3, wave: 0.3 },
        { ms: 200, tilt: -9, y: 0, wave: 1 },
        { ms: 200, tilt: 9, y: -3, wave: 0.3 },
        { ms: 260, tilt: 0, y: 0, wave: 0, happy: 0, ease: "inOut" },
        { ms: 400 },
      ],
      2,
    ),
    hearts: spin(
      [
        { ms: 200, happy: 1, tilt: 6 },
        { ms: 900, heart: 1, ease: "out" },
        { ms: 1, heart: 0 },
        { ms: 900, heart: 1, ease: "out" },
        { ms: 1, heart: 0 },
        { ms: 300, happy: 0, tilt: 0, ease: "inOut" },
        { ms: 400 },
      ],
      2,
    ),
  },
  failed: {
    default: spin(
      [
        { ms: 380, y: 2.4, sy: 0.97, eye: 0, sad: 1, ease: "inOut" },
        { ms: 900, sweat: 1, ease: "in" },
        { ms: 1, sweat: 0 },
        { ms: 900 },
        { ms: 160, eye: 1 },
        { ms: 700 },
        { ms: 420, y: 0, sy: 1, sad: 0, ease: "inOut" },
        { ms: 400 },
      ],
      1,
    ),
  },
  idea: {
    default: spin(
      [
        { ms: 180, eye: 1.3, ease: "back" },
        { ms: 220, bulb: 1, y: -2, ease: "back" },
        { ms: 200, y: 0 },
        { ms: 160, bulb: 0.82 },
        { ms: 160, bulb: 1 },
        { ms: 700 },
        ...rigBlink,
        { ms: 120, eye: 1.3 },
        { ms: 500 },
        { ms: 260, bulb: 0, eye: 1, ease: "inOut" },
        { ms: 300 },
      ],
      1,
    ),
  },
};
const RIG_POSTER = { working: 600, waiting: 1300, done: 420, failed: 900, idea: 700 };
const rigVariants = {
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
const rigPet = (frame) => (state, variant) => {
  const steps = RIG[state]?.[variant] ?? RIG[state]?.default ?? RIG.idle.default;
  return { ...play(RIG_START, steps, frame, 10), ...poster(RIG_POSTER, state, variant) };
};

/** One eye: open (with a shine), shut, happy (an arch) or, when sad, a drooping line. */
function rigEye(p, x, y, o) {
  const width = o.w;
  const stroke = `fill="none" stroke="${o.color}" stroke-width="${o.stroke ?? 1.8}" stroke-linecap="round"`;
  if (p.eye < 0.3)
    return p.sad > 0.5
      ? `<path d="M${n(x - width)} ${n(y - 0.6)}q${n(width)} ${n(1.8)} ${n(width * 2)} 0" ${stroke}/>`
      : `<path d="M${n(x - width)} ${n(y)}h${n(width * 2)}" ${stroke}/>`;
  if (p.happy > 0.5)
    return `<path d="M${n(x - width)} ${n(y + 1.2)}q${n(width)} ${n(-o.h * 0.75)} ${n(width * 2)} 0" ${stroke}/>`;
  const wide = p.eye > 1.15 ? 1.12 : 1;
  const height = o.h * Math.min(p.eye, 1.3);
  const cx = x + p.look;
  return (
    `<ellipse cx="${n(cx)}" cy="${n(y)}" rx="${n((width / 2) * wide)}" ry="${n(height / 2)}" fill="${o.color}"/>` +
    (o.shine && height > 2
      ? `<circle cx="${n(cx + width * 0.18)}" cy="${n(y - height * 0.2)}" r="${n(width * 0.2)}" fill="${o.shine}"/>`
      : "")
  );
}
const rigEyes = (p, x1, x2, y, o) => rigEye(p, x1, y, o) + rigEye(p, x2, y, o);

/** A small mouth: a smile, open and glad, or a frown. */
function rigMouth(p, x, y, width, color) {
  if (p.sad > 0.5)
    return `<path d="M${n(x - width / 2)} ${n(y + 1)}q${n(width / 2)} -2.2 ${n(width)} 0" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
  if (p.happy > 0.5)
    return `<path d="M${n(x - width / 2)} ${n(y - 0.4)}q${n(width / 2)} ${n(width * 0.85)} ${n(width)} 0Z" fill="${color}"/>`;
  return `<path d="M${n(x - width / 2)} ${n(y)}q${n(width / 2)} ${n(width * 0.4)} ${n(width)} 0" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
}
const rigBlush = (x1, x2, y, color = "#ff8fb1", opacity = 0.5) =>
  `<ellipse cx="${x1}" cy="${y}" rx="3.4" ry="1.8" fill="${color}" opacity="${opacity}"/><ellipse cx="${x2}" cy="${y}" rx="3.4" ry="1.8" fill="${color}" opacity="${opacity}"/>`;
const rigSweat = (p, x, y) =>
  p.sweat > 0.02
    ? `<path d="M${x} ${n(y + p.sweat * 7)}q3 4.6 0 6.4q-3-1.8 0-6.4Z" fill="#7cc4f4" stroke="#3c8fc4" stroke-width=".8" opacity="${n(Math.min(1, p.sweat * 3))}"/>`
    : "";
const rigShadow = (p, width = 21) =>
  `<ellipse cx="48" cy="90" rx="${n(width + p.y * 0.35)}" ry="3" fill="#1a1a2a" opacity=".14"/>`;
const rigBody = (p, content, cx = 48, cy = 58) =>
  `<g transform="translate(0 ${n(p.y)}) translate(48 89) scale(${n(p.sx)} ${n(p.sy)}) translate(-48 -89) rotate(${n(p.tilt)} ${cx} ${cy})">${content}</g>`;

/** The bulb, heart, sleep and speech marks, the same for every brand pet. */
export function rigMarks(p, ink, accent) {
  const bulb =
    p.bulb > 0.02
      ? `<g transform="translate(80 12) scale(${n(p.bulb)})"><path d="M-7.5 0h-3M7.5 0h3M0-8.5v-3M-5.6-5.6l-2-2M5.6-5.6l2-2" fill="none" stroke="#f2b632" stroke-width="1.5" stroke-linecap="round"/><circle r="5.4" fill="#ffd45c" stroke="#b9831c" stroke-width="1.2"/><rect x="-2.4" y="4.6" width="4.8" height="3.4" rx="1" fill="#b9831c"/></g>`
      : "";
  const heart =
    p.heart > 0.02
      ? `<path transform="translate(77 ${n(22 - p.heart * 12)}) scale(${n(0.5 + p.heart * 0.5)})" d="M0 4.8C-7.5-.2-5.4-6.6-1.6-6.2C-.6-6.1 0-5.2 0-4.4C0-5.2.6-6.1 1.6-6.2C5.4-6.6 7.5-.2 0 4.8Z" fill="#ff6f91" stroke="#c7385c" stroke-width="1" opacity="${n(Math.min(1, (1 - p.heart) * 2.5 + 0.35))}"/>`
      : "";
  const zed =
    p.zed > 0.02
      ? `<g fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="${n(Math.min(1, p.zed * 2) * (p.zed > 0.75 ? (1 - p.zed) * 4 : 1))}"><path d="M73 ${n(22 - p.zed * 8)}h5l-5 5h5"/><path d="M80 ${n(12 - p.zed * 6)}h3.6l-3.6 3.6h3.6"/></g>`
      : "";
  const dots =
    p.dots > 0.4
      ? `<g><path d="M62 4.5h23a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-14l-5 4 1-4h-5a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" fill="#fbfaf6" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>${[
          0, 1, 2,
        ]
          .map((k) =>
            p.dots > k + 0.4
              ? `<circle cx="${68.5 + k * 6}" cy="11.5" r="1.7" fill="${ink}"/>`
              : "",
          )
          .join("")}</g>`
      : "";
  return bulb + heart + zed + dots;
}
const sparkle = (x, y, size, fill, opacity = 1) =>
  `<path d="M${n(x)} ${n(y - size)}Q${n(x)} ${n(y)} ${n(x + size)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y + size)}Q${n(x)} ${n(y)} ${n(x - size)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y - size)}Z" fill="${fill}"${opacity < 0.995 ? ` opacity="${n(opacity)}"` : ""}/>`;

// Moby: DeepSeek's whale, nose to the left and flukes up, in the logo's blue.
const DEEPSEEK_BLUE = "#4d6bfe";
const DEEPSEEK_DEEP = "#3550e0";
const DEEPSEEK_BELLY = "#dde4ff";
const DEEPSEEK_INK = "#16206b";
function mobyFrame(p) {
  const swim = 1 + p.work * 1.6;
  const tail = Math.sin(p.phase) * 9 * swim + p.wave * 10;
  const bob = Math.sin(p.phase * 2) * 0.8 * p.work;
  const flipper = 20 - p.wave * 45 + Math.sin(p.phase + 1) * 8;
  const bubbles =
    p.work > 0.02
      ? [0, 1, 2]
          .map((k) => {
            const rise = (p.phase / TAU + k / 3) % 1;
            return `<circle cx="${n(9 + Math.sin(p.phase * 2 + k * 2) * 1.6)}" cy="${n(60 - rise * 30)}" r="${n(1.2 + k * 0.5)}" fill="none" stroke="#8ea4ff" stroke-width="1.1" opacity="${n(p.work * (1 - rise))}"/>`;
          })
          .join("")
      : "";
  const spout =
    p.fx > 0.02
      ? `<g transform="translate(35 37) scale(${n(p.fx)})" fill="none" stroke="#8ea4ff" stroke-width="2.2" stroke-linecap="round"><path d="M0 0C0-7-3-11-8-13"/><path d="M0 0C0-7 3-11 8-13"/><path d="M0 0V-12"/></g><g fill="#8ea4ff" opacity="${n(p.fx)}"><circle cx="${n(26 - p.fx * 2)}" cy="${n(24 - p.fx * 3)}" r="1.6"/><circle cx="${n(44 + p.fx * 2)}" cy="${n(24 - p.fx * 3)}" r="1.6"/><circle cx="35" cy="${n(22 - p.fx * 4)}" r="1.4"/></g>`
      : "";
  const body = `<g transform="rotate(${n(tail)} 64 64)"><path d="M58 67C70 67 76 60 78 50" fill="none" stroke="${DEEPSEEK_BLUE}" stroke-width="9" stroke-linecap="round"/><path d="M78 52C71 49 68 42 70 35C74 38 77 42 79 46C80 40 84 36 91 35C90 43 85 50 78 52Z" fill="${DEEPSEEK_BLUE}"/></g>
<path d="M12 61C12 45 26 37 42 37C58 37 68 47 70 58C71 67 65 77 51 78C35 79 12 77 12 61Z" fill="${DEEPSEEK_BLUE}"/>
<path d="M14 65C21 71 35 73.5 51 72.6C60 72 66 69.5 69.4 65.4C67.4 72.6 61 77.4 51 78C35 79 17 76 14 65Z" fill="${DEEPSEEK_BELLY}"/>
<path d="M14.5 65.6C22 70.6 36 72.4 51 71.6" fill="none" stroke="${DEEPSEEK_DEEP}" stroke-width="1" opacity=".35"/>
<ellipse cx="44" cy="71" rx="7.4" ry="3.2" fill="${DEEPSEEK_DEEP}" transform="rotate(${n(flipper)} 39 70)"/>
${rigEyes(p, 28.5, 28.5, 54, { w: 4.8, h: 6, color: DEEPSEEK_INK, shine: "#ffffff", stroke: 2 })}
${rigBlush(35, 35, 61.5)}
${p.sad > 0.5 ? `<path d="M15 62.6q3.6-2.4 7.6-.4" fill="none" stroke="${DEEPSEEK_INK}" stroke-width="1.5" stroke-linecap="round"/>` : p.happy > 0.5 ? `<path d="M14.6 60.6q4.4 5 9 1.4Z" fill="${DEEPSEEK_INK}"/>` : `<path d="M14.6 60.8q4 3.6 8.6 1.6" fill="none" stroke="${DEEPSEEK_INK}" stroke-width="1.5" stroke-linecap="round"/>`}
${rigSweat(p, 20, 41)}`;
  return svg(
    `${rigShadow(p, 26)}${bubbles}${rigBody({ ...p, y: p.y + bob }, spout + body, 44, 60)}${rigMarks(p, DEEPSEEK_INK, DEEPSEEK_BLUE)}`,
  );
}

// Kimi: Kimi's glass orb. Deep blue at the heart, lighter to the rim, a bright lower edge,
// a pale halo, and two white pill eyes that glance together.
const KIMI_INK = "#123a73";
const KIMI_DEFS = `<defs><radialGradient id="kb" cx="48" cy="51" r="25" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1881fb"/><stop offset=".55" stop-color="#3b95ff"/><stop offset=".86" stop-color="#5aa7ff"/><stop offset="1" stop-color="#8cc4ff"/></radialGradient><radialGradient id="kglow" cx="48" cy="79" r="17" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#cfe6ff" stop-opacity=".9"/><stop offset="1" stop-color="#cfe6ff" stop-opacity="0"/></radialGradient><radialGradient id="kgray" cx="48" cy="51" r="25" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7d8798"/><stop offset=".7" stop-color="#97a1b2"/><stop offset="1" stop-color="#c3cad6"/></radialGradient><clipPath id="kclip"><circle cx="48" cy="54" r="23"/></clipPath></defs>`;
function kimiEye(p, x, y, wink) {
  const open = wink ? 0.16 : Math.max(0.16, Math.min(p.eye, 1.3));
  const width = 5.8;
  const height = 10 * open * (p.eye > 1.15 && !wink ? 1.08 : 1);
  const angry = p.sad > 0.5 && p.eye >= 0.3;
  return angry
    ? `<path d="M${n(x - width / 2)} ${n(y - 2.4)}L${n(x + width / 2)} ${n(y - 0.8)}V${n(y + 2.6)}a1.4 1.4 0 0 1-1.4 1.4h-3a1.4 1.4 0 0 1-1.4-1.4Z" fill="#ffffff"/>`
    : `<rect x="${n(x - width / 2)}" y="${n(y - height / 2)}" width="${width}" height="${n(Math.max(height, 1.6))}" rx="${n(Math.min(width, Math.max(height, 1.6)) / 2)}" fill="#ffffff"/>`;
}
function kimiFrame(p) {
  const bob = Math.sin(p.phase) * 1.2;
  const ex = p.look * 1.6;
  const ey = p.lookY * 1.6;
  const tiltEyes = p.look * 4;
  const halo = 1 + p.work * 0.05 * (0.5 + 0.5 * Math.sin(p.phase * 2));
  const stars =
    p.fx > 0.02
      ? sparkle(75, 30 - p.fx * 6, 4.2 * p.fx, "#00c8ff", p.fx) +
        sparkle(20, 34 - p.fx * 4, 3.2 * p.fx, "#a0daf7", p.fx) +
        sparkle(70, 16 - p.fx * 3, 2.6 * p.fx, "#5aa7ff", p.fx)
      : "";
  const eyes = `<g transform="rotate(${n(tiltEyes)} ${n(48 + ex)} ${n(49 + ey)})">${kimiEye(p, 41 + ex, 49.2 + ey, false)}${kimiEye(p, 55 + ex, 49.2 + ey, p.wave > 0.5)}</g>`;
  const body = `<circle cx="48.8" cy="55" r="${n(25.6 * halo)}" fill="#dcecff" opacity=".85"/>
<circle cx="48" cy="54" r="23" fill="url(#kb)"/>
<g clip-path="url(#kclip)"><rect x="25" y="31" width="46" height="46" fill="url(#kglow)"/>${p.gray > 0.01 ? `<rect x="25" y="31" width="46" height="46" fill="url(#kgray)" opacity="${n(p.gray * 0.9)}"/>` : ""}</g>
${eyes}${rigSweat(p, 69, 36)}`;
  return svg(
    `${KIMI_DEFS}${rigShadow(p, 18)}${stars}${rigBody({ ...p, y: p.y + bob - 1 }, body, 48, 56)}${rigMarks(p, KIMI_INK, "#1881fb")}`,
  );
}
const look = (x, y, ms = 260) => ({ ms, look: x, lookY: y, ease: "inOut" });
const KIMI = {
  idle: {
    default: spin(
      [
        { ms: 1200 },
        ...rigBlink,
        { ms: 700 },
        look(1, -1),
        { ms: 900 },
        look(0, 0),
        { ms: 500 },
        ...rigBlink,
        { ms: 900 },
      ],
      2,
    ),
    curious: spin(
      [
        { ms: 400 },
        look(-1.2, 0),
        { ms: 500 },
        look(-1, -1),
        { ms: 500 },
        look(1.2, 0),
        { ms: 500 },
        ...rigBlink,
        look(1, 1),
        { ms: 500 },
        look(0, 0),
        { ms: 600 },
      ],
      2,
    ),
    snooze: spin(
      [
        { ms: 300 },
        { ms: 400, eye: 0.16, lookY: 0.6, gray: 0.25, ease: "inOut" },
        { ms: 1300, zed: 1 },
        { ms: 1, zed: 0 },
        { ms: 1300, zed: 1 },
        { ms: 1, zed: 0 },
        { ms: 400, eye: 1, lookY: 0, gray: 0, ease: "inOut" },
        { ms: 500 },
      ],
      0,
    ),
  },
  greet: {
    default: spin(
      [
        { ms: 1, sx: 0.8, sy: 0.8 },
        { ms: 260, sx: 1.06, sy: 1.06, ease: "back" },
        { ms: 160, sx: 1, sy: 1 },
        { ms: 120, wave: 1 },
        { ms: 380 },
        { ms: 120, wave: 0 },
        ...rigHop(5),
        { ms: 500 },
      ],
      1,
    ),
  },
  working: {
    default: spin(
      [
        { ms: 1, work: 1, look: 1, lookY: -1.1 },
        { ms: 1100 },
        ...rigBlink,
        { ms: 900 },
        look(0.6, -1.3, 300),
        { ms: 700 },
        look(1, -1.1, 300),
        { ms: 500 },
      ],
      3,
    ),
  },
  waiting: {
    default: spin(
      [
        look(1, -1, 300),
        { ms: 1, dots: 1 },
        { ms: 380 },
        { ms: 1, dots: 2 },
        { ms: 380 },
        { ms: 1, dots: 3 },
        { ms: 900 },
        ...rigBlink,
        { ms: 500 },
        { ms: 1, dots: 0 },
        look(0, 0, 300),
        { ms: 600 },
      ],
      0,
    ),
  },
  done: {
    default: spin(
      [
        { ms: 120, wave: 1 },
        ...rigHop(12, { fx: 1 }),
        ...rigHop(7),
        { ms: 250 },
        { ms: 300, wave: 0, fx: 0, ease: "inOut" },
        { ms: 100 },
      ],
      1,
    ),
    dance: spin(
      [
        { ms: 140, tilt: -12, look: -1 },
        { ms: 140, tilt: 12, look: 1 },
        { ms: 140, tilt: -12, look: -1 },
        { ms: 140, tilt: 12, look: 1 },
        { ms: 200, tilt: 0, look: 0, wave: 1, ease: "inOut" },
        ...rigHop(9, { fx: 1 }),
        { ms: 500 },
        { ms: 260, wave: 0, fx: 0, ease: "inOut" },
        { ms: 300 },
      ],
      1,
    ),
    hearts: spin(
      [
        { ms: 200, wave: 1, tilt: 6 },
        { ms: 900, heart: 1, ease: "out" },
        { ms: 1, heart: 0 },
        { ms: 900, heart: 1, ease: "out" },
        { ms: 1, heart: 0 },
        { ms: 300, wave: 0, tilt: 0, ease: "inOut" },
        { ms: 400 },
      ],
      2,
    ),
  },
  failed: {
    default: spin(
      [
        { ms: 300, lookY: 1.2, gray: 1, y: 1.6, ease: "inOut" },
        { ms: 130, tilt: -9 },
        { ms: 130, tilt: 9 },
        { ms: 130, tilt: -9 },
        { ms: 160, tilt: 0 },
        { ms: 900, sweat: 1, ease: "in" },
        { ms: 1, sweat: 0 },
        { ms: 700 },
        ...rigBlink,
        { ms: 400, lookY: 0, gray: 0, y: 0, ease: "inOut" },
        { ms: 400 },
      ],
      1,
    ),
  },
  idea: {
    default: spin(
      [
        { ms: 200, lookY: -1.4, eye: 1.3, ease: "back" },
        { ms: 220, bulb: 1, y: -2, ease: "back" },
        { ms: 200, y: 0 },
        { ms: 160, bulb: 0.82 },
        { ms: 160, bulb: 1 },
        { ms: 700 },
        ...rigBlink,
        { ms: 120, eye: 1.3 },
        { ms: 500 },
        { ms: 260, bulb: 0, eye: 1, lookY: 0, ease: "inOut" },
        { ms: 300 },
      ],
      1,
    ),
  },
};

// Twins: Gemini is the twins and Antigravity floats, so two plush Gemini sparks hover as a
// pair: a big blue-to-violet one and a small violet-to-pink twin tucked by its shoulder,
// inside one soft glow. They bob out of step at rest, circle each other like a binary star
// while they work, bump together in a burst of Google's four colours when done, and grey
// and sink a little when something fails.
const GEMINI_BLUE = "#3186ff";
const GEMINI_INK = "#141a3d";
/** Gemini's spark around the origin; `puff` is how deeply its four sides curve in. */
const geminiStar = (r, puff) => {
  const k = n(r * puff);
  const s = n(r - k);
  return `M0 ${-r}C0 ${-s} ${s} 0 ${r} 0C${s} 0 0 ${s} 0 ${r}C0 ${s} ${-s} 0 ${-r} 0C${-s} 0 0 ${-s} 0 ${-r}Z`;
};
// The shared glow is pale, so it lights a dark background and all but vanishes on a light one.
// Light falls from the top left. Gradients are in each spark's own space, so they move with it.
const geminiCoat = (id, r, [light, mid, deep]) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(-r * 0.62)}" y1="${n(-r * 0.7)}" x2="${n(r * 0.6)}" y2="${n(r * 0.74)}"><stop offset="0" stop-color="${light}"/><stop offset=".46" stop-color="${mid}"/><stop offset="1" stop-color="${deep}"/></linearGradient><radialGradient id="${id}s" gradientUnits="userSpaceOnUse" cx="${n(-r * 0.2)}" cy="${n(-r * 0.26)}" r="${n(r * 0.6)}"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
const GEMINI_BIG = { r: 28.25, edge: 3.5, puff: 0.42, id: "twA" };
const GEMINI_SMALL = { r: 15.8, edge: 2.4, puff: 0.42, id: "twB" };
const GEMINI_DEFS = `<defs>${geminiCoat("twA", 30, ["#62b0ff", GEMINI_BLUE, "#7a56f2"])}${geminiCoat("twB", 17, ["#a98bff", "#c079f2", "#ff8fbe"])}<radialGradient id="twG"><stop offset="0" stop-color="#c4d0ff" stop-opacity=".21"/><stop offset=".6" stop-color="#cfc4ff" stop-opacity=".07"/><stop offset="1" stop-color="#cfc4ff" stop-opacity="0"/></radialGradient></defs>`;
/** One spark at the origin: rounded tips come from a round-joined edge around the star. */
function geminiSpark({ r, edge, puff, id }, gray) {
  const box = `x="${-r - edge}" y="${-r - edge}" width="${(r + edge) * 2}" height="${(r + edge) * 2}"`;
  const paint = (fill, extra = "") => `<rect ${box} fill="${fill}"${extra}/>`;
  return `<mask id="${id}m" maskUnits="userSpaceOnUse" ${box}><path d="${geminiStar(r, puff)}" fill="#fff" stroke="#fff" stroke-width="${edge}" stroke-linejoin="round"/></mask><g mask="url(#${id}m)">${paint(`url(#${id})`)}${paint(`url(#${id}s)`)}${gray > 0.01 ? paint("#a3abba", ` opacity="${n(gray * 0.82)}"`) : ""}</g>`;
}
function twinsFrame(p) {
  const gray = Math.max(p.gray, p.sad * 0.85);
  // Shut and smiling eyes are drawn as lines twice an eye wide, so those get a narrower eye.
  const narrow = p.eye < 0.3 || p.happy > 0.5 ? 0.78 : 1;
  const face = (scale, look) =>
    rigEyes({ ...p, look: p.look * scale + look }, -4.7 * scale, 4.7 * scale, -1.9 * scale, {
      w: 3.2 * scale * narrow,
      h: 5 * scale,
      color: GEMINI_INK,
      shine: "#ffffff",
      stroke: 1.5 * scale,
    });
  const twin = (shape, x, y, scale, look, turn, size = 1) => {
    const pop = size * (1 + p.happy * 0.05 - p.sad * 0.05);
    return `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(turn)}) scale(${n(pop)})">${geminiSpark(shape, gray)}${face(scale, look)}</g>`;
  };
  const glow = (x, y, r) =>
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#twG)" opacity="${n(1 - gray * 0.8)}"/>`;
  if (p.work > 0.5) {
    // A binary star on a tilted orbit: the small one swings wide, low in front and high behind.
    const angle = p.phase / 2;
    const front = Math.sin(angle);
    const a = twin(
      GEMINI_BIG,
      44 - Math.cos(angle) * 7,
      54 - front * 2.4,
      1.3,
      Math.cos(angle) * 0.9,
      Math.cos(angle) * -3,
      1 - front * 0.03,
    );
    const b = twin(
      GEMINI_SMALL,
      44 + Math.cos(angle) * 26,
      53 + front * 15,
      0.86,
      -Math.cos(angle) * 0.7,
      Math.cos(angle) * 8,
      1 + front * 0.05,
    );
    return svg(
      `${GEMINI_DEFS}${glow(48, 53, 34)}<ellipse cx="46" cy="91" rx="15" ry="2.2" fill="#1a1a2a" opacity=".1"/>${rigBody({ ...p, tilt: 0 }, front > 0 ? a + b : b + a, 48, 54)}${rigMarks(p, GEMINI_INK, GEMINI_BLUE)}`,
    );
  }
  // Hovering: no feet, so each bobs in its own gentle rhythm and the shadow breathes.
  const bobA = Math.sin(p.phase) * 1.5;
  const bobB = Math.sin(p.phase + 1.9) * 1.9;
  const meet = p.fx * 2.6; // done: they bump together
  const a = twin(
    GEMINI_BIG,
    40 + meet * 0.5,
    58 + bobA - meet * 0.3,
    1.3,
    0.35,
    -2.5 + Math.sin(p.phase + 0.6) * 1.4 - p.tilt * 0.3 - p.wave * 5 + p.fx * 5,
  );
  const b = twin(
    GEMINI_SMALL,
    64 - meet,
    37.5 + bobB + meet * 0.8,
    0.86,
    -0.35,
    9 + Math.sin(p.phase + 2.6) * 2.4 + p.tilt * 0.5 + p.wave * 11 - p.fx * 10,
  );
  const burst =
    p.fx > 0.02
      ? sparkle(54 + p.fx * 2, 30 - p.fx * 8, 3.8 * p.fx, "#fbbc04", p.fx) +
        sparkle(47 - p.fx * 6, 40 - p.fx * 5, 2.8 * p.fx, "#ea4335", p.fx) +
        sparkle(60 + p.fx * 7, 54 + p.fx * 3, 3 * p.fx, "#34a853", p.fx) +
        sparkle(72 + p.fx * 5, 58 - p.fx * 2, 2.2 * p.fx, "#4285f4", p.fx)
      : "";
  const shadow = `<ellipse cx="44" cy="91" rx="${n(15 - bobA * 0.8)}" ry="2.2" fill="#1a1a2a" opacity=".1"/>`;
  return svg(
    `${GEMINI_DEFS}${glow(50, 50, 34)}${shadow}${rigBody({ ...p, tilt: p.tilt * 0.3 }, a + b + burst + rigSweat(p, 52, 30), 48, 54)}${rigMarks(p, GEMINI_INK, GEMINI_BLUE)}`,
  );
}

// Zippy: GLM's pet, in the pixel-stair style ChatGLM's site draws its blobs, shaded like
// pixel art, with block arms and feet, two dark pill eyes under one expressive brow, and a
// cowlick bent into Z.ai's Z.
const GLM_LIME = "#d6f0a5";
const GLM_SHADE = "#b5d77f";
const GLM_LIGHT = "#effbd8";
const GLM_INK = "#251f0d";
/** A circle drawn in stairs, the way ChatGLM's blobs are. */
function stairCircle(cx, cy, r, step) {
  const rows = [];
  for (let y = -r; y < r; y += step) {
    const mid = y + step / 2;
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - mid * mid)) / step + 0.35) * step;
    rows.push([y, half]);
  }
  let d = "";
  rows.forEach(([y, half], i) => {
    d += `${i === 0 ? "M" : "L"}${n(cx + half)} ${n(cy + y)}L${n(cx + half)} ${n(cy + y + step)}`;
  });
  for (let i = rows.length - 1; i >= 0; i--) {
    const [y, half] = rows[i];
    d += `L${n(cx - half)} ${n(cy + y + step)}L${n(cx - half)} ${n(cy + y)}`;
  }
  return `${d}Z`;
}
const GLM_STEP = 3.6;
const GLM_BODY = stairCircle(48, 56, 24, GLM_STEP);
const GLM_FACE = stairCircle(46.2, 54.2, 22.2, GLM_STEP);
function zippyFrame(p) {
  const ink = `fill="none" stroke="${GLM_INK}" stroke-linecap="round" stroke-linejoin="round"`;
  const ex = p.look * 1.4;
  const ey = p.lookY * 1.4;
  let eyes;
  if (p.happy > 0.5) {
    // The squint ChatGLM's grey blob makes: > <
    eyes = `<path d="M39.6 49.6l3.4 2.2-3.4 2.2M55 49.6l-3.4 2.2 3.4 2.2" ${ink} stroke-width="2"/><path d="M45.2 57.4q2.1 2.2 4.2 0" ${ink} stroke-width="1.6"/>`;
  } else if (p.eye < 0.3) {
    eyes = `<path d="M40.2 ${p.sad > 0.5 ? 52.6 : 52}q2 ${p.sad > 0.5 ? -1.4 : 1.2} 4 0M51 ${p.sad > 0.5 ? 52.6 : 52}q2 ${p.sad > 0.5 ? -1.4 : 1.2} 4 0" ${ink} stroke-width="1.9"/>`;
  } else {
    const open = Math.min(p.eye, 1.3);
    const tall = 8.6 * open;
    const short = 6.4 * open;
    eyes = `<rect x="${n(40.6 + ex)}" y="${n(51.6 + ey - tall / 2)}" width="3.6" height="${n(tall)}" rx="1.8" fill="${GLM_INK}"/><rect x="${n(51.4 + ex)}" y="${n(52.4 + ey - short / 2)}" width="3.4" height="${n(short)}" rx="1.7" fill="${GLM_INK}"/>`;
  }
  // The brow over the bigger eye lifts when curious or struck by an idea and drops when sad.
  const lift = (p.eye > 1.15 ? 1.6 : 0) + Math.max(0, -p.lookY) * 0.8 - p.sad * 1.2;
  const brow = `<path d="M${n(39.8 + ex * 0.5)} ${n(44.6 - lift + (p.sad > 0.5 ? 0.6 : 0))}q2.4 ${n(-2.6 - lift * 0.3 + p.sad * 3)} 4.8 ${n(p.sad > 0.5 ? -1.2 : 0.2)}" ${ink} stroke-width="1.6"/>`;
  // Block arms: they type while it works, wave hello, and both go up when it is done.
  const typing = p.work > 0.5 ? Math.sin(p.phase * 4) * 1.6 : 0;
  const leftUp = Math.max(p.fx, 0) * 12;
  const rightUp = Math.max(p.wave, p.fx, p.bulb) * 12;
  const wiggle = p.wave * Math.sin(p.phase * 6) * 2;
  const block = (x, y, w, h) =>
    `<path d="M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z" fill="${GLM_SHADE}"/><path d="M${n(x)} ${n(y)}h${n(w - 1.4)}v${n(h - 1.4)}h${n(-(w - 1.4))}Z" fill="${GLM_LIME}"/>`;
  const arms =
    block(20.4, 60 - leftUp + typing, 5.6, 6) + block(70 + wiggle, 60 - rightUp - typing, 5.6, 6);
  const feet = block(37, 79, 7.2, 5) + block(51.8, 79, 7.2, 5);
  // Z.ai's own Z mark, standing on its head like a tuft that sways.
  const sway = Math.sin(p.phase) * 5 + p.wave * 6;
  const cowlick = `<g transform="rotate(${n(sway)} 48 33.4) translate(42.6 22.4) scale(.45)"><path d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z" fill="${GLM_INK}"/></g>`;
  const pulse = 1 + p.work * 0.02 * Math.sin(p.phase * 2);
  const body = `${feet}${cowlick}<g transform="translate(48 56) scale(${n(pulse)}) translate(-48 -56)"><path d="${GLM_BODY}" fill="${GLM_SHADE}"/><path d="${GLM_FACE}" fill="${GLM_LIME}"/><path d="M34 40.4h3.6v3.6H34ZM37.6 36.8h3.6v3.6h-3.6Z" fill="${GLM_LIGHT}"/>${p.gray > 0.01 ? `<path d="${GLM_BODY}" fill="#c4c8c0" opacity="${n(p.gray * 0.75)}"/>` : ""}</g>
${arms}${brow}${eyes}${rigSweat(p, 66, 34)}`;
  return svg(`${rigShadow(p, 22)}${rigBody(p, body, 48, 58)}${rigMarks(p, GLM_INK, "#7fb33a")}`);
}

// Wavy: MiniMax's waveform, one fat loop for a body and the line running out both sides.
const MINIMAX_INK = "#3b0a24";
const MINIMAX_DEFS = `<defs><linearGradient id="mm" x1="8" y1="0" x2="88" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e2167e"/><stop offset="1" stop-color="#fe603c"/></linearGradient></defs>`;
function wavyFrame(p) {
  const level = 0.25 + p.work * 0.75;
  const bar = (k) => Math.sin(p.phase * 2 + k * 1.7) * 6 * level;
  // Each arm: down to a bend, up to a peak, down, up to its end; peaks bounce like a level meter.
  const arm = (side) => {
    const x = (dx) => 48 + side * dx;
    const sweepDown = side < 0 ? 1 : 0;
    const sweepUp = side < 0 ? 0 : 1;
    const raise = side > 0 ? p.wave * 10 : 0;
    const b1 = 84;
    const t2 = 50 + bar(side) - raise;
    const b3 = 80 + bar(side + 2) * 0.35;
    const end = 62 + bar(side + 4) - raise * 0.6;
    return `<path d="M${x(8)} 72V${n(b1)}A3.75 3.75 0 0 ${sweepDown} ${x(15.5)} ${n(b1)}V${n(t2)}A3.75 3.75 0 0 ${sweepUp} ${x(23)} ${n(t2)}V${n(b3)}A3.75 3.75 0 0 ${sweepDown} ${x(30.5)} ${n(b3)}V${n(end)}" fill="none" stroke="url(#mm)" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  const squash = Math.sin(p.phase * 2) * 1.2 * level;
  const body = `${arm(-1)}${arm(1)}
<rect x="35" y="${n(42 + squash)}" width="26" height="${n(46 - squash)}" rx="13" fill="url(#mm)"/>
<path d="M40 ${n(49 + squash)}q3-3.8 8.4-4.2" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round"/>
${rigEyes(p, 43, 53, 60, { w: 3.8, h: 7, color: MINIMAX_INK, shine: "#ffffff", stroke: 1.7 })}
${rigBlush(39.5, 56.5, 66, "#ffd1d4", 0.6)}
${rigMouth(p, 48, 67.5, 4, MINIMAX_INK)}
${rigSweat(p, 62, 36)}`;
  return svg(
    `${MINIMAX_DEFS}${rigShadow(p, 22)}${rigBody(p, body, 48, 60)}${rigMarks(p, MINIMAX_INK, "#e2167e")}`,
  );
}

export const moby = rigPet(mobyFrame);
export function kimi(state, variant) {
  const steps = KIMI[state]?.[variant] ?? KIMI[state]?.default ?? KIMI.idle.default;
  return { ...play(RIG_START, steps, kimiFrame, 10), ...poster(RIG_POSTER, state, variant) };
}
export const twins = rigPet(twinsFrame);
export const zippy = rigPet(zippyFrame);
export const wavy = rigPet(wavyFrame);

export const drawnVariants = {
  grok: {
    idle: [
      ["default", 4],
      ["look-around", 2],
      ["curious", 1],
      ["doze", 1],
    ],
    greet: [
      ["default", 3],
      ["hop", 1],
    ],
    working: [
      ["default", 3],
      ["dots", 3],
      ["orbit", 2],
    ],
    waiting: [
      ["default", 2],
      ["tap", 1],
    ],
    done: [
      ["default", 3],
      ["spin", 1],
      ["wink", 1],
    ],
    failed: [
      ["default", 2],
      ["sad", 1],
    ],
    idea: [
      ["default", 2],
      ["eureka", 1],
    ],
  },
  mistral: {
    idle: [
      ["default", 4],
      ["look", 2],
      ["tail", 2],
      ["nap", 1],
    ],
    greet: [
      ["default", 3],
      ["hop", 1],
    ],
    working: [
      ["default", 3],
      ["focus", 2],
    ],
    waiting: [
      ["default", 2],
      ["tail", 1],
    ],
    done: [
      ["default", 3],
      ["dance", 2],
      ["purr", 1],
    ],
    failed: [
      ["default", 2],
      ["shake", 1],
    ],
    idea: [
      ["default", 2],
      ["eureka", 1],
    ],
  },
  qwen: {
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
  },
  kimi: rigVariants,
  deepseek: rigVariants,
  gemini: rigVariants,
  glm: rigVariants,
  minimax: rigVariants,
};

/** id -> (state, variant, dark) => art. A pet with `dark` art gets a second set of sheets. */
export const drawnPets = {
  grok: { draw: grokBot, dark: true },
  mistral: { draw: leChonk, dark: false },
  qwen: { draw: capy, dark: false },
  kimi: { draw: kimi, dark: false },
  deepseek: { draw: moby, dark: false },
  gemini: { draw: twins, dark: false },
  glm: { draw: zippy, dark: false },
  minimax: { draw: wavy, dark: false },
};

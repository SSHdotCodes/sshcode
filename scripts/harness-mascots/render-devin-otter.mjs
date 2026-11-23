// Renders Devin's official otter, the 3D plush in Devin Desktop
// (assets/otter-*.glb, animated by chunk-plushieMascotScene-*.js), into flat 216 px frames
// for the harness pet sheets. The scene, camera, lights and the idle / happy / sad moves
// (glances, blinks, winks, Happy and Sad morphs, balloons, the tear, the red "?") follow
// Devin Desktop's own code; SSHCode's other states are built from those same moves.
//
//   node scripts/harness-mascots/render-devin-otter.mjs [<mascot source dir>] [<only variant>]
//
// Reads <source>/devin/otter.glb and writes <source>/devin/render/<state>-<variant>/*.png
// with a manifest.json that generate-harness-mascots.mjs turns into sheets.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const root = NodePath.resolve(here, "../..");
const source = NodePath.resolve(
  process.argv[2] ?? NodePath.resolve(root, "../t3code-fork-mascot-src"),
);
const only = process.argv[3];
// three's main entry is build/three.cjs; its package root is two folders up.
const threeRoot = NodePath.resolve(
  NodeModule.createRequire(NodePath.join(root, "packages/client-runtime/package.json")).resolve(
    "three",
  ),
  "../..",
);
const { chromium } = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"))(
  "playwright-core",
);

const SIZE = 216;
const SCALE = 3; // rendered at 648 px, then reduced, for clean fur and whisker edges

const page = String.raw`<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="${SIZE * SCALE}" height="${SIZE * SCALE}"></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0, 0);
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.65;
room.dispose();
pmrem.dispose();
// Devin's camera is a 4.1-unit square around the head; ours steps back to leave room
// for the balloons and marks the way the other pets do.
const HALF = window.HALF;
const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF + window.LIFT, -HALF + window.LIFT, 0.1, 20);
camera.position.set(0, -0.05, 9);
camera.lookAt(0, -0.05, 0);
const key = new THREE.DirectionalLight(0xfff5e7, 2.5);
key.position.set(-3, 4, 5);
scene.add(key);
const fill = new THREE.DirectionalLight(0xe6eeff, 0.7);
fill.position.set(3, 1, 4);
scene.add(fill);

const otter = (await new GLTFLoader().loadAsync("/otter.glb")).scene;
scene.add(otter);
const head = otter.getObjectByName("Head");
const eyes = ["EyeL", "EyeR"].map((name) => otter.getObjectByName(name));
const brows = ["BrowL", "BrowR"].map((name) => otter.getObjectByName(name));
const balloon = otter.getObjectByName("Balloon");
const tear = otter.getObjectByName("TearR");
const balloonHome = balloon.position.clone();
const balloons = [balloon, ...[0x68baff, 0xffd25b].map((hex) => {
  const copy = balloon.clone();
  copy.traverse((part) => {
    if (part.name === "BalloonBody" || part.name === "BalloonKnot") {
      part.material = part.material.clone();
      part.material.color.setHex(hex);
    }
  });
  return copy;
})];
otter.add(...balloons.slice(1));
// Each balloon rises on its own line, two behind the head and one in front of it.
const lanes = [{ x: -1.3, z: -1.5 }, { x: 1.7, z: 1.6 }, { x: 0.45, z: -1.5 }];
const tearHome = tear.position.clone();
const morphs = [];
otter.traverse((part) => { if (part.morphTargetDictionary?.Happy !== undefined) morphs.push(part); });

// The red "?" Devin shows when it is poked while idle.
const mark = document.createElement("canvas");
mark.width = mark.height = 256;
const ink = mark.getContext("2d");
const curl = new Path2D("M 77 80 C 77 24 181 24 181 80 C 181 114 128 115 128 132");
ink.lineCap = "round";
ink.strokeStyle = "#ffffff";
ink.fillStyle = "#f53b3a";
ink.lineWidth = 60;
ink.stroke(curl);
ink.beginPath();
ink.arc(128, 218, 20, 0, Math.PI * 2);
ink.lineWidth = 16;
ink.stroke();
ink.fill();
ink.strokeStyle = ink.fillStyle;
ink.lineWidth = 44;
ink.stroke(curl);
const markTexture = new THREE.CanvasTexture(mark);
markTexture.colorSpace = THREE.SRGBColorSpace;
const question = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTexture, transparent: true, depthTest: false, toneMapped: false }));
question.position.set(1.4, 0.91, 2);
question.scale.setScalar(1.75);
scene.add(question);

const smooth = (from, to, dt, rate = 7) => THREE.MathUtils.lerp(from, to, 1 - Math.exp(-dt * rate));
// A loop of L seconds repeats seamlessly only when every wave fits it a whole number of times.
const fit = (rate, L, half = false) => {
  const period = half ? Math.PI : 2 * Math.PI;
  return (period * Math.max(1, Math.round((rate * L) / period))) / L;
};
const at = (list, y, fallback) => {
  let value = fallback;
  for (const [time, next] of list ?? []) if (time <= y) value = next;
  return value;
};
const within = (starts, y, length) => (starts ?? []).some((start) => y >= start && y < start + length);

window.render = (plan) => {
  const L = plan.L;
  const f15 = fit(1.5, L), f22 = fit(2.2, L), f22h = fit(2.2, L, true), f14 = fit(1.4, L);
  const tearPeriod = L / Math.max(1, Math.round(L / 2.8));
  const state = { O: 0, k: 0, rx: 0, ry: 0, rz: 0, eye: [1, 1] };
  const frames = [];
  const dt = 1 / 120;
  const frameSteps = Math.round(plan.ms / 1000 / dt);
  const total = Math.round(L / dt);
  // One loop to settle, then the recorded one; the plan repeats, so the end meets the start.
  for (let i = -total; i < total; i++) {
    const y = (((i * dt) % L) + L) % L;
    const clock = i * dt;
    const mood = at(plan.moods, y, plan.mood);
    const reactStart = (plan.reacts ?? []).filter((start) => start <= y).at(-1);
    const a = reactStart === undefined ? 0 : Math.max(0, 1 - (y - reactStart) / 2);
    const s = Math.sin(a * Math.PI);
    const p = s * Math.abs(Math.sin(a * Math.PI * 4));
    const [S, C] = at(plan.glances, y, [0, 0]);
    const asleep = within(plan.sleep?.map(([start]) => start), y, 0) || (plan.sleep ?? []).some(([start, end]) => y >= start && y < end);
    state.O = smooth(state.O, +(mood === "happy"), dt);
    state.k = smooth(state.k, +(mood === "sad"), dt);
    const { O, k } = state;
    const pitchExtra = asleep ? 0.16 : 0;
    const rollExtra = asleep ? 0.07 : 0;
    state.ry = smooth(state.ry, mood === "idle" ? S * (1 - s) : Math.sin(clock * f15) * 0.07 + S + (mood === "sad" ? s * Math.sin(a * Math.PI * 4) * 0.3 : 0), dt);
    state.rx = smooth(state.rx, (mood === "sad" ? 0.16 + s * 0.16 : mood === "happy" ? -0.05 - p * 0.1 : C - s * 0.1) + pitchExtra, dt, asleep ? 3 : 7);
    state.rz = smooth(state.rz, O * Math.sin(clock * f22) * 0.07 + k * 0.05 + (mood === "happy" ? s * Math.sin(a * Math.PI * 6) * 0.18 : s * (mood === "idle" ? 0.22 : 0.06)) + rollExtra, dt, mood === "happy" && a > 0 ? 14 : asleep ? 3 : 7);
    const blink = within(plan.blinks, y, 0.14);
    const wide = (mood === "idle" && a > 0) || (plan.wide ?? []).some(([start, end]) => y >= start && y < end);
    eyes.forEach((eye, index) => {
      const wink = mood === "happy" && index === 1 && within(plan.winks, y, 0.55);
      const shut = (a > 0 && mood !== "idle") || blink || wink || asleep;
      const target = shut ? 0.07 : 1 - k * 0.22 - O * 0.08 + (wide ? 0.12 : 0);
      state.eye[index] = smooth(state.eye[index], target, dt, asleep ? 5 : mood === "sad" && a > 0 ? 8 : 30);
    });
    if (i < 0 || i % frameSteps !== 0) continue;
    head.rotation.set(state.rx, state.ry, state.rz);
    head.position.y = O * Math.abs(Math.sin((clock - (plan.moodStart ?? 0)) * f22h)) * 0.1 - k * 0.06 + (mood === "happy" ? p * 0.22 : 0) + (asleep ? -0.03 : 0);
    eyes.forEach((eye, index) => {
      eye.scale.y = state.eye[index];
      eye.rotation.z = (index === 0 ? -1 : 1) * k * 0.15;
    });
    brows.forEach((brow) => { brow.visible = k > 0.1; });
    for (const part of morphs) {
      part.morphTargetInfluences[part.morphTargetDictionary.Happy] = O;
      part.morphTargetInfluences[part.morphTargetDictionary.Sad] = k;
    }
    const top = camera.position.y + camera.top + 1.1;
    balloons.forEach((one, index) => {
      // Devin's balloons take 4.8 s to rise; ours take the nearest time that fits the loop.
      const r = L / Math.max(1, Math.round(L / 4.8));
      const o = ((clock + (index * r) / balloons.length) % r + r) % r / r;
      one.visible = plan.balloons !== false && O > 0.01;
      one.scale.setScalar(O * 1.15 * Math.min(1, o * 12));
      one.position.set(lanes[index].x + Math.sin(o * Math.PI * 2 + index) * 0.07, THREE.MathUtils.lerp(-1, top, o), lanes[index].z);
      one.rotation.z = Math.sin(clock * f14 + index) * 0.08;
    });
    const g = (clock % tearPeriod) / tearPeriod;
    tear.visible = k > 0.01;
    tear.scale.setScalar(k * Math.sin(g * Math.PI) * (1 + s * 0.4));
    tear.position.copy(tearHome);
    tear.position.y -= g * 0.48;
    question.visible = plan.question !== false && mood === "idle" && a > 0;
    question.material.opacity = Math.min(1, a * 5);
    question.position.y = 0.91 + s * 0.08;
    renderer.render(scene, camera);
    const marks = {};
    for (const [name, list] of Object.entries(plan.marks ?? {})) {
      let value = 0;
      for (const [start, end, from, to] of list)
        if (y >= start && y < end) value = from + (to - from) * ((y - start) / (end - start));
      marks[name] = value;
    }
    frames.push({ png: canvas.toDataURL("image/png"), marks });
  }
  return frames;
};
window.ready = true;
</script></body></html>`;

// Times are seconds within the loop. glances: [time, [yaw, pitch]]; reacts last 2 s;
// marks: [start, end, from, to] ramps for the shared bulb / heart / sleep / speech marks.
const plans = {
  "idle-default": {
    L: 6.4,
    mood: "idle",
    glances: [
      [0, [0, 0]],
      [1.1, [0.24, -0.04]],
      [2.7, [0, 0]],
      [3.7, [-0.22, 0.05]],
      [5.2, [0, 0]],
    ],
    blinks: [2.1, 4.6],
  },
  "idle-curious": {
    L: 5,
    mood: "idle",
    reacts: [0.5],
    glances: [
      [0, [0, 0]],
      [3, [0.2, 0.04]],
      [4.2, [0, 0]],
    ],
    blinks: [2.8],
  },
  "idle-snooze": {
    L: 5,
    mood: "idle",
    sleep: [[0.4, 4.2]],
    marks: {
      zed: [
        [1.1, 2.3, 0, 1],
        [2.3, 3.5, 0, 1],
        [3.5, 4.1, 0, 0.5],
      ],
    },
  },
  "greet-default": {
    L: 3.6,
    moods: [
      [0, "happy"],
      [2.5, "idle"],
    ],
    reacts: [0.1],
    question: false,
    balloons: false,
    winks: [1.6],
  },
  "working-default": {
    L: 4.8,
    mood: "work",
    glances: [
      [0, [0, 0.12]],
      [1.6, [0.12, 0.13]],
      [3.2, [-0.1, 0.11]],
    ],
    blinks: [1.2, 3.9],
  },
  "waiting-default": {
    L: 4.4,
    mood: "work",
    glances: [
      [0, [0.06, -0.04]],
      [2.6, [-0.05, -0.02]],
    ],
    blinks: [2.2],
    marks: {
      dots: [
        [0.4, 0.8, 1, 1],
        [0.8, 1.2, 2, 2],
        [1.2, 3.6, 3, 3],
      ],
    },
  },
  "done-default": { L: 4, mood: "happy", winks: [1.1], blinks: [2.9] },
  "done-dance": { L: 4, mood: "happy", reacts: [0, 2] },
  "done-hearts": {
    L: 4,
    mood: "happy",
    balloons: false,
    winks: [2.4],
    marks: {
      heart: [
        [0.2, 1.4, 0, 1],
        [1.4, 2.6, 0, 1],
        [2.6, 3.8, 0, 1],
      ],
    },
  },
  "failed-default": { L: 4.2, mood: "sad", reacts: [0.2] },
  "idea-default": {
    L: 4,
    mood: "work",
    glances: [
      [0, [0, 0]],
      [0.3, [0.05, -0.12]],
      [3.3, [0, 0]],
    ],
    wide: [[0.3, 3.3]],
    blinks: [2.2],
    marks: {
      bulb: [
        [0.35, 0.6, 0, 1],
        [0.6, 1, 1, 1],
        [1, 1.15, 0.82, 0.82],
        [1.15, 3.2, 1, 1],
        [3.2, 3.5, 1, 0],
      ],
    },
  },
};

const files = {
  "/otter.glb": NodePath.join(source, "devin/otter.glb"),
};
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const tab = await browser.newPage({ viewport: { width: SIZE * SCALE, height: SIZE * SCALE } });
  await tab.route("http://otter.local/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page });
    const file = path.startsWith("/three/") ? NodePath.join(threeRoot, path.slice(7)) : files[path];
    if (!file || !NodeFS.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: file.endsWith(".js") ? "text/javascript" : "application/octet-stream",
      body: await NodeFSP.readFile(file),
    });
  });
  tab.on("pageerror", (error) => console.error("page error:", error.message));
  await tab.addInitScript(
    ({ half, lift }) => {
      window.HALF = half;
      window.LIFT = lift;
    },
    { half: Number(process.env.OTTER_HALF ?? 2.4), lift: Number(process.env.OTTER_LIFT ?? 0.33) },
  );
  await tab.goto("http://otter.local/");
  await tab.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
  const manifest = {};
  for (const [name, plan] of Object.entries(plans)) {
    if (only && name !== only) continue;
    // Eight frames a second: the otter's moves are slow and eased, and the sheets stay small.
    const ms = 125;
    const frames = await tab.evaluate((input) => window.render(input), { ...plan, ms });
    const folder = NodePath.join(source, "devin/render", name);
    await NodeFSP.rm(folder, { recursive: true, force: true });
    await NodeFSP.mkdir(folder, { recursive: true });
    await Promise.all(
      frames.map(({ png }, index) =>
        sharp(Buffer.from(png.split(",")[1], "base64"))
          .resize(SIZE, SIZE, { kernel: "lanczos3" })
          .png()
          .toFile(NodePath.join(folder, `${String(index).padStart(3, "0")}.png`)),
      ),
    );
    manifest[name] = { ms, frames: frames.length, marks: frames.map((frame) => frame.marks) };
    console.log(`${name}: ${frames.length} frames`);
  }
  const manifestFile = NodePath.join(source, "devin/render/manifest.json");
  const previous = NodeFS.existsSync(manifestFile)
    ? JSON.parse(NodeFS.readFileSync(manifestFile, "utf8"))
    : {};
  await NodeFSP.writeFile(manifestFile, JSON.stringify({ ...previous, ...manifest }));
} finally {
  await browser.close();
}

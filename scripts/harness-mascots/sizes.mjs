// Usage: node scripts/harness-mascots/sizes.mjs <output.png>
// The shipped sheets' first frames at the hero size and at small slot sizes, on a light
// and a dark background, to judge how each pet reads where the app shows it.
import sharp from "sharp";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = process.argv[2] ?? "/private/tmp/mascot-sizes.png";
const rows = [
  ["grok-idle", "grok-dark-idle"],
  ["grok-working-dots", "grok-dark-working-dots"],
  ["grok-failed", "grok-dark-failed"],
  ["grok-idea", "grok-dark-idea"],
  ["mistral-idle", "mistral-idle"],
  ["mistral-waiting", "mistral-waiting"],
  ["mistral-done", "mistral-done"],
  ["qwen-idle", "qwen-idle"],
  ["qwen-working", "qwen-working"],
  ["qwen-done", "qwen-done"],
];
const sizes = [192, 96, 48, 28];
const frameOf = {
  "grok-working-dots": 30,
  "grok-failed": 12,
  "grok-idea": 10,
  "mistral-done": 2,
  "qwen-working": 10,
  "qwen-done": 6,
};
const composites = [];
const width = sizes.reduce((sum, size) => sum + size + 24, 24);
for (const [row, pair] of rows.entries()) {
  for (const [side, name] of pair.entries()) {
    const file = NodePath.resolve(root, "apps/web/public/mascots", `${name}.webp`);
    const index = frameOf[name.replace("-dark", "")] ?? 0;
    const frame = await sharp(file)
      .extract({
        left: (index % 8) * 216,
        top: Math.floor(index / 8) * 216,
        width: 216,
        height: 216,
      })
      .png()
      .toBuffer();
    let x = 24 + side * width;
    for (const size of sizes) {
      composites.push({
        input: await sharp(frame)
          .resize(size, size, { kernel: name.startsWith("mistral") ? "nearest" : "lanczos3" })
          .png()
          .toBuffer(),
        left: x,
        top: row * 200 + (200 - size) / 2,
      });
      x += size + 24;
    }
  }
}
await sharp({
  create: { width: width * 2, height: rows.length * 200, channels: 4, background: "#f6f5f1" },
})
  .composite([
    {
      input: await sharp({
        create: { width, height: rows.length * 200, channels: 4, background: "#16161a" },
      })
        .png()
        .toBuffer(),
      left: width,
      top: 0,
    },
    ...composites,
  ])
  .png()
  .toFile(out);
console.log(out);

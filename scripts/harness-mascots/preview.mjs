// Usage: node scripts/harness-mascots/preview.mjs <output-directory> [id...]
// Contact sheets of the code-drawn and rendered pets: eight evenly spaced frames per animation.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { drawnPets, drawnVariants } from "./drawn.mjs";
import { renderedPets } from "./rendered.mjs";

// Rendered pets (Devin's otter) come from the mascot source directory beside the checkout.
const rendered = await renderedPets(
  process.env.MASCOT_SOURCE ??
    NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../../../t3code-fork-mascot-src"),
);
Object.assign(drawnPets, rendered.pets);
Object.assign(drawnVariants, rendered.variants);

const out = process.argv[2] ?? "/private/tmp/mascot-preview";
const only = process.argv.slice(3);
for (const [id, pet] of Object.entries(drawnPets)) {
  if (only.length > 0 && !only.includes(id)) continue;
  for (const dark of pet.dark ? [false, true] : [false]) {
    const rows = [];
    let total = 0;
    for (const [state, list] of Object.entries(drawnVariants[id])) {
      for (const [variant] of list) {
        const art = pet.draw(state, variant, dark);
        total += art.frames.length;
        const step = Math.max(1, Math.ceil(art.frames.length / 8));
        rows.push({
          label: `${state}/${variant} ${art.frames.length}f ${art.durations.reduce((a, b) => a + b, 0)}ms`,
          frames: art.frames.filter((_, index) => index % step === 0).slice(0, 8),
        });
      }
    }
    const composites = [];
    for (const [row, entry] of rows.entries()) {
      composites.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="100"><text x="4" y="54" font-family="sans-serif" font-size="14" fill="${dark ? "#ddd" : "#333"}">${entry.label}</text></svg>`,
        ),
        left: 0,
        top: row * 100,
      });
      for (const [column, frame] of entry.frames.entries()) {
        composites.push({
          input: await sharp(Buffer.from(frame)).resize(96, 96).png().toBuffer(),
          left: 250 + column * 100,
          top: row * 100 + 2,
        });
      }
    }
    const file = `${out}/${id}${dark ? "-dark" : ""}-contact.png`;
    await sharp({
      create: {
        width: 250 + 8 * 100,
        height: rows.length * 100,
        channels: 4,
        background: dark ? "#17171c" : "#f3f1ec",
      },
    })
      .composite(composites)
      .png()
      .toFile(file);
    console.log(`${file}: ${rows.length} animations, ${total} frames`);
  }
}

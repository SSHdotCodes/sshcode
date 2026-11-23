import { describe, expect, it } from "vite-plus/test";

import { RIPPLE_STEPS, skyLayers } from "./skyField";

const dots = (layers: ReadonlyArray<{ color: string; d: string }>, color: string) =>
  layers
    .filter((layer) => layer.color === color)
    .reduce((sum, layer) => sum + (layer.d.match(/M/g)?.length ?? 0), 0);

const positions = (layers: ReadonlyArray<{ opacity: number; d: string }>) =>
  layers.flatMap((layer) =>
    [...layer.d.matchAll(/M(\d+) (\d+)h/g)].map(
      ([, x, y]) => [Number(x), Number(y), layer.opacity] as const,
    ),
  );

describe("skyLayers", () => {
  it("gives each harness its share of the fog, in arcs", () => {
    const sky = skyLayers(402, 200, [
      { glow: "#aaaaaa", rim: "#ffffff", share: 3 },
      { glow: "#bbbbbb", rim: "#eeeeee", share: 1 },
    ]);
    const first = dots(sky.glow, "#aaaaaa");
    const second = dots(sky.glow, "#bbbbbb");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    // Arcs are cut by the fogged area, and the denser middle may fall to either, so roughly.
    expect(first / (first + second)).toBeGreaterThan(0.55);
    expect(first / (first + second)).toBeLessThan(0.92);
    expect(dots(sky.rim, "#ffffff") + dots(sky.rim, "#eeeeee")).toBeGreaterThan(0);
  });

  it("draws one harness alone, ripples in rings, and nothing without one", () => {
    const sky = skyLayers(402, 200, [{ glow: "#aaaaaa", rim: "#ffffff", share: 1 }]);
    expect(sky.glow.every((layer) => layer.color === "#aaaaaa")).toBe(true);
    const rings = new Set(sky.ripple.map((layer) => layer.slice));
    expect(rings.size).toBe(RIPPLE_STEPS);
    expect(skyLayers(402, 200, [])).toEqual({ glow: [], rim: [], ripple: [] });
  });

  it("is heaviest toward the right and thins out above the list", () => {
    const lit = positions(
      skyLayers(402, 200, [{ glow: "#aaaaaa", rim: "#ffffff", share: 1 }]).glow,
    );
    const totalLight = lit.reduce((sum, [, , opacity]) => sum + opacity, 0);
    const rightLight = lit
      .filter(([x]) => x >= 201)
      .reduce((sum, [, , opacity]) => sum + opacity, 0);
    expect(rightLight).toBeGreaterThan(totalLight * 0.6);
    expect(lit.filter(([, y]) => y > 170).length).toBeLessThan(lit.length / 50);
  });

  it("softens its top edge when asked", () => {
    const tone = [{ glow: "#aaaaaa", rim: "#ffffff", share: 1 }];
    const hard = positions(skyLayers(402, 150, tone).glow).filter(([, y]) => y < 15).length;
    const soft = positions(skyLayers(402, 150, tone, 0.5).glow).filter(([, y]) => y < 15).length;
    expect(soft).toBeLessThan(hard / 4);
  });

  it("draws 4pt mosaic tiles with hairline gaps and multiple shades", () => {
    const sky = skyLayers(402, 200, [{ glow: "#aaaaaa", rim: "#ffffff", share: 1 }], 0, 0.5);
    const opacities = new Set(sky.glow.map((layer) => layer.opacity));
    expect(opacities.size).toBeGreaterThan(2);
    for (const layer of sky.glow) {
      expect(layer.opacity).toBeGreaterThan(0);
      expect(layer.opacity).toBeLessThanOrEqual(1);
      expect(layer.d).toContain("h3.5v3.5h-3.5z");
    }
  });
});

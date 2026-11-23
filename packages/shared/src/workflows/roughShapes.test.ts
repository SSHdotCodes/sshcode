import { describe, expect, it } from "vite-plus/test";

import { boxEdgePoint, roughArrow, roughCard, seedFrom } from "./roughShapes.ts";

describe("boxEdgePoint", () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };

  it("leaves through the side facing the target", () => {
    expect(boxEdgePoint(box, { x: 100, y: 1_000 }, 0)).toEqual({ x: 100, y: 100 });
    expect(boxEdgePoint(box, { x: 1_000, y: 50 }, 0)).toEqual({ x: 200, y: 50 });
  });

  it("keeps a gap so arrowheads don't touch the outline", () => {
    const point = boxEdgePoint(box, { x: 100, y: -1_000 }, 6);
    expect(point.x).toBe(100);
    expect(point.y).toBeCloseTo(-6);
  });
});

describe("rough shapes", () => {
  it("draw the same wobble for the same id", () => {
    const seed = seedFrom("n_abc");
    expect(roughCard(240, 132, seed)).toBe(roughCard(240, 132, seed));
    expect(roughArrow({ x: 0, y: 0 }, { x: 0, y: 200 }, seed).line).toBe(
      roughArrow({ x: 0, y: 0 }, { x: 0, y: 200 }, seed).line,
    );
    expect(seedFrom("n_abc")).not.toBe(seedFrom("n_abd"));
  });
});

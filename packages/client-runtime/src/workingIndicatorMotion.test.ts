import { describe, expect, it } from "vite-plus/test";
import {
  sampleWorkingDash,
  WORKING_CYCLE_MS,
  WORKING_DASH_TRACKS,
  WORKING_VARIATIONS,
} from "./workingIndicatorMotion.ts";

describe("working indicator choreography", () => {
  it("returns to the exact circle with a still beat between every variation", () => {
    expect(WORKING_CYCLE_MS).toBeGreaterThanOrEqual(2400);
    expect(WORKING_CYCLE_MS).toBeLessThanOrEqual(4000);
    for (const frames of WORKING_DASH_TRACKS) {
      const rest = sampleWorkingDash(frames, 0);
      expect(Math.hypot(rest.x, rest.y)).toBeCloseTo(10);
      expect(rest.opacity).toBe(1);
      for (let cycle = 1; cycle <= WORKING_VARIATIONS; cycle++) {
        expect(sampleWorkingDash(frames, cycle - 0.08)).toEqual(rest);
        expect(sampleWorkingDash(frames, cycle)).toEqual(rest);
        if (cycle < WORKING_VARIATIONS) {
          expect(sampleWorkingDash(frames, cycle + 0.08)).toEqual(rest);
        }
      }
    }
  });

  it("changes the phrase each cycle and staggers individual dashes", () => {
    const first = WORKING_DASH_TRACKS[0]!;
    expect(sampleWorkingDash(first, 0.5)).not.toEqual(sampleWorkingDash(first, 1.5));
    expect(sampleWorkingDash(first, 1.5)).not.toEqual(sampleWorkingDash(first, 2.5));
    const radii = WORKING_DASH_TRACKS.map((track) => {
      const p = sampleWorkingDash(track, 0.5);
      return Math.hypot(p.x, p.y).toFixed(2);
    });
    expect(new Set(radii).size).toBeGreaterThan(4);
  });

  it("keeps the entire stroked dash inside its original icon box", () => {
    // Sample the arc including its round 1-unit stroke cap, not just its centre.
    for (const frames of WORKING_DASH_TRACKS) {
      for (let step = 0; step <= 960; step++) {
        const p = sampleWorkingDash(frames, (step / 960) * WORKING_VARIATIONS);
        const r = (p.rotation * Math.PI) / 180;
        expect(p.opacity).toBeGreaterThanOrEqual(0.5);
        expect(p.opacity).toBeLessThanOrEqual(1);
        for (let point = -1; point <= 1; point += 0.25) {
          const x = point * 1.9;
          const y = 10 - Math.sqrt(100 - x * x);
          const worldX = p.x + x * Math.cos(r) - y * Math.sin(r);
          const worldY = p.y + x * Math.sin(r) + y * Math.cos(r);
          expect(Math.abs(worldX) + 1).toBeLessThan(12);
          expect(Math.abs(worldY) + 1).toBeLessThan(12);
        }
      }
    }
  });
});

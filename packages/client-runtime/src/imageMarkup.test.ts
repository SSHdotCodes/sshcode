import { describe, expect, it } from "vite-plus/test";
import {
  changeMarkup,
  EMPTY_MARKUP_HISTORY,
  imagePoint,
  loopToEllipse,
  markupPath,
  redoMarkup,
  shapeBounds,
  undoMarkup,
  type MarkupShape,
} from "./imageMarkup.js";

const shape: MarkupShape = {
  tool: "rectangle",
  color: "#ef4444",
  width: 0.008,
  points: [
    { x: 0.8, y: 0.7 },
    { x: 0.2, y: 0.1 },
  ],
};
describe("image markup", () => {
  it("maps fitted view coordinates to full resolution and clamps edges", () => {
    expect(imagePoint(100, 50, 400, 200)).toEqual({ x: 0.25, y: 0.25 });
    expect(imagePoint(-5, 300, 400, 200)).toEqual({ x: 0, y: 1 });
    expect(
      markupPath({ ...shape, tool: "pen", points: [imagePoint(100, 50, 400, 200)] }, 4000, 2000),
    ).toBe("M 1000 500 l 0.01 0");
  });
  it("draws reverse drags and scales geometry independently on each axis", () => {
    expect(shapeBounds(shape.points)).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.6000000000000001,
      height: 0.6,
    });
    expect(markupPath(shape, 100, 200)).toBe("M 20 20 h 60 v 120 h -60 Z");
    expect(markupPath({ ...shape, tool: "ellipse" }, 100, 200)).toBe(
      "M 20 80 a 30 60 0 1 0 60 0 a 30 60 0 1 0 -60 0",
    );
  });
  it("gives arrows two wings without extending past a short shaft", () => {
    const path = markupPath(
      {
        ...shape,
        tool: "arrow",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      },
      100,
      100,
    );
    expect(path).toContain("M 0 0 L 100 0 M ");
    expect(path).toContain(" L 100 0 L ");
    expect(
      markupPath(
        {
          ...shape,
          tool: "arrow",
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
        100,
        100,
      ),
    ).not.toContain("NaN");
  });
  it("snaps a roughly closed elliptical loop and rejects open strokes and scribbles", () => {
    const points = Array.from({ length: 49 }, (_, i) => {
      const angle = (i / 48) * Math.PI * 2;
      return { x: 0.5 + 0.3 * Math.cos(angle), y: 0.5 + 0.2 * Math.sin(angle) };
    });
    expect(loopToEllipse({ ...shape, tool: "pen", points }).tool).toBe("ellipse");
    expect(loopToEllipse({ ...shape, tool: "pen", points: points.slice(0, 30) }).tool).toBe("pen");
    expect(loopToEllipse({ ...shape, tool: "pen", points: [...points, ...points] }).tool).toBe(
      "pen",
    );
    expect(
      loopToEllipse({
        ...shape,
        tool: "pen",
        points: points.map((p, i) => (i % 3 === 0 ? { x: 0.5, y: 0.5 } : p)),
      }).tool,
    ).toBe("pen");
  });
  it("undoes clear, redoes and discards redo after a new stroke", () => {
    const drawn = changeMarkup(EMPTY_MARKUP_HISTORY, [shape]);
    const cleared = changeMarkup(drawn, []);
    expect(undoMarkup(cleared).present).toEqual([shape]);
    expect(redoMarkup(undoMarkup(cleared))).toEqual(cleared);
    expect(changeMarkup(undoMarkup(cleared), [shape, shape]).future).toEqual([]);
    expect(undoMarkup(EMPTY_MARKUP_HISTORY)).toBe(EMPTY_MARKUP_HISTORY);
    expect(redoMarkup(EMPTY_MARKUP_HISTORY)).toBe(EMPTY_MARKUP_HISTORY);
  });
});

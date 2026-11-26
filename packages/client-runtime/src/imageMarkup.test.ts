import { describe, expect, it } from "vite-plus/test";
import {
  appendMarkupStroke,
  changeMarkup,
  changeMarkupText,
  EMPTY_MARKUP_HISTORY,
  fitMarkupLoop,
  imagePoint,
  markupPath,
  markupTextHalo,
  previewMarkup,
  redoMarkup,
  shapeBounds,
  undoMarkup,
  type MarkupShape,
  type MarkupText,
} from "./imageMarkup.js";

const shape: MarkupShape = {
  id: "stroke",
  tool: "rectangle",
  color: "#ef4444",
  width: 0.008,
  points: [
    { x: 0.8, y: 0.7 },
    { x: 0.2, y: 0.1 },
  ],
};
describe("image markup", () => {
  it("uses a contrasting halo and scales its outward radius with the text size", () => {
    expect(markupTextHalo("#ef4444", 18).at(-1)).toMatchObject({
      color: "#fff9f2",
      width: 2,
      opacity: 0.55,
    });
    for (const color of ["#ffffff", "#facc15"]) {
      expect(markupTextHalo(color, 18).at(-1)?.color).toBe("#1b2233");
    }
    expect(markupTextHalo("#000000", 14).at(-1)?.width).toBeCloseTo((2 * 14) / 18);
    expect(markupTextHalo("#000000", 24).at(-1)?.width).toBeCloseTo((2 * 24) / 18);
  });
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
    expect(fitMarkupLoop({ ...shape, tool: "pen", points }).tool).toBe("ellipse");
    expect(fitMarkupLoop({ ...shape, tool: "pen", points: points.slice(0, 30) }).tool).toBe("pen");
    expect(fitMarkupLoop({ ...shape, tool: "pen", points: [...points, ...points] }).tool).toBe(
      "pen",
    );
    expect(
      fitMarkupLoop({
        ...shape,
        tool: "pen",
        points: points.map((p, i) => (i % 3 === 0 ? { x: 0.5, y: 0.5 } : p)),
      }).tool,
    ).toBe("pen");
  });
  it("keeps a wide ellipse centered and ignores brief excursions into neighboring rows", () => {
    const points = Array.from({ length: 49 }, (_, index) => {
      const angle = (index * Math.PI) / 24;
      const height = index === 12 || index === 36 ? 0.2 : 0.126;
      return { x: 0.5 + 0.35 * Math.cos(angle), y: 0.5 + height * Math.sin(angle) };
    });
    const original: MarkupShape = { ...shape, tool: "pen", points };
    const fitted = fitMarkupLoop(original);
    const bounds = shapeBounds(fitted.points);
    expect(fitted.tool).toBe("ellipse");
    expect(fitted.width).toBe(original.width);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(0.5);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(0.5);
    expect(bounds.width).toBeCloseTo(0.7, 2);
    expect(bounds.height).toBeCloseTo(0.252, 2);

    const history = appendMarkupStroke(EMPTY_MARKUP_HISTORY, original, fitted);
    const freehand = undoMarkup(history);
    expect(freehand.present[0]).toBe(original);
    expect(undoMarkup(freehand).present).toEqual([]);
    expect(redoMarkup(freehand).present[0]).toBe(fitted);
  });
  it("snaps a rectangular loop to the stroke's own four edges", () => {
    const points = Array.from({ length: 49 }, (_, index) => {
      const angle = (index * Math.PI) / 24;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      const edge = Math.max(Math.abs(x), Math.abs(y));
      return { x: 0.55 + (0.35 * x) / edge, y: 0.42 + (0.08 * y) / edge };
    });
    const fitted = fitMarkupLoop({ ...shape, tool: "pen", points });
    expect(fitted.tool).toBe("rectangle");
    expect(shapeBounds(fitted.points)).toEqual(shapeBounds(points));
  });
  it("undos text edits, moves and deletion, and ignores blank labels", () => {
    const text: MarkupText = {
      tool: "text",
      id: "label",
      point: { x: 0.25, y: 0.5 },
      color: "#ffffff",
      size: 0.045,
      content: "Card",
    };
    expect(changeMarkupText(EMPTY_MARKUP_HISTORY, { ...text, content: " " })).toBe(
      EMPTY_MARKUP_HISTORY,
    );
    const added = changeMarkupText(EMPTY_MARKUP_HISTORY, text);
    const edited = changeMarkupText(added, { ...text, content: "This card" });
    const moved = changeMarkupText(edited, {
      ...text,
      content: "This card",
      point: { x: 0.5, y: 0.75 },
    });
    const deleted = changeMarkupText(moved, { ...text, content: "" });
    expect(deleted.present).toEqual([]);
    expect(undoMarkup(deleted).present).toEqual(moved.present);
    expect(undoMarkup(moved).present).toEqual(edited.present);
    expect(undoMarkup(edited).present).toEqual(added.present);
    expect(redoMarkup(undoMarkup(moved)).present).toEqual(moved.present);
  });
  it("previews new labels and replaces edits in place without changing committed items", () => {
    const label: MarkupText = {
      tool: "text",
      id: "label",
      point: { x: 0.25, y: 0.5 },
      color: "#ef4444",
      size: 0.045,
      content: "Review",
    };
    const draft = { ...label, content: "Check this row" };
    const committed = [label, shape];
    expect(previewMarkup([shape], draft)).toEqual([shape, draft]);
    expect(previewMarkup(committed, draft)).toEqual([draft, shape]);
    expect(committed[0]).toBe(label);
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

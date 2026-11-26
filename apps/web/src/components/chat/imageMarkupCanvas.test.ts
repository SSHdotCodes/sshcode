import { describe, expect, it } from "vite-plus/test";
import { imagePoint } from "@t3tools/client-runtime/image-markup";
import { drawMarkup } from "./imageMarkupCanvas";

describe("markup PNG drawing", () => {
  it("draws the halo, shadow and semibold label in original image pixels", () => {
    const paints: object[] = [];
    const context = {
      font: "",
      globalAlpha: 1,
      lineWidth: 0,
      strokeStyle: "",
      fillStyle: "",
      textBaseline: "",
      strokeText(text: string, x: number, y: number) {
        paints.push({
          text,
          x,
          y,
          color: this.strokeStyle,
          width: this.lineWidth,
          opacity: this.globalAlpha,
        });
      },
      fillText(text: string, x: number, y: number) {
        paints.push({
          text,
          x,
          y,
          color: this.fillStyle,
          font: this.font,
          baseline: this.textBaseline,
          opacity: this.globalAlpha,
        });
      },
    };
    drawMarkup(
      context as unknown as CanvasRenderingContext2D,
      [
        {
          tool: "text",
          id: "label",
          color: "#ef4444",
          point: imagePoint(100, 50, 400, 250),
          size: 18 / 400,
          content: "Review",
        },
      ],
      2000,
      1250,
    );
    expect(paints).toEqual([
      { text: "Review", x: 500, y: 342.5, color: "#1b2233", width: 25, opacity: 0.035 },
      { text: "Review", x: 500, y: 342.5, color: "#1b2233", width: 20, opacity: 0.055 },
      { text: "Review", x: 500, y: 342.5, color: "#1b2233", width: 15, opacity: 0.075 },
      { text: "Review", x: 500, y: 340, color: "#fff9f2", width: 10, opacity: 0.55 },
      {
        text: "Review",
        x: 500,
        y: 340,
        color: "#ef4444",
        font: "600 90px system-ui, sans-serif",
        baseline: "alphabetic",
        opacity: 1,
      },
    ]);
  });
});

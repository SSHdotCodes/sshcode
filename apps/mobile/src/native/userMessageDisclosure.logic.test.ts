import { describe, expect, it } from "vite-plus/test";
import { canFoldUserMessage, canMeasureUserMessageLines } from "./userMessageDisclosure.logic";

describe("user message line disclosure", () => {
  it("only folds when the native 14-line layout actually shortens the message", () => {
    expect(canFoldUserMessage(280, 280)).toBe(false);
    expect(canFoldUserMessage(280.5, 280)).toBe(false);
    expect(canFoldUserMessage(300, 280)).toBe(true);
    expect(canFoldUserMessage(300, 0)).toBe(false);
  });

  it("keeps rich Markdown blocks and embedded images in the full native renderer", () => {
    expect(canMeasureUserMessageLines("Consider **this** ordinary wrapped sentence.")).toBe(true);
    expect(canMeasureUserMessageLines("First\n\n![preview](photo.jpg)")).toBe(false);
    expect(canMeasureUserMessageLines("| Some content |\n| --- |\n| another line |")).toBe(false);
    expect(canMeasureUserMessageLines("Example output:\n\n```txt\noutput\n```")).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { emojiMessageTypography } from "./typography";

describe("emoji message typography", () => {
  it("respects increased text size instead of fixing emoji at 32 points", () => {
    expect(emojiMessageTypography({ fontSize: 16, lineHeight: 22 })).toEqual({
      fontSize: 32,
      lineHeight: 44,
    });
    expect(emojiMessageTypography({ fontSize: 24, lineHeight: 33 })).toEqual({
      fontSize: 48,
      lineHeight: 66,
    });
    expect(emojiMessageTypography({ fontSize: 32, lineHeight: 44 })).toEqual({
      fontSize: 64,
      lineHeight: 88,
    });
  });
  it("keeps the user's chosen line spacing proportional", () => {
    expect(emojiMessageTypography({ fontSize: 18, lineHeight: 30 })).toEqual({
      fontSize: 36,
      lineHeight: 60,
    });
  });
});

import { expect, it } from "@effect/vitest";
import { visibleGuestPrompt } from "./guestPrompt.ts";

it("makes bidi, zero-width, variation and terminal controls visible without changing ordinary Unicode", () => {
  expect(visibleGuestPrompt("مرحبا Café 🐈")).toEqual({
    text: "مرحبا Café 🐈",
    controlCharacterCount: 0,
  });
  expect(visibleGuestPrompt("a\u202eb\u2069c\u200dd\u034fe\ufe0ff\u001bg\u007fh\u0085i")).toEqual({
    text: "a⟦U+202E⟧b⟦U+2069⟧c⟦U+200D⟧d⟦U+034F⟧e⟦U+FE0F⟧f⟦U+001B⟧g⟦U+007F⟧h⟦U+0085⟧i",
    controlCharacterCount: 8,
  });
  expect(visibleGuestPrompt("one\r\n\ttwo")).toEqual({
    text: "one\r\n\ttwo",
    controlCharacterCount: 0,
  });
});

it("does not warn on multiline code, carriage returns, tabs or emoji joiners and variation selectors", () => {
  for (const text of ["line one\nline two\n\tindented", "a\r\nb\rc", "👨‍👩‍👧‍👦 ❤️ 👩🏽‍💻 1️⃣", "مرحبا 🐈"])
    expect(visibleGuestPrompt(text)).toEqual({ text, controlCharacterCount: 0 });
  expect(visibleGuestPrompt("word\u200Dword word\uFE0F").controlCharacterCount).toBe(2);
  expect(visibleGuestPrompt("safe\u202Ehidden\u2069")).toEqual({
    text: "safe⟦U+202E⟧hidden⟦U+2069⟧",
    controlCharacterCount: 2,
  });
});

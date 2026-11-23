import { describe, expect, it } from "@effect/vitest";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  it("prefers normalized message text", () => {
    expect(
      deriveThreadTitleSeed({
        text: "  Investigate\n  login   failures  ",
        attachments: [{ name: "login-error.png" }],
        fallbackLabels: ["Terminal 1"],
      }),
    ).toBe("Investigate login failures");
  });

  it("uses the first attachment name when text is empty", () => {
    expect(
      deriveThreadTitleSeed({
        text: " \n ",
        attachments: [{ name: "login-error.png" }, { name: "other.png" }],
      }),
    ).toBe("Image: login-error.png");
  });

  it("uses the first non-empty fallback label after text and attachments", () => {
    expect(
      deriveThreadTitleSeed({
        text: "",
        attachments: [],
        fallbackLabels: [null, "  ", "Terminal 1"],
      }),
    ).toBe("Terminal 1");
  });

  it("seeds a chip-only message with the chip's label", () => {
    expect(
      deriveThreadTitleSeed({
        text: "[AI Tracker Bot megathread](t3-context://v1/thread/thread-1)",
        attachments: [],
      }),
    ).toBe("AI Tracker Bot megathread");
  });

  it("falls back to New thread", () => {
    expect(deriveThreadTitleSeed({ text: "", attachments: [] })).toBe("New thread");
  });

  it("applies the shared title truncation", () => {
    expect(
      deriveThreadTitleSeed({
        text: "x".repeat(60),
        attachments: [],
      }),
    ).toBe(`${"x".repeat(50)}...`);
  });
});

describe("model mention titles", () => {
  it("uses slugs while preserving surrounding punctuation", () => {
    expect(
      deriveThreadTitleSeed({
        text: "Delegate to model:codex/gpt-6.1-sol and report back",
        attachments: [],
      }),
    ).toBe("Delegate to gpt-6.1-sol and report back");
    expect(
      deriveThreadTitleSeed({
        text: "model:opencode/anthropic/opus, then model:codex/gpt-5.4.",
        attachments: [],
      }),
    ).toBe("anthropic/opus, then gpt-5.4.");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { selectStyleExamples } from "./casualVoiceText.ts";

describe("style examples", () => {
  const messages = (texts: string[]) => texts.map((text) => ({ role: "user", text }));
  it("skips secrets, tokens, paths, commands, code, long text and agent messages", () => {
    const input = [
      ...messages([
        "yeah sounds good",
        "sure 🙂",
        "sure :)",
        "YEAH sounds good",
        "my token is abc",
        "sk-not-a-real-key",
        "/Users/Alex/repo",
        "open apps/web/file.ts",
        "const x = 3;",
        "`run this`",
        "a".repeat(250),
        "ghp_obviouslyfakevalue",
        "hello\nthere\nmore\nlines",
      ]),
      { role: "assistant", text: "do not learn this" },
      { role: "user", text: "an option label", questionAnswer: {} },
      { role: "user", text: "generated answer", id: "async-answer:test" },
      { role: "user", text: "another agent wrote this", senderThreadId: "agent" },
    ];
    expect(selectStyleExamples(input)).toEqual(["YEAH sounds good"]);
  });
  it("keeps the most recent 32 deduped examples, within the character budget", () => {
    const input = messages(
      Array.from({ length: 60 }, (_, i) => `sounds good, let’s try option ${i}`),
    );
    const selected = selectStyleExamples(input);
    expect(selected).toHaveLength(32);
    expect(selected[0]).toContain("28");
    expect(selected.join("").length).toBeLessThanOrEqual(4800);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  formatThreadTitleContext,
  limitTitleMessage,
  type ThreadTitleMessage,
} from "./threadTitleContext.ts";

const requests = [
  "Add calendar reminders to the habit app.",
  "Fix search results when a habit is renamed.",
  "Support exporting daily progress as a CSV.",
  "Improve keyboard navigation in settings.",
  "Show weekly streaks on the dashboard.",
];
const longHistory = Array.from({ length: 300 }, (_, index) => ({
  role: "user" as const,
  text: `Request ${String(index).padStart(3, "0")}: ${requests[index % requests.length]}`,
}));

const shownRequests = (message: string) =>
  [...message.matchAll(/^Request (\d+):/gm)].map((match) => Number(match[1]));

describe("thread title context", () => {
  it("samples requests across the whole history in conversation order within 8,000 characters", () => {
    const { message } = formatThreadTitleContext(longHistory);
    const shown = shownRequests(message);

    expect(message.length).toBeLessThanOrEqual(8_000);
    expect(message.split("\n")[0]).toBe(
      `[This thread has 300 user messages; ${shown.length} are shown, picked across its whole history.]`,
    );
    expect(message).not.toContain("[Earlier content truncated]");
    expect(shown.length).toBeGreaterThan(30);
    expect(shown.length).toBeLessThan(300);
    expect(shown[0]).toBe(0);
    expect(shown.slice(-2)).toEqual([298, 299]);
    expect(shown.some((index) => index >= 140 && index <= 160)).toBe(true);
    expect(shown).toEqual(shown.toSorted((left, right) => left - right));
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(shown.map((index) => Math.floor(index / 30))).size).toBe(10);
  });

  it("keeps fuller first and recent requests and both ends of sampled excerpts", () => {
    const { message } = formatThreadTitleContext(
      Array.from({ length: 100 }, (_, index) => ({
        role: "user",
        text: `Start request ${index}. ${"Details. ".repeat(150)}End request ${index}.`,
      })),
    );
    const excerpts = [...message.matchAll(/USER:\n([\s\S]*?)(?=\n\nUSER:|$)/g)];

    expect(message.length).toBeLessThanOrEqual(8_000);
    expect(excerpts.length).toBeGreaterThan(10);
    for (const [index, excerpt] of excerpts.entries()) {
      const text = excerpt[1]!;
      const request = text.match(/^Start request (\d+)\./)?.[1];
      expect(request).toBeDefined();
      expect(text.endsWith(`End request ${request}.`)).toBe(true);
      expect(text).toContain("[Content truncated]");
      if (index === 0 || index >= excerpts.length - 2) {
        expect(text.length).toBeGreaterThan(300);
      } else {
        expect(text.length).toBeLessThanOrEqual(300);
      }
    }
  });

  it("does not let assistant output evict sampled user requests", () => {
    const usersOnly = formatThreadTitleContext(longHistory);
    const withAnswers = formatThreadTitleContext(
      longHistory.flatMap((message, index): ThreadTitleMessage[] => [
        message,
        { role: "assistant", text: `Answer ${index}: ${"Implementation details. ".repeat(500)}` },
      ]),
    );

    expect(shownRequests(withAnswers.message)).toEqual(shownRequests(usersOnly.message));
    expect(withAnswers.message.length).toBeLessThanOrEqual(8_000);
    expect(withAnswers.message.match(/^ASSISTANT:/gm)).toHaveLength(2);
    expect(withAnswers.message).toContain("ASSISTANT:\nAnswer 298:");
    expect(withAnswers.message).toContain("ASSISTANT:\nAnswer 299:");
    const answers = [
      ...withAnswers.message.matchAll(/ASSISTANT:\n([\s\S]*?)(?=\n\nUSER:|\n\nASSISTANT:|$)/g),
    ];
    expect(answers.reduce((length, answer) => length + answer[0].length, 0)).toBeLessThanOrEqual(
      1_000,
    );
  });

  it("keeps every user request when only the assistant history is too large", () => {
    const messages = Array.from({ length: 100 }, (_, index): ThreadTitleMessage[] => [
      { role: "user", text: `Request ${index}: Fix habit ${index}.` },
      { role: "assistant", text: `Answer ${index}: ${"Details. ".repeat(500)}` },
    ]).flat();
    const { message } = formatThreadTitleContext(messages);

    expect(shownRequests(message)).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(message.split("\n")[0]).toBe(
      "[This thread has 100 user messages; 100 are shown, picked across its whole history.]",
    );
    expect(message.match(/^ASSISTANT:/gm)).toHaveLength(2);
    expect(message.length).toBeLessThanOrEqual(8_000);
  });

  it("retains the first attachment and the three most recent attachments when sampling", () => {
    const attachment = (id: string) => ({
      type: "image" as const,
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
    });
    const { attachments } = formatThreadTitleContext(
      longHistory.map((message, index) => ({
        ...message,
        attachments:
          index === 0
            ? [attachment("first"), attachment("older")]
            : index === 299
              ? [attachment("recent-1"), attachment("recent-2"), attachment("recent-3")]
              : [],
      })),
    );

    expect(attachments.map((entry) => entry.id)).toEqual([
      "first",
      "recent-1",
      "recent-2",
      "recent-3",
    ]);
  });

  it("keeps a user's scope change despite long assistant output", () => {
    const result = formatThreadTitleContext([
      { role: "user", text: "Review QR sharing" },
      { role: "assistant", text: "Old findings. ".repeat(2_000) },
      { role: "user", text: "Focus on pairing expiry instead. Keep remote access working." },
      { role: "assistant", text: "Implementation details. ".repeat(2_000) },
      { role: "user", text: "Merge it when green." },
    ]);
    expect(result.message.length).toBeLessThanOrEqual(8_000);
    expect(result.message).toContain("USER:\nReview QR sharing");
    expect(result.message).toContain(
      "USER:\nFocus on pairing expiry instead. Keep remote access working.",
    );
    expect(result.message).toContain("USER:\nMerge it when green.");
    expect(result.message).toContain("ASSISTANT:\nImplementation details.");
  });

  it("retains both ends and role labels in long user messages", () => {
    const result = formatThreadTitleContext([
      { role: "system", text: "System instructions" },
      { role: "user", text: `Fix Android pairing. ${"logs ".repeat(3_000)}Keep iOS behavior.` },
      { role: "assistant", text: "Found the cause." },
    ]);
    expect(result.message).toContain("USER:\nFix Android pairing.");
    expect(result.message).toContain("Keep iOS behavior.");
    expect(result.message).toContain("ASSISTANT:\nFound the cause.");
    expect(result.message).not.toContain("System instructions");
    expect(result.message.match(/USER:/g)).toHaveLength(1);
  });

  it("preserves short conversations unchanged and handles tiny budgets", () => {
    expect(
      formatThreadTitleContext([
        { role: "user", text: "Fix pairing" },
        { role: "assistant", text: "The QR token expired." },
        { role: "user", text: "Also add a calendar to the habit app." },
        { role: "assistant", text: "The dashboard can show it." },
        { role: "user", text: "Then improve search." },
      ]).message,
    ).toBe(
      "USER:\nFix pairing\n\nASSISTANT:\nThe QR token expired.\n\nUSER:\nAlso add a calendar to the habit app.\n\nASSISTANT:\nThe dashboard can show it.\n\nUSER:\nThen improve search.",
    );
    expect(limitTitleMessage("x".repeat(100), 0)).toBe("");
    for (let budget = 1; budget < 40; budget++) {
      expect(limitTitleMessage("x".repeat(100), budget).length).toBeLessThanOrEqual(budget);
    }
    expect(formatThreadTitleContext([])).toEqual({ message: "", attachments: [] });
  });

  it("omits reasoning traces from generated titles", () => {
    expect(
      formatThreadTitleContext([
        { role: "user", text: "Fix pairing" },
        { role: "reasoning", text: "Consider token expiry, then the QR payload." },
        { role: "assistant", text: "The QR token expired." },
      ]).message,
    ).toBe("USER:\nFix pairing\n\nASSISTANT:\nThe QR token expired.");
  });
});

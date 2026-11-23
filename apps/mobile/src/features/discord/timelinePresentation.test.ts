import { describe, expect, it } from "vite-plus/test";
import { MessageId, ThreadId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { timelineDayLabel, timelineDecorations } from "./timelinePresentation";

const today = new Date(2026, 9, 25, 12);
const stamp = (day: number, minute = 0) => new Date(2026, 9, day, 10, minute).toISOString();
function message(id: string, role: "user" | "assistant", day: number, minute = 0): ThreadFeedEntry {
  const timestamp = stamp(day, minute);
  return {
    type: "message",
    id,
    createdAt: timestamp,
    message: {
      id: MessageId.make(id),
      role,
      text: "Message",
      attachments: [],
      runId: null,
      streaming: false,
      visibility: "local",
      sourceThreadId: ThreadId.make("thread"),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

describe("mobile transcript boundaries", () => {
  it("uses local calendar days and omits a divider above a today-only chat", () => {
    const entries = [message("today", "user", 25), message("reply", "assistant", 25, 1)];
    expect([...timelineDecorations(entries, null, today).values()].map((row) => row.day)).toEqual([
      null,
      null,
    ]);
    const days = timelineDecorations([message("yesterday", "user", 24), ...entries], null, today);
    expect(days.get("yesterday")?.day).toBe("Yesterday");
    expect(days.get("today")?.day).toBe("Today");
    expect(timelineDayLabel(new Date(2025, 9, 22).toISOString(), today)).toContain("2025");
  });

  it("places New only before the first unseen agent output, using the captured watermark", () => {
    const entries = [
      message("seen", "assistant", 25),
      message("prompt", "user", 25, 2),
      message("new", "assistant", 25, 3),
      message("later", "assistant", 25, 4),
    ];
    const visitedAtOpen = stamp(25, 1);
    expect(
      [...timelineDecorations(entries, visitedAtOpen, today)]
        .filter(([, row]) => row.isNew)
        .map(([id]) => id),
    ).toEqual(["new"]);
    expect([...timelineDecorations(entries, null, today).values()].some((row) => row.isNew)).toBe(
      false,
    );
    expect(
      [...timelineDecorations(entries, stamp(25, 5), today).values()].some((row) => row.isNew),
    ).toBe(false);
    expect(
      [...timelineDecorations(entries, "invalid", today).values()].some((row) => row.isNew),
    ).toBe(false);
  });

  it("marks an existing reply that gained output after the visit", () => {
    const entry = message("stream", "assistant", 25);
    if (entry.type !== "message") throw new Error("Expected message");
    const updated = { ...entry, message: { ...entry.message, updatedAt: stamp(25, 4) } };
    expect(timelineDecorations([updated], stamp(25, 2), today).get("stream")?.isNew).toBe(true);
  });

  it("groups only consecutive same-author messages within seven minutes, without crossing boundaries", () => {
    const entries = [
      message("a", "assistant", 25),
      message("b", "assistant", 25, 7),
      message("c", "assistant", 25, 15),
      message("u", "user", 25, 16),
      message("d", "assistant", 25, 17),
      message("next", "assistant", 26),
    ];
    const decorations = timelineDecorations(entries, null, today);
    expect([...decorations.values()].map((row) => row.grouped)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(timelineDecorations(entries, stamp(25, 3), today).get("b")?.grouped).toBe(false);
    const withWork: ThreadFeedEntry[] = [
      entries[0]!,
      { type: "thinking", id: "work", runId: null, createdAt: stamp(25, 1) },
      entries[1]!,
    ];
    expect(timelineDecorations(withWork, null, today).get("b")?.grouped).toBe(false);
  });
});

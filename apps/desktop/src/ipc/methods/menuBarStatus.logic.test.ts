import { describe, expect, it } from "vite-plus/test";

import {
  MENU_BAR_ROWS,
  menuBarEntries,
  menuBarTitle,
  menuBarTooltip,
  type MenuBarStatus,
} from "./menuBarStatus.logic.ts";

const chat = (index: number, title = `Chat ${index}`) => ({
  environmentId: "env",
  threadId: `thread-${index}`,
  title,
});
const status = (patch: Partial<MenuBarStatus> = {}): MenuBarStatus => ({
  needsYou: [],
  needsYouCount: 0,
  working: [],
  workingCount: 0,
  limits: [],
  ...patch,
});

describe("menu bar status", () => {
  it("shows a quiet line when nothing is happening", () => {
    expect(menuBarEntries(status(), "SSHCode")).toEqual([
      { kind: "note", label: "No chats need you" },
      { kind: "separator" },
      { kind: "open-app", label: "Open SSHCode" },
    ]);
    expect(menuBarTitle(status())).toBe("");
    expect(menuBarTooltip(status(), "SSHCode")).toBe("SSHCode: no chats need you");
  });

  it("lists chats that need the user before chats still working, then limits", () => {
    const entries = menuBarEntries(
      status({
        needsYou: [chat(1, "Fix the login bug")],
        needsYouCount: 1,
        working: [chat(2, "Port the sweep")],
        workingCount: 1,
        limits: ["Claude · Weekly: 74% used"],
      }),
      "SSHCode",
    );
    expect(entries.map((entry) => ("label" in entry ? entry.label : "-"))).toEqual([
      "Needs you",
      "Fix the login bug",
      "-",
      "Working",
      "Port the sweep",
      "-",
      "Limits",
      "Claude · Weekly: 74% used",
      "-",
      "Open SSHCode",
    ]);
    expect(entries[1]).toMatchObject({ kind: "chat", chat: { threadId: "thread-1" } });
  });

  it("counts every chat even when the list is cut short", () => {
    const many = Array.from({ length: 12 }, (_, index) => chat(index));
    const value = status({ needsYou: many, needsYouCount: 15 });
    const entries = menuBarEntries(value, "SSHCode");
    expect(entries.filter((entry) => entry.kind === "chat")).toHaveLength(MENU_BAR_ROWS);
    expect(entries).toContainEqual({ kind: "note", label: `+${15 - MENU_BAR_ROWS} more` });
    expect(menuBarTitle(value)).toBe("15");
    expect(menuBarTooltip(value, "SSHCode")).toBe("SSHCode: 15 chats need you");
  });

  it("keeps labels to one short line", () => {
    const entries = menuBarEntries(
      status({ working: [chat(1, `  Rename\n the   thing ${"x".repeat(80)}`), chat(2, "  ")] }),
      "SSHCode",
    );
    const labels = entries.flatMap((entry) => (entry.kind === "chat" ? [entry.label] : []));
    expect(labels[0]).toMatch(/^Rename the thing x+…$/);
    expect(labels[0]).toHaveLength(60);
    expect(labels[1]).toBe("Untitled chat");
    expect(menuBarTooltip(status({ working: [chat(1)], needsYou: [chat(2)] }), "App")).toBe(
      "App: 1 chat needs you, 1 working",
    );
  });
});

import { EnvironmentId, RunId } from "@t3tools/contracts";
import { sessionBoxName } from "@t3tools/shared/sessionBoxes";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  presentSessionBoxCached,
  sessionBoxConnectionPresentation,
  sessionBoxStepText,
} from "./sessionBoxes.ts";

const environmentId = EnvironmentId.make("environment-boxes");
const title = "Improve repository browser rendering and keyboard navigation";
const now = DateTime.toEpochMillis(v2ThreadShell.updatedAt);

describe("what a working chat says it is doing", () => {
  it("uses plain words and never the command, file or tool", () => {
    expect(sessionBoxStepText("reading", { itemType: "command_execution" })).toBe("Reading files");
    expect(sessionBoxStepText("remote", { itemType: "command_execution" })).toBe(
      "Working on another machine",
    );
    expect(sessionBoxStepText("editing", { itemType: "file_change" })).toBe("Editing files");
    expect(sessionBoxStepText("thinking", null)).toBe("Thinking");
  });

  it("names the steps that are not commands for what they are", () => {
    expect(sessionBoxStepText("browsing", { itemType: "web_search" })).toBe("Searching the web");
    expect(sessionBoxStepText("thinking", { itemType: "compaction" })).toBe("Compacting the chat");
    expect(sessionBoxStepText("running", { itemType: "dynamic_tool" })).toBe("Using a tool");
    expect(sessionBoxStepText("reading", { itemType: "dynamic_tool" })).toBe("Reading files");
  });
});

describe("a working chat that reports its stages", () => {
  const progress = (
    stages: ReadonlyArray<{ title: string; status: "done" | "active" | "pending" }>,
  ) => ({
    source: "report" as const,
    startedAt: now - 60_000,
    reportedAt: now,
    stages,
    updates: [],
  });
  const working = (liveProgress?: ReturnType<typeof progress>) =>
    presentSessionBoxCached(
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        title,
        status: "running",
        latestRunId: RunId.make("run-stages"),
        activeRunId: RunId.make("run-stages"),
        ...(liveProgress ? { liveProgress } : {}),
      }),
      { now, unseen: false },
    );

  it("shows the stage it is on instead of its latest step", () => {
    expect(working().status).toBe("Thinking");
    expect(
      working(
        progress([
          { title: "Read the code", status: "done" },
          { title: "Draw the phone cards", status: "active" },
          { title: "Take screenshots", status: "pending" },
        ]),
      ).status,
    ).toBe("Draw the phone cards");
  });

  it("falls back to the step when no stage is active", () => {
    expect(working(progress([{ title: "Read the code", status: "done" }])).status).toBe("Thinking");
  });
});

describe("session box presentation cache", () => {
  it("replaces cached work with connection state while preserving requests and failures", () => {
    const thread = presentThreadShell(environmentId, { ...v2ThreadShell, title });
    const base = presentSessionBoxCached(thread, { now, unseen: false });
    const working = {
      ...base,
      tone: "working" as const,
      activity: "thinking" as const,
      since: "2026-01-01T00:00:00Z",
      mascot: "working" as const,
    };
    expect(sessionBoxConnectionPresentation(working, "reconnecting")).toMatchObject({
      status: "Reconnecting",
      statusShort: "Reconnecting",
      tone: "quiet",
      activity: null,
      since: null,
      badge: null,
      mascot: "idle",
    });
    expect(sessionBoxConnectionPresentation(working, "connected")).toBe(working);
    const asking = { ...working, tone: "asking" as const };
    expect(sessionBoxConnectionPresentation(asking, "offline")).toBe(asking);
    const failed = { ...base, tone: "failed" as const, activity: null };
    expect(sessionBoxConnectionPresentation(failed, "offline")).toBe(failed);
  });

  it("updates age and attention on a clock tick while keeping the chat's name", () => {
    const thread = presentThreadShell(environmentId, { ...v2ThreadShell, title });
    const context = { now, unseen: false, compact: true };
    const before = presentSessionBoxCached(thread, context);
    expect(presentSessionBoxCached(thread, { ...context })).toBe(before);
    const after = presentSessionBoxCached(thread, { ...context, now: now + 7_200_000 });
    expect(after.status).not.toBe(before.status);
    expect(after.label).toBe(before.label);
    expect(after.topic).toBe(before.topic);
    expect(after.face).toBe(before.face);
    expect(after.label).toBe(sessionBoxName(title, { maxChars: 28 }).label);
  });

  it("recomputes the label when the surrounding titles or compact size change", () => {
    const thread = presentThreadShell(environmentId, { ...v2ThreadShell, title });
    const siblingShare = new Map([
      ["repository", 1],
      ["browser", 1],
      ["rendering", 1],
    ]);
    const compact = presentSessionBoxCached(thread, { now, unseen: false, compact: true });
    const grouped = presentSessionBoxCached(thread, {
      now,
      unseen: false,
      compact: true,
      siblingShare,
    });
    expect(grouped.label).toBe(sessionBoxName(title, { maxChars: 28, siblingShare }).label);
    const full = presentSessionBoxCached(thread, {
      now,
      unseen: false,
      compact: false,
      siblingShare,
    });
    expect(full.label).toBe(sessionBoxName(title, { siblingShare }).label);
    expect(presentSessionBoxCached(thread, { now, unseen: false, compact: true }).label).toBe(
      compact.label,
    );
  });

  it("uses a renamed chat and server-provided label immediately", () => {
    const thread = presentThreadShell(environmentId, { ...v2ThreadShell, title });
    presentSessionBoxCached(thread, { now, unseen: false });
    const renamed = { ...thread, title: "Keyboard navigation" };
    expect(presentSessionBoxCached(renamed, { now, unseen: false }).label).toBe(
      "Keyboard navigation",
    );
    const named = { ...renamed, source: { ...renamed.source, boxName: "Navigation" } };
    expect(presentSessionBoxCached(named, { now, unseen: false }).label).toBe("Navigation");
  });
});

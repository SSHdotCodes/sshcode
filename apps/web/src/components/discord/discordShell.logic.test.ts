import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture } from "../../test-fixtures";
import {
  buildDiscordThreadTree,
  discordServers,
  groupDiscordChannels,
  discordServerIdentity,
  flattenDiscordThreadTree,
  discordCategory,
  machineAttentionCounts,
  machineFilterVisible,
  nestDiscordThreads,
  nextAttentionThreadKey,
  threadNeedsYouCount,
  threadIsUnread,
} from "./discordShell.logic";

const machine = EnvironmentId.make("mac");
const thread = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
  makeThreadFixture({ environmentId: machine, id: ThreadId.make(id), ...overrides });
const child = (
  id: string,
  parent: string,
  overrides: Parameters<typeof makeThreadFixture>[0] = {},
) =>
  thread(id, {
    lineage: {
      parentThreadId: ThreadId.make(parent),
      rootThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    ...overrides,
  });

describe("machine navigation", () => {
  it("shows filters only for at least two represented machines", () => {
    expect(machineFilterVisible([])).toBe(false);
    expect(machineFilterVisible([thread("a"), thread("b")])).toBe(false);
    expect(
      machineFilterVisible([
        thread("a"),
        thread("b", { environmentId: EnvironmentId.make("nova") }),
      ]),
    ).toBe(true);
  });
  it("counts requests across machines without counting a propagated child request twice", () => {
    const counts = machineAttentionCounts(
      [
        thread("parent", { pendingSubagentRequest: "approval" }),
        child("child", "parent", { hasPendingApprovals: true }),
        thread("both", { hasPendingApprovals: true, hasPendingUserInput: true }),
        thread("remote", { environmentId: EnvironmentId.make("nova"), hasPendingUserInput: true }),
      ],
      {},
    );
    expect(counts.get(machine)).toBe(3);
    expect(counts.get("nova")).toBe(1);
  });
  it("counts actionable plans, and a failure only until the chat has been opened", () => {
    const now = Date.parse("2026-10-25T13:00:00Z");
    const failedAt = "2026-10-25T12:00:00Z";
    const failed = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
      thread(id, {
        runtime: {
          status: "failed",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: "Command failed",
          updatedAt: failedAt,
        },
        latestRun: {
          runId: RunId.make(`run-${id}`),
          status: "failed",
          requestedAt: null,
          startedAt: null,
          completedAt: failedAt,
          assistantMessageId: null,
        },
        ...overrides,
      });
    const count = (shell: ReturnType<typeof thread>, local?: string) =>
      threadNeedsYouCount(shell, local, now);
    expect(count(thread("plan", { hasActionableProposedPlan: true }))).toBe(1);
    expect(count(thread("quiet"))).toBe(0);
    expect(count(failed("unseen", { lastVisitedAt: "2026-10-25T11:00:00Z" }))).toBe(1);
    expect(count(failed("seen", { lastVisitedAt: "2026-10-25T12:30:00Z" }))).toBe(0);
    // Nobody has opened it: it asks for a day, then goes quiet.
    expect(count(failed("unopened", { lastVisitedAt: null }))).toBe(1);
    expect(
      threadNeedsYouCount(
        failed("old", { lastVisitedAt: null }),
        undefined,
        Date.parse("2026-10-27T12:00:00Z"),
      ),
    ).toBe(0);
    // An older server keeps no visit record; this browser's own record decides.
    const legacy = { ...failed("legacy") };
    delete legacy.lastVisitedAt;
    expect(count(legacy, "2026-10-25T12:30:00Z")).toBe(0);
    expect(count(legacy, "2026-10-25T11:00:00Z")).toBe(1);
    // A subagent's failure goes to the agent that started it.
    expect(
      count(failed("child", { lastVisitedAt: null, lineage: child("child", "parent").lineage })),
    ).toBe(0);

    const counts = machineAttentionCounts(
      [
        // Shown under another machine: its own key still finds this browser's visit.
        { ...legacy, id: ThreadId.make("moved"), visitKey: "mac:moved" },
        failed("fresh", { lastVisitedAt: "2026-10-25T11:00:00Z" }),
      ],
      { "mac:moved": "2026-10-25T12:30:00Z" },
      now,
    );
    expect(counts.get(machine)).toBe(1);
  });
});

describe("Discord channel categories", () => {
  it("keeps explicit shelves, then needs-you, working and chats", () => {
    expect(discordCategory({ section: "pinned", needsYou: true, working: true })).toBe("pinned");
    expect(discordCategory({ section: "snoozed", needsYou: false, working: false })).toBe(
      "snoozed",
    );
    expect(discordCategory({ section: "settled", needsYou: false, working: false })).toBe(
      "settled",
    );
    expect(discordCategory({ section: "active", needsYou: true, working: true })).toBe("needsYou");
    expect(discordCategory({ section: "active", needsYou: false, working: true })).toBe("working");
    expect(discordCategory({ section: "active", needsYou: false, working: false })).toBe("recent");
  });
  it("nests children under their own machine's parent and keeps orphans reachable", () => {
    const result = nestDiscordThreads([
      thread("parent"),
      child("child", "parent"),
      child("orphan", "missing"),
      child("remote", "parent", { environmentId: EnvironmentId.make("nova") }),
    ]);
    expect(result.roots.map((entry) => entry.id)).toEqual(["parent", "orphan", "remote"]);
    expect(result.children.get("mac:parent")?.map((entry) => entry.id)).toEqual(["child"]);
  });
});

describe("attention jump order", () => {
  const order = ["pinned", "quiet", "approval", "working", "unread"];
  const candidates = new Set(["approval", "unread"]);
  it("uses sidebar position even when the current chat is not a candidate", () => {
    expect(nextAttentionThreadKey(order, candidates, "working", "next")).toBe("unread");
    expect(nextAttentionThreadKey(order, candidates, "working", "previous")).toBe("approval");
  });
  it("wraps both directions and enters from the appropriate end", () => {
    expect(nextAttentionThreadKey(order, candidates, "unread", "next")).toBe("approval");
    expect(nextAttentionThreadKey(order, candidates, "pinned", "previous")).toBe("unread");
    expect(nextAttentionThreadKey(order, candidates, null, "next")).toBe("approval");
    expect(nextAttentionThreadKey(order, candidates, null, "previous")).toBe("unread");
  });
  it("has no target when nothing needs attention", () => {
    expect(nextAttentionThreadKey(order, new Set(), "quiet", "next")).toBeNull();
    expect(nextAttentionThreadKey([], candidates, null, "previous")).toBeNull();
  });
});

describe("nested Discord activity", () => {
  it("retains the quiet ancestor of a grandchild that needs you", () => {
    const root = thread("root");
    const quiet = child("quiet", "root");
    const asking = child("asking", "quiet", { hasPendingUserInput: true });
    const hidden = child("hidden", "root");
    const tree = buildDiscordThreadTree(
      root,
      nestDiscordThreads([root, quiet, asking, hidden]).children,
      new Set(),
      (entry) => entry.hasPendingUserInput,
    );
    expect(flattenDiscordThreadTree(tree).map((entry) => entry.id)).toEqual([
      "root",
      "quiet",
      "asking",
    ]);
    expect(tree.hiddenCount).toBe(1);
  });
  it("expands quiet siblings and stops cyclic lineage", () => {
    const root = thread("root");
    const quiet = child("quiet", "root");
    const children = new Map([
      ["mac:root", [quiet]],
      ["mac:quiet", [root]],
    ]);
    const tree = buildDiscordThreadTree(root, children, new Set(["mac:root"]), () => false);
    expect(flattenDiscordThreadTree(tree).map((entry) => entry.id)).toEqual(["root", "quiet"]);
  });
});

describe("unseen agent output", () => {
  it("notices assistant output before completion, without marking user text or new chats unread", () => {
    const base = thread("streaming");
    const message = {
      id: MessageId.make("m1"),
      role: "assistant" as const,
      text: "Working on the changes",
      updatedAt: DateTime.makeUnsafe("2026-10-25T12:00:00Z"),
    };
    const incoming = {
      ...base,
      lastVisitedAt: "2026-10-25T11:59:00Z",
      source: { ...base.source, latestVisibleMessage: message },
    };
    expect(threadIsUnread(incoming, {})).toBe(true);
    expect(threadIsUnread({ ...incoming, lastVisitedAt: "2026-10-25T12:01:00Z" }, {})).toBe(false);
    expect(threadIsUnread({ ...incoming, lastVisitedAt: null }, {})).toBe(false);
    expect(
      threadIsUnread(
        {
          ...incoming,
          source: { ...incoming.source, latestVisibleMessage: { ...message, role: "user" } },
        },
        {},
      ),
    ).toBe(false);
  });
});

describe("tab servers", () => {
  it("uses tab order and rolls up unread and mentions only from each server's chats", () => {
    const a = thread("a", { hasPendingApprovals: true });
    const base = thread("b", { hasPendingUserInput: true });
    const b = {
      ...base,
      lastVisitedAt: "2026-10-25T11:59:00Z",
      source: {
        ...base.source,
        latestVisibleMessage: {
          id: MessageId.make("unread"),
          role: "assistant" as const,
          text: "New output",
          updatedAt: DateTime.makeUnsafe("2026-10-25T12:00:00Z"),
        },
      },
    };
    const server = (name: string, threadKeys: string[]) => ({
      key: name,
      name,
      threadKeys: new Set(threadKeys),
      attention: false,
      working: false,
    });
    const views = discordServers(
      [server("Second", ["mac:b"]), server("First", ["mac:a"]), server("Empty", [])],
      [a, b],
      {},
    );
    expect(views.map(({ unread }) => unread)).toEqual([true, false, false]);
    expect(views.map(({ tab, needsYou }) => [tab.name, needsYou])).toEqual([
      ["Second", 1],
      ["First", 1],
      ["Empty", 0],
    ]);
  });
  it("groups channels under their machine, preserves channel order, and hides empty categories", () => {
    const a = thread("a");
    const b = thread("b", { environmentId: EnvironmentId.make("nova") });
    const c = thread("c");
    const groups = groupDiscordChannels(
      [a, b, c],
      ["nova", "mac", "empty"],
      (entry) => entry.environmentId,
    );
    expect([...groups].map(([key, entries]) => [key, entries.map((entry) => entry.id)])).toEqual([
      ["nova", ["b"]],
      ["mac", ["a", "c"]],
    ]);
  });
  it("keeps painted identities and their initials/color fallback stable across tab case", () => {
    expect(discordServerIdentity("Build Tools")).toEqual(discordServerIdentity("build tools"));
    expect(discordServerIdentity("Build Tools").initials).toBe("BT");
    expect(discordServerIdentity("   ").initials).toBe("S");
    expect(discordServerIdentity("Build Tools").face).toMatch(/^topic-/u);
  });
});

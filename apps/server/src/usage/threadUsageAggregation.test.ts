// @effect-diagnostics globalDate:off -- Fixed test instants.
import { describe, expect, it } from "vite-plus/test";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { aggregateThreadUsage, type UsageThreadBinding } from "./threadUsageAggregation.ts";

const now = Date.parse("2026-11-09T15:00:00Z");
const instance = ProviderInstanceId.make("codex");
const binding = (
  id: string,
  sessionId: string,
  parentThreadId: string | null = null,
): UsageThreadBinding => ({
  threadId: ThreadId.make(id),
  title: id,
  instanceId: instance,
  sessionId,
  parentThreadId: parentThreadId ? ThreadId.make(parentThreadId) : null,
});
const record = (
  sessionId: string,
  tokens: number,
  timestampMs = now,
  key = sessionId,
): UsageRecord => ({
  provider: "codex",
  sessionId,
  model: "test",
  timestampMs,
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: tokens },
  speed: "standard",
  reportedCostUsd: null,
  dedupeKey: key,
});
const options = {
  threadId: ThreadId.make("chat"),
  now,
  timeZone: "America/New_York",
  weeklyStartMs: now - 7 * 86400000,
  weeklyEndMs: now + 1000,
  accountInstanceIds: [instance],
  rates: new Map([
    [
      "test",
      {
        inputCostPerToken: 1,
        outputCostPerToken: 2,
        cacheReadCostPerToken: 0.1,
        cacheCreationCostPerToken: 1,
        fast: null,
        ultrafast: null,
      },
    ],
  ]),
};

describe("chat usage attribution", () => {
  it("deduplicates, includes descendants once, and splits today in the viewer zone", () => {
    const result = aggregateThreadUsage({
      ...options,
      bindings: [binding("chat", "main"), binding("child", "child", "chat")],
      sources: [
        {
          instanceId: instance,
          files: [
            {
              path: "/main",
              records: [record("main", 100, now - 12 * 3600000), record("main", 200, now, "new")],
            },
            { path: "/copy", records: [record("main", 200, now, "new")] },
            { path: "/child", records: [record("child", 50)] },
          ],
        },
      ],
    });
    expect(result.allTime.tokens.uncachedInputTokens).toBe(350);
    expect(result.today.tokens.uncachedInputTokens).toBe(250);
    expect(result.subagents).toEqual([{ model: "test", runs: 1, tokens: 50 }]);
    expect(result.weeklyShare?.percent).toBe(100);
  });
  it("counts a copied rollout once across two homes for the same account", () => {
    const alternate = ProviderInstanceId.make("codex-alternate");
    const occurrences = [record("main", 100, now, "event:1"), record("main", 100, now, "event:2")];
    const result = aggregateThreadUsage({
      ...options,
      accountInstanceIds: [instance, alternate],
      bindings: [binding("chat", "main"), binding("child", "independent", "chat")],
      sources: [
        {
          instanceId: instance,
          files: [
            { path: "/old/rollout", records: occurrences },
            { path: "/old/independent", records: [record("independent", 50, now, "event:1")] },
          ],
        },
        { instanceId: alternate, files: [{ path: "/new/rollout", records: occurrences }] },
      ],
    });
    expect(result.allTime.tokens.uncachedInputTokens).toBe(250);
    expect(result.allTime.costUsd).toBe(250);
  });
  it("uses exact weekly boundaries and keeps unmapped sessions in others", () => {
    const result = aggregateThreadUsage({
      ...options,
      weeklyStartMs: now,
      bindings: [binding("chat", "main"), binding("other", "other")],
      sources: [
        {
          instanceId: instance,
          files: [
            {
              path: "/sessions",
              records: [
                record("main", 100, now - 1, "old"),
                record("main", 100),
                record("other", 200),
                record("external", 100),
              ],
            },
          ],
        },
      ],
    });
    expect(result.weeklyShare?.percent).toBe(25);
    expect(result.weeklyShare?.chats.map((chat) => chat.title)).toEqual(["other", "chat"]);
    expect(result.weeklyShare?.othersPercent).toBe(25);
  });
  it("maps native sidechains, reports unpriced tokens, and does not mix accounts", () => {
    const native = { ...record("native", 40), model: "unknown" };
    const result = aggregateThreadUsage({
      ...options,
      bindings: [binding("chat", "main")],
      sources: [
        {
          instanceId: instance,
          files: [
            {
              path: "/main",
              records: [record("main", 100)],
              details: [
                { kind: "subagent" as const, sessionId: "native", parentSessionId: "main" },
              ],
            },
            { path: "/native", records: [native] },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("work"),
          files: [{ path: "/work", records: [record("main", 900, now, "work")] }],
        },
      ],
    });
    expect(result.allTime.tokens.uncachedInputTokens).toBe(140);
    expect(result.allTime.unpricedTokens).toBe(40);
    expect(result.subagents).toEqual([{ model: "unknown", runs: 1, tokens: 40 }]);
  });
  it("counts compactions once and preserves unknown sizes", () => {
    const detail = {
      kind: "compaction" as const,
      sessionId: "main",
      timestampMs: now,
      beforeTokens: 167000,
      afterTokens: null,
    };
    const result = aggregateThreadUsage({
      ...options,
      bindings: [binding("chat", "main")],
      sources: [
        {
          instanceId: instance,
          files: [
            { path: "/a", records: [record("main", 100)], details: [detail] },
            { path: "/copy", records: [], details: [detail] },
          ],
        },
      ],
    });
    expect(result.compactions).toEqual({
      count: 1,
      summarizedTokens: 167000,
      unknownSizes: 0,
      last: { beforeTokens: 167000, afterTokens: null, at: new Date(now).toISOString() },
    });
  });
});

it("counts app-owned subagent turns as runs even when they reuse one native session", () => {
  const result = aggregateThreadUsage({
    ...options,
    bindings: [binding("chat", "main"), binding("child", "child", "chat")],
    sources: [
      { instanceId: instance, files: [{ path: "/child", records: [record("child", 50)] }] },
    ],
    appSubagentRuns: [
      { id: "run1", threadId: ThreadId.make("child"), model: "test" },
      { id: "run2", threadId: ThreadId.make("child"), model: "test" },
    ],
  });
  expect(result.subagentRuns).toBe(2);
  expect(result.subagents).toEqual([{ model: "test", runs: 2, tokens: 50 }]);
});

it("counts the native compacted record and its completion notification once", () => {
  const result = aggregateThreadUsage({
    ...options,
    bindings: [binding("chat", "main")],
    sources: [
      {
        instanceId: instance,
        files: [
          {
            path: "/s",
            records: [record("main", 1)],
            details: [
              {
                kind: "compaction",
                sessionId: "main",
                timestampMs: now - 1,
                beforeTokens: null,
                afterTokens: null,
                origin: "boundary",
              },
              {
                kind: "compaction",
                sessionId: "main",
                timestampMs: now,
                beforeTokens: null,
                afterTokens: null,
                origin: "notification",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.compactions.count).toBe(1);
});

it("counts a native subagent that spawned before emitting any usage", () => {
  const result = aggregateThreadUsage({
    ...options,
    bindings: [binding("chat", "main")],
    sources: [
      {
        instanceId: instance,
        files: [
          {
            path: "/child",
            records: [],
            details: [{ kind: "subagent", sessionId: "native", parentSessionId: "main" }],
          },
        ],
      },
    ],
  });
  expect(result.subagentRuns).toBe(1);
  expect(result.subagents).toEqual([{ model: "Unknown model", runs: 1, tokens: 0 }]);
});

it("keeps the selected child chat visible in a disjoint weekly breakdown", () => {
  const result = aggregateThreadUsage({
    ...options,
    threadId: ThreadId.make("child"),
    bindings: [binding("chat", "main"), binding("child", "child", "chat")],
    sources: [
      {
        instanceId: instance,
        files: [{ path: "/s", records: [record("main", 100), record("child", 50)] }],
      },
    ],
  });
  expect(result.weeklyShare?.percent).toBeCloseTo(100 / 3);
  expect(result.weeklyShare?.chats.find((chat) => chat.threadId === "child")?.percent).toBeCloseTo(
    100 / 3,
  );
  expect(result.weeklyShare?.othersPercent).toBeCloseTo(0);
});

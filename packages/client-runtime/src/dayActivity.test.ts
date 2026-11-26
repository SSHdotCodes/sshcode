import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildDayActivity, dayActivitySummary } from "./dayActivity.ts";

const DAY_START = Date.parse("2026-11-25T05:00:00.000Z");
const at = (hour: number, minute = 0) =>
  DateTime.formatIso(DateTime.makeUnsafe(DAY_START + hour * 3_600_000 + minute * 60_000));
const NOW = Date.parse(at(15, 30));

type Thread = Parameters<typeof buildDayActivity>[0][number];

function thread(patch: {
  createdAt?: string;
  wroteAt?: string | null;
  run?: [start: string, end: string | null];
  subagent?: boolean;
  working?: boolean;
  instance?: string;
}): Thread {
  return {
    environmentId: "mac",
    providerInstanceId: patch.instance ?? "claude",
    createdAt: patch.createdAt ?? at(-48),
    latestUserMessageAt: patch.wroteAt ?? null,
    lineage: { relationshipToParent: patch.subagent ? "subagent" : "root" },
    latestRun: patch.run
      ? { startedAt: patch.run[0], requestedAt: patch.run[0], completedAt: patch.run[1] }
      : null,
    runtime: patch.working
      ? { status: "running", providerInstanceId: patch.instance ?? "claude" }
      : null,
  } as unknown as Thread;
}

describe("buildDayActivity", () => {
  it("lights every hour a run spanned and counts chats apart from subagents", () => {
    const activity = buildDayActivity(
      [
        thread({ run: [at(9, 10), at(11, 5)] }),
        thread({ run: [at(10), at(10, 20)], subagent: true, instance: "codex" }),
        thread({ createdAt: at(2), wroteAt: at(10, 1) }),
        thread({ run: [at(-30), at(-29)] }),
      ],
      NOW,
      DAY_START,
    );
    expect(activity.levels.slice(0, 12)).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 4, 2]);
    expect(activity).toMatchObject({
      currentHour: 15,
      chats: 2,
      subagents: 1,
      working: 0,
      leadSource: "mac:claude",
    });
  });

  it("runs a working chat up to now, and starts a run from yesterday at midnight", () => {
    const activity = buildDayActivity(
      [thread({ run: [at(14, 50), null], working: true }), thread({ run: [at(-2), at(1, 30)] })],
      NOW,
      DAY_START,
    );
    expect(activity.levels.map((level) => (level > 0 ? 1 : 0)).join("")).toBe(
      "110000000000001100000000",
    );
    expect(activity.working).toBe(1);
  });

  it("leaves a subagent that only started, without running, out", () => {
    const activity = buildDayActivity(
      [thread({ createdAt: at(3), subagent: true })],
      NOW,
      DAY_START,
    );
    expect(activity.subagents).toBe(0);
    expect(dayActivitySummary(activity)).toBe("Nothing yet");
  });
});

describe("dayActivitySummary", () => {
  it("names only what happened", () => {
    expect(dayActivitySummary({ chats: 1, subagents: 0 })).toBe("1 chat");
    expect(dayActivitySummary({ chats: 6, subagents: 14 })).toBe("6 chats · 14 subagents");
  });
});

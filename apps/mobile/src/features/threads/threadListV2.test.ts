import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { planPinnedMove } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
  type ThreadMoveAvailability,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  rankedContentSearchMatches,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2DisplayStatus,
  resolveThreadListV2SwipeActions,
  threadListV2ListItemsAreEqual,
  threadListV2SwipeResetKey,
  threadHasUnseenCompletion,
  type ThreadListV2ListItem,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    ...input,
  });
}

const NOW = "2026-06-02T00:00:00.000Z";

const linkedPullRequest = {
  projectId: ProjectId.make("project-1"),
  repository: "pingdotgg/t3code",
  number: 42,
  url: "https://github.com/pingdotgg/t3code/pull/42",
};

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2Status", () => {
  it("distinguishes usage limits from ordinary failures and clears the label after recovery", () => {
    const thread = makeThread({
      id: ThreadId.make("limited"),
      title: "Limited",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("limited");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, lastErrorClass: null },
      }),
    ).toBe("failed");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, status: "completed" },
      }),
    ).toBe("ready");
  });

  it("prioritizes approval over a running runtime", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      runtime: {
        status: "running",
        activeRunId: RunId.make("run-t"),
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("reports waiting when presentation parks runtime idle for background tasks", () => {
    expect(
      resolveThreadListV2Status(
        makeThread({
          id: ThreadId.make("t"),
          title: "t",
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
          runtime: {
            status: "idle",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe("waiting");
  });

  it.each([
    { kind: "command", status: "ready" },
    { kind: "monitor", status: "waiting" },
  ] as const)(
    "presents an unseen completion with a $kind roster as $status",
    ({ kind, status }) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-background-completion"),
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
          pendingBackgroundTasks: [{ taskId: "background-work", kind }],
        }),
      );

      expect(resolveThreadListV2Status(thread)).toBe(status);
      expect(threadHasUnseenCompletion(thread)).toBe(true);
    },
  );

  it.each(["interrupted", "cancelled"] as const)(
    "does not present a %s run as an unseen completion",
    (status) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-stopped"),
          status,
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
        }),
      );

      expect(threadHasUnseenCompletion(thread)).toBe(false);
    },
  );

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("queued messages keep a settled thread in place", () => {
  const threads = [
    makeThread({ id: ThreadId.make("active"), title: "Active" }),
    makeThread({ id: ThreadId.make("settled"), title: "Settled", settledOverride: "settled" }),
    makeThread({
      id: ThreadId.make("settled-queued"),
      title: "Settled with outbox",
      settledOverride: "settled",
    }),
  ];
  const queuedThreadKeys = new Set([`${environmentId}:settled-queued`]);

  it("keeps a settled pin with queued messages in the pinned block", () => {
    const pinnedAt = "2026-06-01T12:00:00.000Z";
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned settled",
          pinnedAt,
          settledOverride: "settled",
        }),
        makeThread({
          id: ThreadId.make("pinned-settled-queued"),
          title: "Pinned settled with outbox",
          pinnedAt,
          settledOverride: "settled",
        }),
      ],
      searchQuery: "",
      now: NOW,
      queuedThreadKeys: new Set([`${environmentId}:pinned-settled-queued`]),
    });
    expect(layout.items.map((item) => [item.thread.id, item.pinned] as const)).toEqual([
      ["pinned-settled-queued", true],
    ]);
  });

  it("includes it in the reorderable active section", () => {
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW, queuedThreadKeys }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active", "settled-queued"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active"]);
  });
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers archive and snooze for a snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: "snooze" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null });
    expect(
      resolveThreadListV2SwipeActions({
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "archive", secondary: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("getThreadListV2OrderedSection", () => {
  it("uses each saved order and excludes settled, snoozed, and archived rows", () => {
    const legacyPlacement = { longRunningOverride: "include" } as const;
    const threads = [
      makeThread({
        id: ThreadId.make("active-later"),
        title: "Later",
        activeOrderKey: "t",
        ...legacyPlacement,
      }),
      makeThread({ id: ThreadId.make("active-first"), title: "First", activeOrderKey: "f" }),
      makeThread({ id: ThreadId.make("active-new"), title: "New" }),
      makeThread({
        id: ThreadId.make("pinned-later"),
        title: "Pinned later",
        pinnedAt: NOW,
        pinOrderKey: "t",
        activeOrderKey: "f",
      }),
      makeThread({
        id: ThreadId.make("pinned-first"),
        title: "Pinned first",
        pinnedAt: NOW,
        pinOrderKey: "f",
        activeOrderKey: "t",
      }),
      makeThread({ id: ThreadId.make("settled"), title: "Settled", settledOverride: "settled" }),
      makeThread({ id: ThreadId.make("archived"), title: "Archived", archivedAt: NOW }),
      makeThread({
        id: ThreadId.make("snoozed"),
        title: "Snoozed",
        snoozedUntil: "2026-06-03T10:00:00.000Z",
        snoozedAt: NOW,
      }),
      makeThread({
        id: ThreadId.make("pinned-snoozed"),
        title: "Pinned snoozed",
        pinnedAt: NOW,
        snoozedUntil: "2026-06-03T10:00:00.000Z",
        snoozedAt: NOW,
      }),
    ];
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active-new", "active-first", "active-later"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "pinned", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["pinned-first", "pinned-later"]);
  });
});

const RUNNING = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW,
};

/** A finished run whose latest activity is `completedAt`. */
function finishedRun(id: string, completedAt: string) {
  return {
    runId: RunId.make(`run-${id}`),
    status: "completed" as const,
    requestedAt: "2026-06-01T00:00:00.000Z",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt,
    assistantMessageId: null,
  };
}

describe("buildThreadListV2Items", () => {
  it("leads with pinned, then live work, then everything else by recent activity", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("finished-early"),
          title: "finished-early",
          latestRun: finishedRun("finished-early", "2026-06-01T01:00:00.000Z"),
        }),
        makeThread({
          id: ThreadId.make("settled-late"),
          title: "settled-late",
          settledOverride: "settled",
          // The settle stamp is not activity: only the run's finish orders it.
          settledAt: "2026-06-01T23:00:00.000Z",
          latestRun: finishedRun("settled-late", "2026-06-01T03:00:00.000Z"),
        }),
        makeThread({
          id: ThreadId.make("messaged"),
          title: "messaged",
          latestUserMessageAt: "2026-06-01T02:00:00.000Z",
          latestRun: finishedRun("messaged", "2026-06-01T02:00:00.000Z"),
        }),
        makeThread({
          id: ThreadId.make("working-old"),
          title: "working-old",
          createdAt: "2026-05-01T00:00:00.000Z",
          runtime: RUNNING,
        }),
        makeThread({
          id: ThreadId.make("asks-approval"),
          title: "asks-approval",
          createdAt: "2026-06-01T04:00:00.000Z",
          runtime: RUNNING,
          hasPendingApprovals: true,
        }),
        makeThread({
          id: ThreadId.make("asks-question"),
          title: "asks-question",
          createdAt: "2026-05-15T00:00:00.000Z",
          hasPendingUserInput: true,
        }),
        makeThread({
          id: ThreadId.make("pinned-idle"),
          title: "pinned-idle",
          createdAt: "2026-05-01T00:00:00.000Z",
          pinnedAt: "2026-05-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("pinned-working"),
          title: "pinned-working",
          createdAt: "2026-05-02T00:00:00.000Z",
          pinnedAt: "2026-05-02T00:00:00.000Z",
          runtime: RUNNING,
        }),
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.pinned] as const)).toEqual([
      // Pins keep their own arrangement (newest-created first without keys).
      ["pinned-working", true],
      ["pinned-idle", true],
      // Working or waiting on the user, newest activity first.
      ["asks-approval", false],
      ["asks-question", false],
      ["working-old", false],
      // Unsettled history follows live work; settled history is collapsed.
      ["messaged", false],
      ["finished-early", false],
    ]);
    expect(layout.pendingTasksIndex).toBe(5);
    expect(layout.snoozedShelfHeaderIndex).toBeNull();
  });

  it("lists a finished reply you haven't opened above working chats", () => {
    const working = makeThread({
      id: ThreadId.make("working-new"),
      title: "working-new",
      latestUserMessageAt: "2026-06-01T08:00:00.000Z",
      runtime: RUNNING,
    });
    const unread = makeThread({
      id: ThreadId.make("finished-unread"),
      title: "finished-unread",
      latestRun: finishedRun("finished-unread", "2026-06-01T05:00:00.000Z"),
      lastVisitedAt: "2026-06-01T04:00:00.000Z",
    });
    const read = makeThread({
      id: ThreadId.make("finished-read"),
      title: "finished-read",
      latestRun: finishedRun("finished-read", "2026-06-01T06:00:00.000Z"),
      lastVisitedAt: "2026-06-01T07:00:00.000Z",
    });

    expect(
      buildThreadListV2Items({
        threads: [read, working, unread],
        searchQuery: "",
        now: NOW,
      }).items.map((item) => item.thread.id),
    ).toEqual(["finished-unread", "working-new", "finished-read"]);
  });

  it("moves a finished reply up only once it has stayed finished", () => {
    const working = makeThread({
      id: ThreadId.make("working"),
      title: "working",
      latestUserMessageAt: "2026-06-01T08:00:00.000Z",
      runtime: RUNNING,
    });
    const finished = makeThread({
      id: ThreadId.make("finished"),
      title: "finished",
      latestUserMessageAt: "2026-06-01T07:00:00.000Z",
      latestRun: finishedRun("finished", "2026-06-01T09:00:00.000Z"),
      lastVisitedAt: "2026-06-01T07:00:00.000Z",
    });
    const ids = (now: string) =>
      buildThreadListV2Items({ threads: [working, finished], searchQuery: "", now }).items.map(
        (item) => item.thread.id,
      );

    // It may start again in a moment, so it keeps its place among working chats.
    expect(ids("2026-06-01T09:01:00.000Z")).toEqual(["working", "finished"]);
    expect(ids("2026-06-01T09:02:00.000Z")).toEqual(["finished", "working"]);
  });

  it("orders working chats by what you last asked, not by turns the agent starts", () => {
    const asked = makeThread({
      id: ThreadId.make("asked"),
      title: "asked",
      latestUserAuthoredMessageAt: "2026-06-01T08:00:00.000Z",
      latestUserMessageAt: "2026-06-01T08:00:00.000Z",
      runtime: RUNNING,
    });
    // A child reporting back starts a turn with a newer system message.
    const woken = makeThread({
      id: ThreadId.make("woken"),
      title: "woken",
      latestUserAuthoredMessageAt: "2026-06-01T07:00:00.000Z",
      latestUserMessageAt: "2026-06-01T08:30:00.000Z",
      runtime: RUNNING,
    });

    expect(
      buildThreadListV2Items({ threads: [woken, asked], searchQuery: "", now: NOW }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual(["asked", "woken"]);
  });

  it("rises unseen failures and actionable plans above working chats immediately", () => {
    const working = makeThread({
      id: ThreadId.make("working"),
      title: "working",
      latestUserMessageAt: "2026-06-01T09:00:25.000Z",
      runtime: RUNNING,
    });
    const unopenedFailure = makeThread({
      id: ThreadId.make("failed-unopened"),
      title: "failed-unopened",
      updatedAt: "2026-06-01T09:00:10.000Z",
      latestRun: {
        ...finishedRun("failed-unopened", "2026-06-01T09:00:10.000Z"),
        status: "failed",
      },
      runtime: { ...RUNNING, status: "failed", activeRunId: null },
      lastVisitedAt: null,
    });
    const seenFailure = makeThread({
      id: ThreadId.make("failed-seen"),
      title: "failed-seen",
      updatedAt: "2026-06-01T09:00:20.000Z",
      latestRun: {
        ...finishedRun("failed-seen", "2026-06-01T09:00:20.000Z"),
        status: "failed",
      },
      runtime: { ...RUNNING, status: "failed", activeRunId: null },
      lastVisitedAt: "2026-06-01T09:00:22.000Z",
    });
    const planReady = makeThread({
      id: ThreadId.make("plan-ready"),
      title: "plan-ready",
      latestRun: finishedRun("plan-ready", "2026-06-01T08:55:00.000Z"),
      hasActionableProposedPlan: true,
      lastVisitedAt: "2026-06-01T08:56:00.000Z",
    });

    expect(
      buildThreadListV2Items({
        threads: [working, seenFailure, planReady, unopenedFailure],
        searchQuery: "",
        now: "2026-06-01T09:00:30.000Z",
      }).items.map((item) => item.thread.id),
    ).toEqual(["failed-unopened", "plan-ready", "working", "failed-seen"]);

    // Pre-tracking server (lastVisitedAt === undefined): mobile cannot record visits,
    // so failures do not get stuck above working chats for 24 hours.
    const oldServerFailure = makeThread({
      id: ThreadId.make("failed-old-server"),
      title: "failed-old-server",
      updatedAt: "2026-06-01T09:00:15.000Z",
      latestRun: {
        ...finishedRun("failed-old-server", "2026-06-01T09:00:15.000Z"),
        status: "failed",
      },
      runtime: { ...RUNNING, status: "failed", activeRunId: null },
      lastVisitedAt: undefined,
    });
    expect(
      buildThreadListV2Items({
        threads: [working, oldServerFailure],
        searchQuery: "",
        now: "2026-06-01T09:00:30.000Z",
      }).items.map((item) => item.thread.id),
    ).toEqual(["working", "failed-old-server"]);
  });

  it("holds main order during touch/scroll and holds an opened needs-you chat in place", () => {
    const openedRead = makeThread({
      id: ThreadId.make("opened-read"),
      title: "opened-read",
      latestRun: finishedRun("opened-read", "2026-06-01T05:00:00.000Z"),
      lastVisitedAt: "2026-06-01T05:05:00.000Z",
    });
    const working = makeThread({
      id: ThreadId.make("working"),
      title: "working",
      latestUserMessageAt: "2026-06-01T08:00:00.000Z",
      runtime: RUNNING,
    });
    const idle = makeThread({
      id: ThreadId.make("idle"),
      title: "idle",
      latestRun: finishedRun("idle", "2026-06-01T04:00:00.000Z"),
    });

    // Holding an opened Needs-you chat keeps it above working until navigated away.
    expect(
      buildThreadListV2Items({
        threads: [working, openedRead, idle],
        searchQuery: "",
        now: NOW,
        heldNeedsYouKey: `${openedRead.environmentId}:${openedRead.id}`,
      }).items.map((item) => item.thread.id),
    ).toEqual(["opened-read", "working", "idle"]);

    // Holding main order while touching/scrolling prevents rows from jumping.
    expect(
      buildThreadListV2Items({
        threads: [working, idle, openedRead],
        searchQuery: "",
        now: NOW,
        heldMainOrderKeys: [
          `${idle.environmentId}:${idle.id}`,
          `${openedRead.environmentId}:${openedRead.id}`,
          `${working.environmentId}:${working.id}`,
        ],
      }).items.map((item) => item.thread.id),
    ).toEqual(["idle", "opened-read", "working"]);
  });

  it("moves a finished thread out of the live block to the top of the rest", () => {
    const working = makeThread({
      id: ThreadId.make("was-working"),
      title: "was-working",
      runtime: RUNNING,
    });
    const recent = makeThread({
      id: ThreadId.make("recent"),
      title: "recent",
      latestRun: finishedRun("recent", "2026-06-01T05:00:00.000Z"),
    });
    const ids = (threads: EnvironmentThreadShell[]) =>
      buildThreadListV2Items({ threads, searchQuery: "", now: NOW }).items.map(
        (item) => item.thread.id,
      );

    expect(ids([recent, working])).toEqual(["was-working", "recent"]);
    expect(
      ids([
        recent,
        {
          ...working,
          runtime: { ...RUNNING, status: "completed" as const },
          latestRun: finishedRun("was-working", "2026-06-01T06:00:00.000Z"),
        },
      ]),
    ).toEqual(["was-working", "recent"]);
    expect(
      ids([
        recent,
        {
          ...working,
          runtime: { ...RUNNING, status: "completed" as const },
          latestRun: finishedRun("was-working", "2026-06-01T04:00:00.000Z"),
        },
      ]),
    ).toEqual(["recent", "was-working"]);
  });

  it("hides snoozed threads and counts them — visibility parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("woken"),
          title: "Woken",
          // Wake time already passed: back in the list.
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      now: NOW,
    });

    // Same activity → id tiebreak; the point is the woken thread is BACK in
    // the list and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("moves a settled pinned thread out of the pinned block — parity with web (#7969)", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          // Stale settled state (the decider clears it on pin).
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      settledShelfExpanded: true,
      searchQuery: "",
      now: NOW,
    });

    // Since #7969 a settled thread leaves the pinned block even while pinned,
    // matching the pinned section Move up/down plans against.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "pinned-settled"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([false, false]);
  });

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      pinned: true,
      snoozed: false,
    });
  });

  it("snooze hides a pinned thread and wake restores it to the pinned block", () => {
    const snoozedInput = {
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-snoozed"),
          title: "Pinned and snoozed",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      searchQuery: "",
    };

    // Before the wake time: the snooze wins; the pin holds underneath.
    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    // After the wake time: the thread returns pinned, back on top.
    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          // Woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      now: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("builds snoozed rows after the whole list when the shelf is expanded", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("later"),
          title: "Wakes later",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Wakes sooner",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "sooner", "later"]);
    expect(layout.items.map((item) => item.snoozed)).toEqual([false, true, true]);
    expect(layout.snoozedShelfHeaderIndex).toBe(1);
    expect(layout.snoozedCount).toBe(2);
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("keeps the selected thread on a collapsed shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("open"),
          title: "Open",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      now: NOW,
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["open"]);
    expect(layout.items[0]?.snoozed).toBe(true);
    expect(layout.snoozedCount).toBe(2);
  });

  it("keeps snoozed threads visible on environments without the snooze capability", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["snoozed"]);
    expect(layout.snoozedCount).toBe(0);
  });

  it("filters settled and unsettled threads alike by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Fix login again",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      searchQuery: "login",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["match", "settled"]);
  });

  it("finds a settled thread by its linked pull request", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("linked-merged"),
          title: "Linked merged pull request",
          linkedPullRequest,
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({ id: ThreadId.make("unlinked"), title: "Unlinked" }),
      ],
      searchQuery: "#42",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["linked-merged"]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("lists threads from every project and environment", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("local"),
          projectId: ProjectId.make("project-1"),
          title: "Local",
        }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          projectId: ProjectId.make("project-2"),
          title: "Remote",
        }),
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

describe("buildThreadListV2ListItems", () => {
  const working = makeThread({
    id: ThreadId.make("working"),
    title: "working",
    runtime: RUNNING,
  });
  const idle = makeThread({ id: ThreadId.make("idle"), title: "idle" });
  const label = (item: ThreadListV2ListItem) =>
    item.type === "v2-pending"
      ? item.pendingTask.title
      : item.type === "v2-thread"
        ? item.item.thread.id
        : item.type === "v2-settled-shelf"
          ? "settled-shelf"
          : "snoozed-shelf";

  it("splices queued tasks between live work and the rest of the list", () => {
    const items = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({ threads: [idle, working], searchQuery: "", now: NOW }),
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
    });

    expect(items.map(label)).toEqual(["working", "queued-1", "queued-2", "idle"]);
  });

  it("leads with queued tasks when nothing is working", () => {
    const items = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({ threads: [idle], searchQuery: "", now: NOW }),
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-pending", "v2-thread"]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        idle,
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      layout: snoozedLayout,
      pendingTasks: [makePendingTask("queued")],
      snoozedShelfExpanded: false,
    });

    expect(items.map(label)).toEqual(["queued", "idle", "snoozed-shelf", "settled-shelf"]);
    expect(threadJumpTarget(items, "thread.jump.1")?.id).toBe("idle");
    expect(threadJumpTarget(items, "thread.jump.2")).toBeNull();
    expect(threadJumpTarget(items, "thread.jump.3")).toBeNull();
  });
});

describe("pending mobile thread moves", () => {
  function fixture(section: "active" | "pinned" = "active") {
    const rows = ["a", "b", "c"].map((id, index) =>
      makeThread({
        id: ThreadId.make(id),
        title: id === "a" ? "hidden" : "match",
        createdAt: `2026-06-01T0${3 - index}:00:00.000Z`,
        pinnedAt: section === "pinned" ? `2026-06-01T0${3 - index}:00:00.000Z` : null,
      }),
    );
    const ordered = getThreadListV2OrderedSection({ threads: rows, section, now: NOW });
    const orderedIds = ordered.map((row) => `${row.environmentId}:${row.id}`);
    const movedId = orderedIds[2]!;
    const assignments = planPinnedMove({
      orderedIds,
      keysById: new Map(orderedIds.map((id) => [id, null])),
      movedId,
      direction: "up",
    })!;
    const pending = createPendingThreadOrder({
      section,
      ordered,
      movedId,
      direction: "up",
      assignments,
    });
    const update = (current: EnvironmentThreadShell[], assignment: (typeof assignments)[number]) =>
      current.map((row) =>
        `${row.environmentId}:${row.id}` === assignment.id
          ? {
              ...row,
              [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignment.orderKey,
            }
          : row,
      );
    return { rows, assignments, pending, update };
  }

  /** The pinned block is the only manual arrangement the list renders. */
  function layout(
    rows: EnvironmentThreadShell[],
    pendingOrder: PendingThreadOrder | null,
    searchQuery = "",
  ) {
    return buildThreadListV2Items({
      threads: rows,
      pendingOrder,
      searchQuery,
      now: NOW,
    }).items.map((item) => item.thread.id);
  }

  function sectionOrder(
    rows: EnvironmentThreadShell[],
    pendingOrder: PendingThreadOrder | null,
    section: "active" | "pinned",
  ) {
    return getThreadListV2OrderedSection({ threads: rows, section, pendingOrder, now: NOW }).map(
      (row) => row.id,
    );
  }

  it.each(["active", "pinned"] as const)(
    "holds %s order through every intermediate key upsert",
    (section) => {
      const { rows, assignments, pending, update } = fixture(section);
      let current = rows;
      let hold: PendingThreadOrder | null = pending;
      const desired = pending.orderedIds.map((id) => id.split(":")[1]);
      expect(sectionOrder(current, hold, section)).toEqual(desired);
      for (const assignment of assignments) {
        current = update(current, assignment);
        hold = reconcilePendingThreadOrder(
          hold!,
          getThreadListV2OrderedSection({ threads: current, section, now: NOW }),
        );
        expect(hold).not.toBeNull();
        expect(sectionOrder(current, hold, section)).toEqual(desired);
        if (section === "pinned") expect(layout(current, hold)).toEqual(desired);
      }
      expect(reconcilePendingThreadOrder({ ...hold!, commandsComplete: true }, current)).toBeNull();
      expect(sectionOrder(current, null, section)).toEqual(desired);
    },
  );

  it("keeps the action guard pending when receipts precede canonical shells", () => {
    const { rows, assignments, pending, update } = fixture("pinned");
    let hold: PendingThreadOrder | null = { ...pending, commandsComplete: true };
    let current = rows;
    expect(reconcilePendingThreadOrder(hold, current)).toBe(hold);
    for (const [index, assignment] of assignments.entries()) {
      current = update(current, assignment);
      hold = reconcilePendingThreadOrder(hold!, current);
      expect(hold === null).toBe(index === assignments.length - 1);
      expect(layout(current, hold)).toEqual(["a", "c", "b"]);
    }
  });

  it("keeps search results in the full pending section order", () => {
    const { rows, assignments, pending, update } = fixture("pinned");
    const current = update(update(rows, assignments[0]!), assignments[1]!);
    expect(layout(current, pending, "match")).toEqual(["c", "b"]);
  });

  it("releases for real section membership and foreign key changes", () => {
    const { rows, pending } = fixture();
    expect(reconcilePendingThreadOrder(pending, rows.slice(1))).toBeNull();
    const newRow = makeThread({ id: ThreadId.make("new"), title: "new" });
    expect(reconcilePendingThreadOrder(pending, [...rows, newRow])).toBeNull();
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, activeOrderKey: "zz" } : row)),
      ),
    ).toBeNull();
    const settled = rows.map((row, index) =>
      index === 0 ? { ...row, settledOverride: "settled" as const } : row,
    );
    expect(layout(settled, pending)).toEqual(layout(settled, null));
  });

  it("does not hide a concurrent return to a previously confirmed key", () => {
    const { rows, assignments, pending, update } = fixture();
    const confirmed = reconcilePendingThreadOrder(pending, update(rows, assignments[0]!))!;
    expect(reconcilePendingThreadOrder(confirmed, rows)).toBeNull();
  });

  it("preserves the hold for activity but releases for a reopened sort anchor", () => {
    const { rows, pending } = fixture();
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row) => ({ ...row, updatedAt: NOW })),
      ),
    ).toBe(pending);
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, unsettledAt: NOW } : row)),
      ),
    ).toBeNull();
  });
});

describe("mobile move availability", () => {
  const oldEnvironment = EnvironmentId.make("older-server");
  function rows(section: "active" | "pinned", keys: readonly (string | null)[]) {
    return keys.map((key, index) =>
      makeThread({
        id: ThreadId.make(`move-${index}`),
        title: `Move ${index}`,
        environmentId: index === 1 ? oldEnvironment : environmentId,
        activeOrderKey: section === "active" ? key : null,
        pinOrderKey: section === "pinned" ? key : null,
        pinnedAt: section === "pinned" ? NOW : null,
      }),
    );
  }

  it.each(["active", "pinned"] as const)(
    "keeps unsupported keyed %s neighbors as usable anchors",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      const assignments = plan(`${environmentId}:move-0`, "down");
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.id).toBe(`${environmentId}:move-0`);
      expect(assignments![0]!.orderKey > "dd").toBe(true);
      expect(assignments![0]!.orderKey < "ff").toBe(true);
      expect(plan(`${oldEnvironment}:move-1`, "up")).toBeNull();
      expect(plan(`${environmentId}:move-0`, "up")).toBeNull();
    },
  );

  it.each(["active", "pinned"] as const)(
    "disables %s moves requiring unsupported keyless materialization",
    (section) => {
      const ordered = rows(section, [null, null, null]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      expect(plan(`${environmentId}:move-0`, "down")).toBeNull();
      expect(plan(`${environmentId}:move-2`, "up")).toBeNull();
      const supported = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId, oldEnvironment]),
      });
      expect(supported(`${environmentId}:move-0`, "down")).toHaveLength(3);
    },
  );

  it.each(["active", "pinned"] as const)(
    "reserves snoozed %s keys when moving visible rows",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const input = { ordered, section, reorderableEnvironmentIds: new Set([environmentId]) };
      const collision = createThreadMovePlanner(input)(`${environmentId}:move-0`, "down")![0]!
        .orderKey;
      const hidden = {
        ...ordered[0]!,
        id: ThreadId.make("snoozed"),
        snoozedAt: NOW,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
        pinOrderKey: section === "pinned" ? collision : null,
        activeOrderKey: section === "active" ? collision : null,
      };
      const assignments = createThreadMovePlanner({ ...input, allThreads: [...ordered, hidden] })(
        `${environmentId}:move-0`,
        "down",
      );
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.orderKey).not.toBe(collision);
      expect(assignments![0]!.orderKey > "dd" && assignments![0]!.orderKey < "ff").toBe(true);
    },
  );

  it("allows an independent keyed move despite an unsupported keyless row elsewhere", () => {
    const ordered = rows("active", [null, null, "bb", "dd", "ff"]);
    const plan = createThreadMovePlanner({
      ordered,
      section: "active",
      reorderableEnvironmentIds: new Set([environmentId]),
    });
    const assignments = plan(`${environmentId}:move-4`, "up");
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe(`${environmentId}:move-4`);
    expect(assignments![0]!.orderKey > "bb").toBe(true);
    expect(assignments![0]!.orderKey < "dd").toBe(true);
  });
});

describe("thread drag destinations", () => {
  it("moves across multiple rows while keeping hidden anchors in place", () => {
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "c", {
        targetId: "a",
        placement: "before",
      }),
    ).toEqual(["c", "a", "hidden", "b"]);
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "a", {
        targetId: "b",
        placement: "after",
      }),
    ).toEqual(["hidden", "b", "a", "c"]);
  });

  it("rejects missing, self, and unchanged destinations", () => {
    for (const targetId of ["missing", "a", "b"]) {
      expect(
        threadOrderAfterMove(["a", "b", "c"], "a", {
          targetId,
          placement: "before",
        }),
      ).toBeNull();
    }
    expect(threadOrderAfterMove(["a", "b"], "missing", "down")).toBeNull();
  });

  it.each(["active", "pinned"] as const)(
    "persists a dropped %s row and holds its order until confirmed",
    (section) => {
      const ordered = ["a", "b", "c", "d"].map((id) =>
        makeThread({
          id: ThreadId.make(id),
          title: id,
          pinnedAt: section === "pinned" ? NOW : null,
        }),
      );
      const ids = ordered.map((row) => `${row.environmentId}:${row.id}`);
      const direction = { targetId: ids[0]!, placement: "before" as const };
      const assignments = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      })(ids[3]!, direction)!;
      const pending = createPendingThreadOrder({
        section,
        ordered,
        movedId: ids[3]!,
        direction,
        assignments,
      });
      expect(pending.orderedIds).toEqual([ids[3], ids[0], ids[1], ids[2]]);
      const confirmed = ordered.map((row) => ({
        ...row,
        [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignments.find(
          (a) => a.id === `${row.environmentId}:${row.id}`,
        )!.orderKey,
      }));
      expect(
        getThreadListV2OrderedSection({ threads: confirmed, section, now: NOW }).map(
          (row) => `${row.environmentId}:${row.id}`,
        ),
      ).toEqual(pending.orderedIds);
      expect(
        reconcilePendingThreadOrder({ ...pending, commandsComplete: true }, confirmed),
      ).toBeNull();
    },
  );

  it("refuses a drop that would need to rewrite an old server's keyless row", () => {
    const old = EnvironmentId.make("old-server");
    const ordered = [environmentId, old, environmentId].map((env, index) =>
      makeThread({
        id: ThreadId.make(String(index)),
        title: String(index),
        environmentId: env,
      }),
    );
    expect(
      createThreadMovePlanner({
        ordered,
        section: "active",
        reorderableEnvironmentIds: new Set([environmentId]),
      })(`${environmentId}:2`, { targetId: `${environmentId}:0`, placement: "before" }),
    ).toBeNull();
  });
});

it("allows a long drop past an old server even when both adjacent moves fail", () => {
  const old = EnvironmentId.make("old-server");
  const ordered = [
    makeThread({ id: ThreadId.make("a"), title: "a" }),
    makeThread({ id: ThreadId.make("b"), title: "b", environmentId: old }),
    makeThread({ id: ThreadId.make("c"), title: "c", activeOrderKey: "h" }),
    makeThread({ id: ThreadId.make("d"), title: "d", activeOrderKey: "p" }),
  ];
  const planner = createThreadMovePlanner({
    ordered,
    section: "active",
    reorderableEnvironmentIds: new Set([environmentId]),
  });
  const movedId = `${environmentId}:a`;
  expect(planner(movedId, "up")).toBeNull();
  expect(planner(movedId, "down")).toBeNull();
  const assignments = planner(movedId, { targetId: `${environmentId}:d`, placement: "after" });
  expect(assignments).toHaveLength(1);
  expect(assignments![0]!.id).toBe(movedId);
  expect(assignments![0]!.orderKey > "p").toBe(true);
});

describe("cross-section thread drops", () => {
  it.each(["pinned", "active"] as const)("inserts into an empty %s section", (section) => {
    const thread = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${thread.environmentId}:${thread.id}`;
    const destination = { section, targetId: null, placement: "before" as const };
    expect(threadOrderAfterMove([], id, destination)).toEqual([id]);
    const plan = createThreadMovePlanner({
      ordered: [],
      allThreads: [thread],
      section,
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.id).toBe(id);
  });
  it("places an incoming row between existing anchors without rewriting them", () => {
    const a = makeThread({ id: ThreadId.make("a"), title: "a", pinOrderKey: "h" });
    const b = makeThread({ id: ThreadId.make("b"), title: "b", pinOrderKey: "z" });
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${environmentId}:source`;
    const destination = {
      section: "pinned" as const,
      targetId: `${environmentId}:b`,
      placement: "before" as const,
    };
    const plan = createThreadMovePlanner({
      ordered: [a, b],
      allThreads: [a, b, source],
      section: "pinned",
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.orderKey > "h" && plan![0]!.orderKey < "z").toBe(true);
    expect(
      threadOrderAfterMove([`${environmentId}:a`, `${environmentId}:b`], id, destination),
    ).toEqual([`${environmentId}:a`, id, `${environmentId}:b`]);
  });
  it("rejects removed targets and unsupported incoming sources", () => {
    expect(
      threadOrderAfterMove(["a"], "source", {
        section: "active",
        targetId: "gone",
        placement: "before",
      }),
    ).toBeNull();
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    expect(
      createThreadMovePlanner({
        ordered: [],
        allThreads: [source],
        section: "active",
        reorderableEnvironmentIds: new Set(),
      })(`${environmentId}:source`, { section: "active", targetId: null, placement: "before" }),
    ).toBeNull();
  });
  it("clears pinning, settlement and snooze when returning a parked thread to Active", () => {
    const thread = makeThread({
      id: ThreadId.make("parked"),
      title: "parked",
      pinnedAt: NOW,
      settledOverride: "settled",
      snoozedAt: NOW,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    expect(threadDropLifecycle(thread, "active", NOW)).toEqual({
      pin: false,
      unpin: true,
      unsettle: true,
      unsnooze: true,
    });
    expect(threadDropLifecycle(thread, "pinned", NOW)).toEqual({
      pin: true,
      unpin: false,
      unsettle: false,
      unsnooze: false,
    });
  });
  it("does not send lifecycle commands for an ordinary Active reorder", () => {
    expect(
      threadDropLifecycle(
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        "active",
        NOW,
      ),
    ).toEqual({ pin: false, unpin: false, unsettle: false, unsnooze: false });
  });
});

it("excludes subagents from navigation, search and ordering while retaining user forks", () => {
  const root = makeThread({ id: ThreadId.make("root"), title: "Root" });
  const child = makeThread({
    id: ThreadId.make("child"),
    title: "Child",
    lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "subagent" },
  });
  const fork = makeThread({
    id: ThreadId.make("fork"),
    title: "Fork",
    lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "fork" },
  });
  const threads = [root, child, fork];
  expect(
    buildThreadListV2Items({ threads, searchQuery: "", now: NOW }).items.map(
      (item) => item.thread.id,
    ),
  ).toEqual([fork.id, root.id]);
  expect(buildThreadListV2Items({ threads, searchQuery: "Child", now: NOW }).items).toEqual([]);
  expect(
    getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
      (thread) => thread.id,
    ),
  ).toEqual([fork.id, root.id]);
});

/* ─── Recycled-list equality + per-row clock scoping ─────────────────── */

const BASE_MS = Date.parse(NOW);
const isoAt = (ms: number) => new Date(ms).toISOString();
const MINUTE_MS = 60_000;

function runningRuntime() {
  return {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeRunId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function buildTickThreads() {
  return {
    ready: makeThread({
      id: ThreadId.make("tick-ready"),
      title: "tick ready",
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    approval: makeThread({
      id: ThreadId.make("tick-approval"),
      title: "tick approval",
      hasPendingApprovals: true,
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    settled: makeThread({
      id: ThreadId.make("tick-settled"),
      title: "tick settled",
      settledOverride: "settled",
      settledAt: isoAt(BASE_MS - 2 * 24 * 60 * MINUTE_MS),
      latestRun: {
        runId: RunId.make("tick-settled-run"),
        status: "completed",
        requestedAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS - MINUTE_MS),
        startedAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS - MINUTE_MS),
        completedAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
        assistantMessageId: null,
      },
    }),
    snoozed: makeThread({
      id: ThreadId.make("tick-snoozed"),
      title: "tick snoozed",
      snoozedAt: isoAt(BASE_MS - MINUTE_MS),
      snoozedUntil: isoAt(BASE_MS + 2 * 60 * MINUTE_MS),
    }),
  };
}

function buildTickList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  clockMs: number,
  pendingTasks: ReadonlyArray<PendingNewTask>,
  options?: {
    readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly queuedThreadKeys?: ReadonlySet<string>;
    readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
    readonly shelfPreferencesLoading?: boolean;
  },
): ThreadListV2ListItem[] {
  const now = isoAt(clockMs);
  const layout = buildThreadListV2Items({
    threads,
    searchQuery: "",
    now,
    settledShelfExpanded: true,
    snoozedShelfExpanded: true,
  });
  return buildThreadListV2ListItems({
    layout,
    pendingTasks,
    settledShelfExpanded: true,
    snoozedShelfExpanded: true,
    snoozeLabelNow: now,
    ...(options?.snoozeEnvironmentIds
      ? { snoozeEnvironmentIds: options.snoozeEnvironmentIds }
      : {}),
    ...(options?.queuedThreadKeys ? { queuedThreadKeys: options.queuedThreadKeys } : {}),
    ...(options?.moveAvailability ? { moveAvailability: options.moveAvailability } : {}),
    ...(options?.shelfPreferencesLoading !== undefined
      ? { shelfPreferencesLoading: options.shelfPreferencesLoading }
      : {}),
  });
}

function itemsByThreadKey(items: ReadonlyArray<ThreadListV2ListItem>) {
  const byKey = new Map<string, ThreadListV2ListItem>();
  for (const item of items) byKey.set(item.key, item);
  return byKey;
}

describe("threadListV2ListItemsAreEqual", () => {
  const thread = makeThread({
    id: ThreadId.make("eq"),
    title: "eq",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const layout = buildThreadListV2Items({
    threads: [thread],
    searchQuery: "",
    now: NOW,
  });
  // One queued task object shared across builds: identity, not content, is
  // what the row equality compares (mirrors the store's stable references).
  const queued = makePendingTask("eq-queued");
  const build = () =>
    buildThreadListV2ListItems({
      layout,
      pendingTasks: [queued],
      snoozeLabelNow: NOW,
    });

  it("treats rebuilt wrappers over identical rows as equal", () => {
    const first = build();
    const second = build();
    expect(first.length).toBe(second.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]).not.toBe(second[index]);
      expect(threadListV2ListItemsAreEqual(first[index]!, second[index]!)).toBe(true);
    }
  });

  it("notices a replaced thread shell", () => {
    const replacement = makeThread({ id: ThreadId.make("eq"), title: "renamed" });
    const next = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({
        threads: [replacement],
        searchQuery: "",
        now: NOW,
      }),
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    const previousThread = build().find((item) => item.type === "v2-thread")!;
    const nextThread = next.find((item) => item.type === "v2-thread")!;
    expect(threadListV2ListItemsAreEqual(previousThread, nextThread)).toBe(false);
  });

  it("notices a changed wake countdown label", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("wake"),
          title: "wake",
          snoozedAt: NOW,
          snoozedUntil: isoAt(BASE_MS + 61 * MINUTE_MS),
        }),
      ],
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    const earlier = buildThreadListV2ListItems({
      layout: snoozedLayout,
      pendingTasks: [],
      snoozedShelfExpanded: true,
      snoozeLabelNow: NOW,
    });
    const later = buildThreadListV2ListItems({
      layout: snoozedLayout,
      pendingTasks: [],
      snoozedShelfExpanded: true,
      snoozeLabelNow: isoAt(BASE_MS + MINUTE_MS),
    });
    const rows = (items: ThreadListV2ListItem[]) => {
      const row = items.find((item) => item.key === `v2-thread:${environmentId}:wake`);
      expect(row?.type).toBe("v2-thread");
      if (row?.type !== "v2-thread") throw new Error("missing snoozed row");
      return row;
    };
    expect(rows(earlier).snoozeWakeLabelText).toBe("2h");
    expect(rows(later).snoozeWakeLabelText).toBe("1h");
    expect(threadListV2ListItemsAreEqual(rows(earlier), rows(later))).toBe(false);
  });

  it("notices shelf count, expansion, and loading-disabled changes", () => {
    const shelf = {
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: 2,
      expanded: true,
      disabled: false,
      searchExpanded: false,
    } as const;
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf })).toBe(true);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, searchExpanded: true })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, count: 3 })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, expanded: false })).toBe(false);
    // A recycled cell ignores the render closure, so the shelf header's
    // preference-loading disabled state has to ride on the item too.
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, disabled: true })).toBe(false);
  });

  it("treats different item kinds as unequal", () => {
    const built = build();
    const threadItem = built.find((item) => item.type === "v2-thread")!;
    const pendingItem = built.find((item) => item.type === "v2-pending")!;
    expect(threadListV2ListItemsAreEqual(threadItem, pendingItem)).toBe(false);
  });

  it("notices a trailing-divider flip caused by a neighbour change", () => {
    const threadA = makeThread({ id: ThreadId.make("flip-a"), title: "flip a" });
    const threadB = makeThread({ id: ThreadId.make("flip-b"), title: "flip b" });
    const bare = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({
        threads: [threadA, threadB],
        searchQuery: "",
        now: NOW,
      }),
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    // The same shells with B snoozed: A now sits above the Snoozed shelf
    // rule instead of another row, so A's hairline must flip through the
    // recycled equality — its own shell reference never changed.
    const snoozedB = makeThread({
      id: ThreadId.make("flip-b"),
      title: "flip b",
      snoozedAt: NOW,
      snoozedUntil: isoAt(BASE_MS + 60 * MINUTE_MS),
    });
    const withSnoozed = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({
        threads: [threadA, snoozedB],
        searchQuery: "",
        now: NOW,
      }),
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    const firstA = bare[0]!;
    const secondA = withSnoozed[0]!;
    expect(firstA.type === "v2-thread" && firstA.showTrailingDivider).toBe(true);
    expect(secondA.type === "v2-thread" && secondA.showTrailingDivider).toBe(false);
    expect(threadListV2ListItemsAreEqual(firstA, secondA)).toBe(false);
  });
});

describe("buildThreadListV2ListItems clock scoping", () => {
  const allEnvironments = new Set<EnvironmentId>([environmentId]);
  const tickQueued = () => [makePendingTask("tick-queued")];

  it("carries the snooze menu clock on every row whose swipe menu offers presets", () => {
    const threads = buildTickThreads();
    const items = buildTickList(Object.values(threads), BASE_MS, tickQueued(), {
      snoozeEnvironmentIds: allEnvironments,
    });
    const byKey = itemsByThreadKey(items);
    const ready = byKey.get(`v2-thread:${environmentId}:tick-ready`)!;
    const approval = byKey.get(`v2-thread:${environmentId}:tick-approval`)!;
    const settled = byKey.get(`v2-thread:${environmentId}:tick-settled`)!;
    const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBe(NOW);
    // Settled rows offer the same snooze menu as every other row.
    expect(settled.type === "v2-thread" && settled.snoozePresetMinute).toBe(NOW);
    // Approval rows are never snoozable; snoozed rows only offer Wake.
    expect(approval.type === "v2-thread" && approval.snoozePresetMinute).toBeUndefined();
    expect(snoozed.type === "v2-thread" && snoozed.snoozePresetMinute).toBeUndefined();
  });

  it("keeps the snooze menu clock off rows on servers without the capability", () => {
    const threads = buildTickThreads();
    const items = buildTickList([threads.ready], BASE_MS, [], {
      snoozeEnvironmentIds: new Set<EnvironmentId>(),
    });
    const ready = items.find((item) => item.type === "v2-thread")!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBeUndefined();
  });

  it("blanks the precomputed time for rows that render a label instead", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const working = makeThread({
        id: ThreadId.make("tick-working"),
        title: "tick working",
        latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        runtime: runningRuntime(),
      });
      const threads = buildTickThreads();
      const items = buildTickList(
        [threads.ready, working, threads.settled, threads.snoozed],
        BASE_MS,
        tickQueued(),
      );
      const byKey = itemsByThreadKey(items);
      const label = (key: string) => {
        const item = byKey.get(key)!;
        return item.type === "v2-thread" ? item.timeLabel : "<shelf>";
      };
      // Ready rows draw their latest activity and settled rows the time they
      // settled, the stamp their shelf sorts by; the wake countdown outranks
      // the time on snoozed rows; rows with a status label never draw one.
      expect(label(`v2-thread:${environmentId}:tick-ready`)).toBe("5m");
      expect(label(`v2-thread:${environmentId}:tick-working`)).toBe("");
      expect(label(`v2-thread:${environmentId}:tick-settled`)).toBe("2d");
      expect(label(`v2-thread:${environmentId}:tick-snoozed`)).toBe("");
      const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
      expect(snoozed.type === "v2-thread" && snoozed.snoozeWakeLabelText).toBe("2h");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread list v2 minute tick invalidation", () => {
  it("only invalidates rows whose clock-driven content moved", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const threads = buildTickThreads();
      const shellOrder = [threads.ready, threads.approval, threads.settled, threads.snoozed];
      // One queued-task reference shared by both builds: the store hands the
      // list the same pending-task objects between rebuilds.
      const pendingTasks = [makePendingTask("tick-queued")];
      const atStart = buildTickList(shellOrder, BASE_MS, pendingTasks);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList(shellOrder, BASE_MS + MINUTE_MS, pendingTasks);

      expect(atStart.length).toBe(atNextMinute.length);
      const invalidated: string[] = [];
      for (let index = 0; index < atStart.length; index += 1) {
        if (!threadListV2ListItemsAreEqual(atStart[index]!, atNextMinute[index]!)) {
          invalidated.push(atStart[index]!.key);
        }
      }
      // The ready row draws a minute-granular time and carries the snooze
      // menu, and the settled row's snooze menu shows preset times too, so
      // both rows' menu content moved. Every other row — the approval row
      // (status label, never snoozable), the snoozed shelf row ("2h"
      // unchanged, Wake only), the shelf header, and the queued row —
      // survives the tick untouched.
      expect(invalidated).toEqual([
        `v2-thread:${environmentId}:tick-ready`,
        `v2-thread:${environmentId}:tick-settled`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the time beside the unread dot and moves it with the clock", () => {
    const unread = makeThread({
      id: ThreadId.make("tick-unread"),
      title: "Unread completion",
      lastVisitedAt: isoAt(BASE_MS - 10 * MINUTE_MS),
      latestRun: {
        runId: RunId.make("tick-unread-run"),
        status: "completed",
        requestedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        startedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        completedAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        assistantMessageId: null,
      },
    });
    const options = { snoozeEnvironmentIds: new Set<EnvironmentId>() };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const first = buildTickList([unread], BASE_MS, [], options)[0]!;
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const next = buildTickList([unread], BASE_MS + MINUTE_MS, [], options)[0]!;
      expect(threadHasUnseenCompletion(unread)).toBe(true);
      expect(first.type === "v2-thread" && first.timeLabel).toBe("5m");
      expect(next.type === "v2-thread" && next.timeLabel).toBe("6m");
      expect(threadListV2ListItemsAreEqual(first, next)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps hour-granularity rows stable across a minute tick when they carry no snooze menu", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const staleReady = makeThread({
        id: ThreadId.make("tick-stale"),
        title: "tick stale",
        latestUserMessageAt: isoAt(BASE_MS - 3 * 60 * MINUTE_MS),
      });
      const atStart = buildTickList([staleReady], BASE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([staleReady], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      expect(threadListV2ListItemsAreEqual(atStart[0]!, atNextMinute[0]!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders the snoozed countdown row when the wake label advances", () => {
    vi.useFakeTimers();
    try {
      const wakeAt = BASE_MS + 120 * MINUTE_MS;
      const snoozed = makeThread({
        id: ThreadId.make("tick-wake"),
        title: "tick wake",
        snoozedAt: isoAt(BASE_MS - MINUTE_MS),
        snoozedUntil: isoAt(wakeAt),
      });
      const wakeKey = `v2-thread:${environmentId}:tick-wake`;
      const wakeRow = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items).get(wakeKey)!;
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([snoozed], BASE_MS, []);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const stillTwoHours = buildTickList([snoozed], BASE_MS + MINUTE_MS, []);
      expect(threadListV2ListItemsAreEqual(wakeRow(atStart), wakeRow(stillTwoHours))).toBe(true);
      // Minutes round up, so the countdown holds "2h" until the remaining
      // time drops to the hour boundary — and only that row flips when it
      // finally moves to minute granularity.
      vi.setSystemTime(BASE_MS + 61 * MINUTE_MS);
      const oneHour = buildTickList([snoozed], BASE_MS + 61 * MINUTE_MS, []);
      const oneHourRow = wakeRow(oneHour);
      expect(oneHourRow.type).toBe("v2-thread");
      expect(oneHourRow.type === "v2-thread" && oneHourRow.snoozeWakeLabelText).toBe("59m");
      expect(threadListV2ListItemsAreEqual(wakeRow(stillTwoHours), wakeRow(oneHour))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildThreadListV2ListItems trailing dividers", () => {
  it("follows the final neighbour order, not the pre-splice blocks", () => {
    const working = makeThread({
      id: ThreadId.make("div-working"),
      title: "working",
      runtime: runningRuntime(),
    });
    const idle = makeThread({ id: ThreadId.make("div-idle"), title: "idle" });
    const snoozed = makeThread({
      id: ThreadId.make("div-snoozed"),
      title: "snoozed",
      snoozedAt: NOW,
      snoozedUntil: isoAt(BASE_MS + 60 * MINUTE_MS),
    });
    const items = buildThreadListV2ListItems({
      layout: buildThreadListV2Items({
        threads: [idle, snoozed, working],
        searchQuery: "",
        now: NOW,
      }),
      pendingTasks: [makePendingTask("div-q1")],
      snoozeLabelNow: NOW,
    });
    const dividers = items.map((item) =>
      item.type === "v2-thread" || item.type === "v2-pending" ? item.showTrailingDivider : "n/a",
    );
    // working | queued | idle | Snoozed shelf: rows divide each other, and
    // the row above the shelf rule loses its own hairline.
    expect(dividers).toEqual([true, true, false, "n/a"]);
  });
});

describe("buildThreadListV2ListItems row-state stamps", () => {
  const readyThread = makeThread({
    id: ThreadId.make("stamp-ready"),
    title: "stamp ready",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const settledThread = makeThread({
    id: ThreadId.make("stamp-settled"),
    title: "stamp settled",
    settledOverride: "settled",
    settledAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
  });
  const allEnvironments = new Set<EnvironmentId>([environmentId]);

  it("stamps queued outbox messages onto the matching row and notices removal", () => {
    // An outbox write never touches the thread shell, so the queued icon has
    // to ride on the item for the recycled cell to ever update it.
    const queued = buildTickList([readyThread, settledThread], BASE_MS, [], {
      queuedThreadKeys: new Set([`${environmentId}:stamp-ready`]),
      snoozeEnvironmentIds: allEnvironments,
    });
    const plain = buildTickList([readyThread, settledThread], BASE_MS, [], {
      queuedThreadKeys: new Set<string>(),
      snoozeEnvironmentIds: allEnvironments,
    });
    const byKey = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items);
    const readyQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const settledQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-settled`)!;
    const settledPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-settled`)!;
    expect(readyQueued.type === "v2-thread" && readyQueued.hasQueuedMessages).toBe(true);
    expect(readyPlain.type === "v2-thread" && readyPlain.hasQueuedMessages).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyQueued, readyPlain)).toBe(false);
    // The neighbour row is untouched by the outbox change.
    expect(threadListV2ListItemsAreEqual(settledQueued, settledPlain)).toBe(true);
  });

  it("notices move-availability changes without a shell update", () => {
    const permissive = new Map([
      [`${environmentId}:stamp-ready`, { canMoveUp: true, canMoveDown: true }],
      [`${environmentId}:stamp-settled`, { canMoveUp: true, canMoveDown: true }],
    ]);
    const blocked = new Map([
      [`${environmentId}:stamp-settled`, { canMoveUp: true, canMoveDown: true }],
    ]);
    const open = buildTickList([readyThread, settledThread], BASE_MS, [], {
      moveAvailability: permissive,
      snoozeEnvironmentIds: allEnvironments,
    });
    const closed = buildTickList([readyThread, settledThread], BASE_MS, [], {
      moveAvailability: blocked,
      snoozeEnvironmentIds: allEnvironments,
    });
    const readyOpen = itemsByThreadKey(open).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyClosed = itemsByThreadKey(closed).get(`v2-thread:${environmentId}:stamp-ready`)!;
    expect(readyOpen.type === "v2-thread" && readyOpen.canMoveUp).toBe(true);
    expect(readyClosed.type === "v2-thread" && readyClosed.canMoveUp).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyOpen, readyClosed)).toBe(false);
    // The neighbour row's availability did not move, so its cell survives.
    const settledOpen = itemsByThreadKey(open).get(`v2-thread:${environmentId}:stamp-settled`)!;
    const settledClosed = itemsByThreadKey(closed).get(`v2-thread:${environmentId}:stamp-settled`)!;
    expect(settledOpen.type === "v2-thread" && settledOpen.canMoveUp).toBe(true);
    expect(threadListV2ListItemsAreEqual(settledOpen, settledClosed)).toBe(true);
  });

  it("keeps a settled row's snooze menu fresh across a tick", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([settledThread], BASE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([settledThread], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      const rowAtStart = atStart.find((item) => item.type === "v2-thread")!;
      const rowAtNext = atNextMinute.find((item) => item.type === "v2-thread")!;
      // The swipe-revealed secondary action carries the snooze preset menu;
      // its minute clock must move, or the displayed wake times drift while
      // the row is recycled-stable.
      expect(rowAtStart.type === "v2-thread" && rowAtStart.snoozePresetMinute).toBe(isoAt(BASE_MS));
      expect(rowAtNext.type === "v2-thread" && rowAtNext.snoozePresetMinute).toBe(
        isoAt(BASE_MS + MINUTE_MS),
      );
      expect(threadListV2ListItemsAreEqual(rowAtStart, rowAtNext)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the shelf loading-disabled state so recycled headers refresh", () => {
    const snoozedThread = makeThread({
      id: ThreadId.make("stamp-snoozed"),
      title: "stamp snoozed",
      snoozedAt: isoAt(BASE_MS - MINUTE_MS),
      snoozedUntil: isoAt(BASE_MS + 60 * MINUTE_MS),
    });
    const loading = buildTickList([snoozedThread], BASE_MS, [], {
      shelfPreferencesLoading: true,
      snoozeEnvironmentIds: allEnvironments,
    });
    const loaded = buildTickList([snoozedThread], BASE_MS, [], {
      shelfPreferencesLoading: false,
      snoozeEnvironmentIds: allEnvironments,
    });
    const shelfLoading = loading.find((item) => item.type === "v2-snoozed-shelf")!;
    const shelfLoaded = loaded.find((item) => item.type === "v2-snoozed-shelf")!;
    expect(shelfLoading.type === "v2-snoozed-shelf" && shelfLoading.disabled).toBe(true);
    expect(shelfLoaded.type === "v2-snoozed-shelf" && shelfLoaded.disabled).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelfLoading, shelfLoaded)).toBe(false);
  });
});

describe("restored settled history", () => {
  const settled = makeThread({
    id: ThreadId.make("history"),
    title: "Old idea",
    settledOverride: "settled",
    settledAt: NOW,
  });
  const active = makeThread({ id: ThreadId.make("current"), title: "Current idea" });
  const build = (extra: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {}) =>
    buildThreadListV2Items({ threads: [active, settled], searchQuery: "", now: NOW, ...extra });

  it("collapses history without losing its count or treating it as archived", () => {
    const layout = build();
    expect(layout.items.map((item) => item.thread.id)).toEqual(["current"]);
    expect(layout.settledCount).toBe(1);
    expect(
      buildThreadListV2ListItems({ layout, pendingTasks: [] }).map((item) => item.type),
    ).toEqual(["v2-thread", "v2-settled-shelf"]);
  });

  it("reveals history on expansion and searches it while collapsed", () => {
    expect(build({ settledShelfExpanded: true }).items.map((item) => item.thread.id)).toEqual([
      "current",
      "history",
    ]);
    expect(build({ searchQuery: "Old idea" }).items.map((item) => item.thread.id)).toEqual([
      "history",
    ]);
  });

  it("lists search results without the settled shelf, which returns as a toggle after", () => {
    const searching = build({ searchQuery: "idea" });
    const searchItems = buildThreadListV2ListItems({ layout: searching, pendingTasks: [] });
    // A search is one ranked list: settled matches are rows in it, under no shelf header.
    expect(searchItems.some((item) => item.type === "v2-settled-shelf")).toBe(false);

    const expandedByUser = buildThreadListV2ListItems({
      layout: build({ settledShelfExpanded: true }),
      pendingTasks: [],
      settledShelfExpanded: true,
    }).find((item) => item.type === "v2-settled-shelf")!;
    expect(expandedByUser.type === "v2-settled-shelf" && expandedByUser.searchExpanded).toBe(false);
  });

  it("shows snoozed matches while a search is active, as it does settled ones", () => {
    const snoozed = makeThread({
      id: ThreadId.make("login-fix"),
      title: "Fix login",
      snoozedUntil: "2026-06-03T10:00:00.000Z",
      snoozedAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [active, snoozed],
      searchQuery: "login",
      now: NOW,
    });
    expect(layout.items.map((item) => item.thread.id)).toEqual(["login-fix"]);
    expect(layout.items[0]).toMatchObject({ snoozed: true });
    // One ranked list while searching: no shelf header between the matches.
    const shelf = buildThreadListV2ListItems({ layout, pendingTasks: [] }).find(
      (item) => item.type === "v2-snoozed-shelf",
    );
    expect(shelf).toBeUndefined();
  });

  it("gives a row a fresh swipe layer when it moves between the list and the open shelf", () => {
    const resetKeyOf = (layout: ReturnType<typeof build>) => {
      const row = buildThreadListV2ListItems({ layout, pendingTasks: [] }).find(
        (item) => item.type === "v2-thread" && item.item.thread.id === "history",
      );
      if (row?.type !== "v2-thread") throw new Error("missing history row");
      return {
        key: row.key,
        resetKey: threadListV2SwipeResetKey({
          thread: row.item.thread,
          snoozed: row.item.snoozed,
          settled: row.item.settled === true,
        }),
      };
    };
    const onShelf = resetKeyOf(build({ settledShelfExpanded: true }));
    const unsettled = resetKeyOf(
      build({
        settledShelfExpanded: true,
        threads: [active, { ...settled, settledOverride: "active", unsettledAt: NOW }],
      }),
    );
    // The list keeps the row's item key, so only the swipe key can drop the
    // collapsed state left behind by the settle/unsettle exit.
    expect(unsettled.key).toBe(onShelf.key);
    expect(unsettled.resetKey).not.toBe(onShelf.resetKey);
  });

  it("brings an un-settled thread back at the top and labels settled rows by when they settled", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(NOW));
      const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
      const recent = makeThread({
        id: ThreadId.make("recent"),
        title: "Recent",
        createdAt: daysAgo(2),
        latestUserMessageAt: daysAgo(1),
      });
      const revived = makeThread({
        id: ThreadId.make("revived"),
        title: "Revived",
        createdAt: daysAgo(12),
        latestUserMessageAt: daysAgo(10),
        settledOverride: "active",
        unsettledAt: NOW,
      });
      const shelved = makeThread({
        id: ThreadId.make("shelved"),
        title: "Shelved",
        createdAt: daysAgo(20),
        latestUserMessageAt: daysAgo(14),
        settledOverride: "settled",
        settledAt: daysAgo(3),
      });
      const layout = buildThreadListV2Items({
        threads: [recent, revived, shelved],
        searchQuery: "",
        now: NOW,
        settledShelfExpanded: true,
      });
      expect(layout.items.map((item) => item.thread.id)).toEqual(["revived", "recent", "shelved"]);
      const labels = buildThreadListV2ListItems({ layout, pendingTasks: [] }).flatMap((item) =>
        item.type === "v2-thread" ? [[item.item.thread.id, item.timeLabel]] : [],
      );
      expect(labels).toEqual([
        ["revived", "<1m"],
        ["recent", "1d"],
        ["shelved", "3d"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps live work and queued messages out of settled history", () => {
    const working = { ...settled, runtime: RUNNING };
    expect(build({ threads: [working] }).items.map((item) => item.thread.id)).toEqual(["history"]);
    const queued = build({ queuedThreadKeys: new Set([`${environmentId}:history`]) });
    expect(queued.items.map((item) => item.thread.id)).toContain("history");
    expect(queued.settledCount).toBe(0);
  });

  it("does not hide history behind controls an older server cannot support", () => {
    const layout = build({ settlementEnvironmentIds: new Set() });
    expect(layout.items.map((item) => item.thread.id)).toContain("history");
    expect(layout.settledCount).toBe(0);
  });

  it("returns an un-settled thread to the main list", () => {
    const layout = build({ threads: [{ ...settled, settledOverride: null }] });
    expect(layout.items.map((item) => item.thread.id)).toEqual(["history"]);
    expect(layout.settledCount).toBe(0);
  });

  it("uses settle and un-settle swipes with the legacy archive fallback", () => {
    const input = { snoozeSupported: false, snoozable: true };
    expect(resolveThreadListV2SwipeActions({ ...input, settlementSupported: true }).primary).toBe(
      "settle",
    );
    expect(
      resolveThreadListV2SwipeActions({ ...input, settlementSupported: true, settled: true })
        .primary,
    ).toBe("unsettle");
    expect(resolveThreadListV2SwipeActions(input).primary).toBe("archive");
  });
});

describe("multi-day chats", () => {
  const multiDayActivity = { activityDayCount: 3, activityLastAt: NOW };

  it("groups chats by their current status regardless of how long they have been active", () => {
    const pinned = makeThread({ id: ThreadId.make("pinned"), title: "Pinned", pinnedAt: NOW });
    const asking = makeThread({
      id: ThreadId.make("asking"),
      title: "Asking",
      hasPendingApprovals: true,
      ...multiDayActivity,
    });
    const working = makeThread({
      id: ThreadId.make("working"),
      title: "Working",
      runtime: RUNNING,
      ...multiDayActivity,
    });
    const resting = makeThread({
      id: ThreadId.make("resting"),
      title: "Resting",
      latestUserMessageAt: "2026-06-01T00:00:00.000Z",
      ...multiDayActivity,
    });
    const recent = makeThread({
      id: ThreadId.make("recent"),
      title: "Recent",
      latestUserMessageAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [resting, recent, working, asking, pinned],
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "pinned",
      "asking",
      "working",
      "recent",
      "resting",
    ]);
    expect(layout.pendingTasksIndex).toBe(3);

    const rows = buildThreadListV2ListItems({ layout, pendingTasks: [] });
    expect(rows.map((item) => item.type)).toEqual(Array(5).fill("v2-thread"));
    const workingRow = rows.find(
      (item) => item.type === "v2-thread" && item.item.thread === working,
    );
    expect(workingRow).toMatchObject({ timeLabel: "" });
  });

  it.each([false, true])("shows outstanding work on a row with pinned set to %s", (pinned) => {
    const placement = pinned ? { pinnedAt: NOW } : {};
    const watching = makeThread({
      id: ThreadId.make("watching"),
      title: "Watching",
      pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
      ...placement,
      ...multiDayActivity,
    });
    const delegating = makeThread({
      id: ThreadId.make("delegating"),
      title: "Delegating",
      longRunningWork: { monitorCount: 1, backgroundTaskCount: 0, runningSubagentCount: 2 },
      ...placement,
      ...multiDayActivity,
    });
    const layout = buildThreadListV2Items({
      threads: [watching, delegating],
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.find((item) => item.thread === watching)).toMatchObject({
      pinned,
      longRunningStatus: "Waiting on 1 monitor",
    });
    expect(layout.items.find((item) => item.thread === delegating)).toMatchObject({
      pinned,
      longRunningStatus: "2 subagents running",
    });
  });

  it("shows a native timer and its background commands on the waiting row", () => {
    const runId = RunId.make("antigravity-run-51");
    const thread = presentThreadShell(
      environmentId,
      makeRawThreadShell({
        id: ThreadId.make("timer-thread"),
        title: "Rollouts",
        status: "running",
        latestRunId: runId,
        activeRunId: runId,
        activityRunStatus: "running",
        pendingBackgroundTasks: [
          {
            taskId: "timer",
            kind: "background_task",
            description: "Set timer",
            wakeAt: "2026-11-25T06:00:52.935Z",
          },
          {
            taskId: "rollouts",
            kind: "command",
            description: "Run teacher rollouts on Modal",
            wakesAgent: true,
          },
        ],
      }),
    );
    const options = { searchQuery: "", now: NOW };
    const waiting = buildThreadListV2Items({ ...options, threads: [thread] });
    expect(waiting.items[0]?.longRunningStatus).toBe("Waiting on 1 timer and 1 command");
  });
});

describe("connection-aware thread status", () => {
  it("shows connection state for cached work while keeping requests and failures visible", () => {
    expect(resolveThreadListV2DisplayStatus("working", "reconnecting")).toBe("reconnecting");
    expect(resolveThreadListV2DisplayStatus("working", "connecting")).toBe("connecting");
    expect(resolveThreadListV2DisplayStatus("waiting", "offline")).toBe("offline");
    expect(resolveThreadListV2DisplayStatus("working", "connected")).toBe("working");
    expect(resolveThreadListV2DisplayStatus("approval", "offline")).toBe("approval");
    expect(resolveThreadListV2DisplayStatus("failed", "offline")).toBe("failed");
    expect(resolveThreadListV2DisplayStatus("ready", "reconnecting", "Working 2m")).toBe(
      "reconnecting",
    );
    expect(resolveThreadListV2DisplayStatus("ready", "offline", "1 monitor running")).toBe(
      "offline",
    );
  });
});

it("renders ranked content matches separately from local title rows, including archived chats", () => {
  const title = makeThread({ id: ThreadId.make("title"), title: "Battery issue" });
  const recent = makeThread({ id: ThreadId.make("recent"), title: "Recent discussion" });
  const best = makeThread({ id: ThreadId.make("best"), title: "Earlier discussion" });
  const archived = makeThread({
    id: ThreadId.make("archived"),
    title: "Battery notes",
    archivedAt: NOW,
  });
  const matches = [best, recent, title, archived].map((thread) => ({
    environmentId,
    threadId: thread.id,
    projectId: thread.projectId,
    source: "assistant" as const,
    snippet: "The computer loses charge overnight",
    messageCreatedAt: NOW,
  }));
  expect(
    rankedContentSearchMatches([recent, title, best, archived], matches, "battery").map(
      (match) => match.threadId,
    ),
    // The archived chat is named by the search ("Battery notes"), so it leads the chats
    // that only mention a battery; those keep the server's order.
  ).toEqual(["archived", "best", "recent"]);
});

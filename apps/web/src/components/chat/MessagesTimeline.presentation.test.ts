import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  decorateMessagesTimelineRows,
  discordMessageTimestamp,
  timelineDayLabel,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

function message(
  id: string,
  createdAt: string,
  role: "assistant" | "user" = "assistant",
  run = "claude",
): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      createdAt,
      updatedAt: createdAt,
      runId: RunId.make(run),
      streaming: false,
    },
    durationStart: createdAt,
    showAssistantMeta: true,
    showAssistantCopyButton: true,
    assistantCopyStreaming: false,
  };
}
const now = new Date(2026, 9, 25, 16);
const stamp = (day: number, hour = 15, minute = 0) =>
  new Date(2026, 9, day, hour, minute).toISOString();
const options = { now, discord: true, lastVisitedAt: null, openedAt: stamp(25, 16) };

describe("cozy message grouping", () => {
  it("groups consecutive same-author messages until the seven-minute boundary", () => {
    const rows = decorateMessagesTimelineRows(
      [
        message("a", stamp(25)),
        message("b", stamp(25, 15, 6)),
        message("c", stamp(25, 15, 13)),
        message("d", stamp(25, 15, 14), "user"),
        message("e", stamp(25, 15, 15)),
      ],
      options,
    );
    expect(rows.map((row) => row.groupedMessage)).toEqual([false, true, false, false, false]);
  });
  it("uses provider identity across runs and separates a handoff", () => {
    const rows = decorateMessagesTimelineRows(
      [
        message("a", stamp(25), "assistant", "run1"),
        message("b", stamp(25, 15, 1), "assistant", "run2"),
        message("c", stamp(25, 15, 2), "assistant", "run3"),
      ],
      {
        ...options,
        providerByRunId: new Map([
          ["run1", "claude"],
          ["run2", "claude"],
          ["run3", "codex"],
        ]),
      },
    );
    expect(rows.map((row) => row.groupedMessage)).toEqual([false, true, false]);
  });
  it("breaks groups across system rows, local days and the unread boundary", () => {
    const rows = decorateMessagesTimelineRows(
      [
        message("a", stamp(24, 23, 59)),
        message("b", stamp(25, 0, 1)),
        {
          kind: "context-compaction",
          id: "compact",
          createdAt: stamp(25, 0, 2),
          label: "Compacted context",
          active: false,
        },
        message("c", stamp(25, 0, 3)),
        message("d", stamp(25, 0, 4)),
      ],
      { ...options, lastVisitedAt: stamp(25, 0, 3) },
    );
    expect(rows.map((row) => row.groupedMessage)).toEqual([false, false, false, false, false]);
    expect(rows.at(-1)?.unreadDivider).toBe(true);
  });
  it("groups the same user across devices", () => {
    const first = message("web", stamp(25), "user");
    const second = message("phone", stamp(25, 15, 1), "user");
    if (first.kind !== "message" || second.kind !== "message") throw new Error("Expected messages");
    first.message = { ...first.message, createdBy: "user", creationSource: "web" };
    second.message = { ...second.message, createdBy: "user", creationSource: "mobile" };
    expect(decorateMessagesTimelineRows([first, second], options)[1]?.groupedMessage).toBe(true);
  });
  it("gives agent work the agent's header and keeps its reply in that group", () => {
    const work = (id: string, createdAt: string, run = "claude"): MessagesTimelineRow => ({
      kind: "work",
      id,
      createdAt,
      isExpandedToolGroup: false,
      groupedEntries: [{ id, createdAt, tone: "tool", label: "Read file", runId: RunId.make(run) }],
    });
    const rows = decorateMessagesTimelineRows(
      [
        message("ask", stamp(25), "user"),
        work("read", stamp(25, 15, 1)),
        message("reply", stamp(25, 15, 2)),
        work("again", stamp(25, 15, 3)),
        message("later", stamp(25, 15, 20), "user"),
        work("slow", stamp(25, 15, 21)),
        message("done", stamp(25, 15, 40)),
      ],
      options,
    );
    expect(rows.map((row) => [row.startsAgentGroup ?? false, row.groupedMessage])).toEqual([
      [false, false],
      [true, false],
      [false, true],
      [false, false],
      [false, false],
      [true, false],
      [false, false],
    ]);
    expect(
      decorateMessagesTimelineRows(
        [message("ask", stamp(25), "user"), work("read", stamp(25, 15, 1))],
        { ...options, discord: false },
      )[1]?.startsAgentGroup,
    ).toBeUndefined();
  });
  it("keeps the tool disclosure reachable when reasoning follows a tool", () => {
    const tool = {
      id: "tool",
      createdAt: stamp(25),
      tone: "tool" as const,
      label: "Read file",
      itemType: "dynamic_tool" as const,
    };
    const thought = {
      id: "thought",
      createdAt: stamp(25),
      tone: "thinking" as const,
      label: "Private reasoning",
      itemType: "reasoning" as const,
      detail: "Never display this text",
    };
    const row: MessagesTimelineRow = {
      kind: "work-live",
      id: "live",
      createdAt: stamp(25),
      entry: thought,
      groupedEntries: [tool, thought],
      groupId: "group",
      expanded: false,
      active: true,
    };
    const result = decorateMessagesTimelineRows([row], options)[0];
    expect(result?.kind).toBe("work-live");
    if (result?.kind !== "work-live") throw new Error("Expected tool disclosure");
    expect(result.entry).toBe(tool);
    expect(result.groupId).toBe("group");
    expect(
      decorateMessagesTimelineRows([{ ...row, groupedEntries: [thought] }], options),
    ).toMatchObject([{ kind: "thinking", id: "live" }]);
    expect(
      decorateMessagesTimelineRows([{ ...row, active: false, groupedEntries: [thought] }], options),
    ).toEqual([]);
    expect(decorateMessagesTimelineRows([row], { ...options, discord: false })[0]).toMatchObject({
      entry: thought,
    });
    expect(
      decorateMessagesTimelineRows([row], { ...options, discord: false, casualVoice: true })[0],
    ).toMatchObject({
      entry: thought,
    });
  });
});

describe("timeline dividers", () => {
  it("omits an initial Today divider and adds local-day changes in both modes", () => {
    for (const discord of [false, true]) {
      expect(
        decorateMessagesTimelineRows([message("a", stamp(25))], { ...options, discord })[0]
          ?.dayDivider,
      ).toBeUndefined();
      expect(
        decorateMessagesTimelineRows([message("a", stamp(24)), message("b", stamp(25))], {
          ...options,
          discord,
        }).map((row) => row.dayDivider),
      ).toEqual(["Yesterday", "Today"]);
    }
  });
  it("keeps a reply under its turn header when the turn runs past midnight", () => {
    const fold: MessagesTimelineRow = {
      kind: "turn-fold",
      id: "fold",
      createdAt: stamp(24, 23, 58),
      runId: RunId.make("claude"),
      label: "Worked for 4m",
      expanded: false,
    };
    const rows = decorateMessagesTimelineRows(
      [
        message("ask", stamp(24, 23, 57), "user"),
        fold,
        message("reply", stamp(25, 0, 2)),
        message("next", stamp(25, 9), "user", "later"),
      ],
      { ...options, discord: false },
    );
    expect(rows.map((row) => row.dayDivider)).toEqual(["Yesterday", undefined, undefined, "Today"]);
  });
  it("marks only the first unseen message that existed when the chat opened", () => {
    const rows = [
      message("a", stamp(25, 14)),
      message("b", stamp(25)),
      message("c", stamp(25, 15, 1)),
      message("live", stamp(25, 17)),
    ];
    const decorated = decorateMessagesTimelineRows(rows, {
      ...options,
      lastVisitedAt: stamp(25, 14),
    });
    expect(decorated.filter((row) => row.unreadDivider).map((row) => row.id)).toEqual(["b"]);
    expect(
      decorateMessagesTimelineRows(rows.slice(-1), { ...options, lastVisitedAt: stamp(25, 14) })[0]
        ?.unreadDivider,
    ).toBe(false);
  });
  it("keeps the unread marker on a folded run until its messages are expanded", () => {
    const unseen = message("unseen", stamp(25), "assistant", "earlier");
    if (unseen.kind !== "message") throw new Error("Expected message");
    const fold: MessagesTimelineRow = {
      kind: "turn-fold",
      id: "fold",
      createdAt: stamp(25, 14),
      runId: RunId.make("earlier"),
      label: "Earlier turn",
      expanded: false,
    };
    const timelineEntries = [
      {
        kind: "message" as const,
        id: unseen.id,
        createdAt: unseen.createdAt,
        message: unseen.message,
      },
    ];
    const opts = { ...options, lastVisitedAt: stamp(25, 14, 30), timelineEntries };
    expect(
      decorateMessagesTimelineRows([fold, message("later", stamp(25, 15, 1))], opts)
        .filter((row) => row.unreadDivider)
        .map((row) => row.id),
    ).toEqual(["fold"]);
    expect(
      decorateMessagesTimelineRows([{ ...fold, expanded: true }, unseen], opts)
        .filter((row) => row.unreadDivider)
        .map((row) => row.id),
    ).toEqual(["unseen"]);
  });
  it("hides unread for new chats, seen history and invalid watermarks", () => {
    for (const lastVisitedAt of [null, "invalid", stamp(25, 16)]) {
      expect(
        decorateMessagesTimelineRows([message("a", stamp(25))], { ...options, lastVisitedAt })[0]
          ?.unreadDivider,
      ).toBe(false);
    }
  });
  it("formats dates with a year only outside the current year", () => {
    expect(timelineDayLabel(new Date(2025, 9, 22).toISOString(), now)).toContain("2025");
    expect(timelineDayLabel(stamp(22), now)).not.toContain("2026");
    expect(discordMessageTimestamp(stamp(25), now)).toContain("Today at");
    expect(discordMessageTimestamp(stamp(24), now)).toContain("Yesterday at");
    expect(timelineDayLabel("invalid", now)).toBe("");
  });
  it("keeps row references through stream updates but invalidates changed presentation", () => {
    const source = [message("a", stamp(24)), message("b", stamp(25))];
    const first = computeStableMessagesTimelineRows(decorateMessagesTimelineRows(source, options), {
      byId: new Map(),
      result: [],
    });
    const stable = computeStableMessagesTimelineRows(
      decorateMessagesTimelineRows(source, options),
      first,
    );
    expect(stable).toBe(first);
    const unread = computeStableMessagesTimelineRows(
      decorateMessagesTimelineRows(source, { ...options, lastVisitedAt: stamp(24) }),
      first,
    );
    expect(unread.result[0]).toBe(first.result[0]);
    expect(unread.result[1]).not.toBe(first.result[1]);
  });
  it("keeps the thinking status in both modes while Discord hides the working header", () => {
    const rows: MessagesTimelineRow[] = [
      { kind: "thinking", id: "thought", createdAt: stamp(25) },
      { kind: "working", id: "working", createdAt: stamp(25) },
      message("a", stamp(25)),
    ];
    expect(decorateMessagesTimelineRows(rows, options).map((row) => row.id)).toEqual([
      "thought",
      "a",
    ]);
    expect(decorateMessagesTimelineRows(rows, { ...options, discord: false })).toHaveLength(3);
  });
});

it("inserts a closed reasoning reply after its steer only when casual voice is on", () => {
  const at = DateTime.makeUnsafe(stamp(25));
  const base = {
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    status: "completed" as const,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const steer: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make("steer-item"),
    ordinal: 1,
    type: "user_message",
    messageId: MessageId.make("steer"),
    inputIntent: "steer",
    text: "Check the earlier result.",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  };
  const thought: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make("thought"),
    ordinal: 2,
    type: "reasoning",
    text: "The earlier result still applies.",
    streaming: false,
  };
  const project = (item: OrchestrationV2TurnItem) => ({
    item,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    position: item.ordinal,
    visibility: "local" as const,
  });
  const messageRow = message("steer", stamp(25), "user", "run");
  if (messageRow.kind !== "message") throw new Error("Expected message row");
  const row = { ...messageRow, projectedItem: project(steer) };
  const timelineEntries = [
    {
      kind: "message" as const,
      id: row.id,
      createdAt: stamp(25),
      message: row.message,
      projectedItem: project(steer),
    },
    {
      kind: "work" as const,
      id: "thought",
      createdAt: stamp(25),
      entry: {
        id: "thought",
        createdAt: stamp(25),
        tone: "thinking" as const,
        label: thought.text,
        itemType: "reasoning" as const,
        projectedItem: project(thought),
      },
    },
  ];
  const common = { ...options, timelineEntries, runs: [{ id: base.runId, status: "completed" }] };
  expect(
    decorateMessagesTimelineRows(
      [row, message("answer", stamp(25), "assistant", "run")],
      common,
    ).map((entry) => entry.kind),
  ).toEqual(["message", "message"]);
  expect(
    decorateMessagesTimelineRows([row], { ...common, discord: false }).map((entry) => entry.kind),
  ).toEqual(["message"]);
  expect(
    decorateMessagesTimelineRows([row, message("answer", stamp(25), "assistant", "run")], {
      ...common,
      discord: false,
      casualVoice: true,
    }).map((entry) => entry.kind),
  ).toEqual(["message", "steer-reply", "message"]);
  expect(
    decorateMessagesTimelineRows([row, message("answer", stamp(25), "assistant", "run")], {
      ...common,
      discord: true,
      casualVoice: true,
    }).map((entry) => entry.kind),
  ).toEqual(["message", "steer-reply", "message"]);
  expect(
    decorateMessagesTimelineRows([row], { ...common, discord: true, casualVoice: false }).map(
      (entry) => entry.kind,
    ),
  ).toEqual(["message"]);
  expect(
    decorateMessagesTimelineRows([row], {
      ...common,
      casualVoice: true,
      runs: [{ id: base.runId, status: "running" }],
    }).map((entry) => entry.kind),
  ).toEqual(["message"]);
});

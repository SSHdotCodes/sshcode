import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveMessagesTimelineRows,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      // Thoughts stay in the transcript, not on the live status line.
      expect(live?.thought).toBeUndefined();
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});

describe("live thoughts", () => {
  it("shows a thought streaming live above the status line", () => {
    const runId = RunId.make("live-thought-run");
    const createdAt = "2026-10-26T00:00:00Z";
    const thought = {
      id: "thought-1",
      createdAt,
      runId,
      label: "Thinking",
      tone: "thinking" as const,
      itemType: "reasoning" as const,
      detail: "Let me think about the metric first.\n\nThe horizon sits at r = 2M.",
      toolLifecycleStatus: "inProgress" as const,
      liveThought: true,
    };
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        { id: "entry-thought-1", kind: "work" as const, createdAt, entry: thought },
      ],
      isWorking: true,
      runningRunId: runId,
      activeTurnStartedAt: createdAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      expandedWorkGroupIds: new Set(),
    });
    const live = rows.find((row) => row.kind === "work-live");
    expect(live?.entry.id).toBe("thought-1");
    expect(live?.thought?.id).toBe("thought-1");
  });
});

describe("running tool status line", () => {
  const runId = RunId.make("running-tool-run");
  const createdAt = "2026-11-24T20:00:00Z";
  const search = (id: string, running: boolean) => ({
    id: `entry-${id}`,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      createdAt,
      runId,
      label: "Run command",
      command: id,
      tone: "tool" as const,
      itemType: "command_execution" as const,
      toolLifecycleStatus: running ? ("inProgress" as const) : ("completed" as const),
    },
  });
  const card = {
    id: "card-entry",
    kind: "event" as const,
    createdAt: "2026-11-24T20:00:01Z",
    projectedItem: { item: { type: "thread_created" } } as never,
  };
  const statusLine = (timelineEntries: ReadonlyArray<unknown>) =>
    deriveMessagesTimelineRows({
      timelineEntries: timelineEntries as never,
      isWorking: true,
      runningRunId: runId,
      activeTurnStartedAt: createdAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      expandedWorkGroupIds: new Set(),
    }).find((row) => row.id === "live-activity-row");

  it("doesn't repeat a running tool its own row already names above a card", () => {
    expect(statusLine([search("ssh", true), card])).toBeUndefined();
  });
});

describe("liveWorkEntryLabel for a command execution without a command", () => {
  it.each([
    {
      status: "inProgress" as const,
      active: true,
      toolTitle: "Ran command",
      expected: "Running command",
    },
    {
      status: "inProgress" as const,
      active: true,
      toolTitle: "Command",
      expected: "Running command",
    },
    {
      status: "failed" as const,
      active: false,
      toolTitle: "Ran command",
      expected: "Failed command",
    },
    {
      status: "failed" as const,
      active: false,
      toolTitle: "Run command",
      expected: "Failed command",
    },
  ])(
    "labels a $status entry titled $toolTitle as $expected",
    ({ status, active, toolTitle, expected }) => {
      const entry = {
        id: "work-empty-command",
        createdAt: "2026-10-12T00:00:00Z",
        label: "Ran command",
        toolTitle,
        tone: "tool" as const,
        itemType: "command_execution" as const,
        command: "",
        toolLifecycleStatus: status,
      };
      expect(liveWorkEntryLabel(entry, undefined, active)).toBe(expected);
      expect(workEntryDisplayLabel(entry, undefined)).toBe(expected);
    },
  );
});

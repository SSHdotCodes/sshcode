// @vitest-environment jsdom
import {
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as DateTime from "effect/DateTime";
import { act, memo, useLayoutEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  v2Now,
  v2Projection,
  v2ThreadId,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { buildThreadFeed, type ThreadFeedLatestRun } from "../../lib/threadActivity";
import {
  createStableThreadFeedProjector,
  createThreadFeedPresentationProjector,
  createThreadFeedProjector,
  threadFeedFailedRunIds,
  threadFeedSummary,
} from "../../lib/threadFeedProjection";
import type { PendingThreadFeedEntry } from "../../state/pending-thread-feed";
import { createTimelineDecorationsProjector } from "../discord/timelinePresentation";
import {
  createThreadFeedRowStore,
  useThreadFeedRowVolatileSlice,
  userMessageExpansionKey,
  type ThreadFeedRowStore,
  type ThreadFeedRowStoreState,
} from "./thread-feed-row-store";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function makeSyntheticConversation(): OrchestrationV2ThreadProjection {
  const baseEpoch = DateTime.toEpochMillis(v2Now);
  const stamp = (seconds: number) => DateTime.makeUnsafe(baseEpoch + seconds * 1000);
  const run1 = RunId.make("run-1");
  const run2 = RunId.make("run-2");
  const run3 = RunId.make("run-3");

  const common = (
    id: string,
    runId: RunId,
    ordinal: number,
    seconds: number,
    completed = true,
  ) => ({
    id: TurnItemId.make(id),
    threadId: v2ThreadId,
    runId,
    nodeId: null,
    parentItemId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: null,
    startedAt: stamp(seconds),
    updatedAt: stamp(seconds),
    completedAt: completed ? stamp(seconds) : null,
  });

  const items: Array<OrchestrationV2TurnItem> = [
    {
      ...common("u-1", run1, 1, 1),
      type: "user_message",
      messageId: MessageId.make("m-u-1"),
      text: "First prompt",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mobile",
    },
    {
      ...common("t-1", run1, 2, 2),
      type: "command_execution",
      input: "git status",
      output: "ok",
      exitCode: 0,
    },
    {
      ...common("a-1", run1, 3, 3),
      type: "assistant_message",
      messageId: MessageId.make("m-a-1"),
      text: "First reply",
      streaming: false,
      attachments: [],
    },
    {
      ...common("u-2", run2, 4, 4),
      type: "user_message",
      messageId: MessageId.make("m-u-2"),
      text: "Second prompt",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mobile",
    },
    {
      ...common("t-2", run2, 5, 5),
      type: "command_execution",
      input: "ls",
      output: "done",
      exitCode: 0,
    },
    {
      ...common("a-2", run2, 6, 6),
      type: "assistant_message",
      messageId: MessageId.make("m-a-2"),
      text: "Second reply",
      streaming: false,
      attachments: [],
    },
    {
      ...common("u-3", run3, 7, 7),
      type: "user_message",
      messageId: MessageId.make("m-u-3"),
      text: "Active prompt",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mobile",
    },
    {
      ...common("t-3", run3, 8, 8, false),
      type: "command_execution",
      input: "pnpm test",
      output: "running...",
    },
    {
      ...common("a-3", run3, 9, 9, false),
      type: "assistant_message",
      messageId: MessageId.make("m-a-3"),
      text: "Streaming answer",
      streaming: true,
      attachments: [],
    },
  ];

  return {
    ...v2Projection,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: v2ThreadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

let eventCounter = 0;

function applyTurnItemUpdate(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): OrchestrationV2ThreadProjection {
  eventCounter += 1;
  return applyOrchestrationV2ProjectionEvent(
    projection,
    {
      id: `evt-${eventCounter}`,
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: v2Now,
      payload: item,
    } as OrchestrationV2DomainEvent,
    { partialTimeline: true },
  )!;
}

describe("ThreadFeed row memoization and volatile store isolation", () => {
  it("isolates row renders across streaming tokens, tool updates, and per-row interactions", () => {
    const renderCounts = new Map<string, number>();

    const TestRow = memo(function TestRow(props: {
      readonly item: PendingThreadFeedEntry;
      readonly rowStore: ThreadFeedRowStore;
    }) {
      const slice = useThreadFeedRowVolatileSlice(props.rowStore, props.item);
      renderCounts.set(props.item.id, (renderCounts.get(props.item.id) ?? 0) + 1);
      return (
        <div
          data-row-id={props.item.id}
          data-copied={slice.copiedRowId ?? ""}
          data-expanded={slice.expandedRowsKey}
          data-unsettled={String(slice.isUnsettledTurn)}
          data-setup={slice.setupWorkingStartedAt ?? ""}
        />
      );
    });

    interface HarnessProps {
      readonly projection: OrchestrationV2ThreadProjection;
      readonly latestRun: ThreadFeedLatestRun | null;
      readonly copiedRowId: string | null;
      readonly expandedWorkRows: Record<string, boolean>;
      readonly editingMessageId?: MessageId;
      readonly setupWorkingStartedAt: string | null;
      readonly messageRunActive: boolean;
    }

    const projectFeed = createThreadFeedProjector();
    const projectPresentation = createThreadFeedPresentationProjector();
    const stabilize = createStableThreadFeedProjector<PendingThreadFeedEntry>();
    const projectDecorations = createTimelineDecorationsProjector();
    const expandedRuns = new Set<RunId>([RunId.make("run-1"), RunId.make("run-2")]);
    const expandedGroups = new Set<string>(["work-group:local:thread-v2:t-3"]);

    function FeedHarness(props: HarnessProps) {
      const feed = useMemo(
        () => projectFeed(props.projection.visibleTurnItems),
        [props.projection.visibleTurnItems],
      );
      const presentedFeed = useMemo(
        () =>
          stabilize(
            projectPresentation(
              feed,
              props.latestRun,
              expandedRuns,
              expandedGroups,
              props.latestRun?.startedAt ?? null,
              false,
            ),
          ),
        [feed, props.latestRun],
      );
      const decorations = useMemo(() => projectDecorations(presentedFeed, null), [presentedFeed]);
      const feedSummary = useMemo(() => threadFeedSummary(feed), [feed]);
      const presentedSummary = useMemo(() => threadFeedSummary(presentedFeed), [presentedFeed]);
      const failedRunIds = useMemo(
        () => threadFeedFailedRunIds(feedSummary, props.latestRun),
        [feedSummary, props.latestRun],
      );
      const unsettledTurnId = props.latestRun?.status === "running" ? props.latestRun.runId : null;
      const setupAnchorRowId =
        presentedSummary.firstUserIndex >= 0
          ? (presentedFeed[presentedSummary.firstUserIndex]?.id ?? null)
          : null;
      const storeState: ThreadFeedRowStoreState = {
        copiedRowId: props.copiedRowId,
        expandedWorkRows: props.expandedWorkRows,
        editingMessageId: props.editingMessageId ?? null,
        dispatchingMessageId: null,
        steerWait: null,
        unsettledTurnId,
        terminalAssistantMessageIds: feedSummary.terminalAssistantMessageIds,
        failedRunIds,
        decorations,
        agentAvatars: undefined,
        worktreeSetup: null,
        setupWorkingStartedAt: props.setupWorkingStartedAt,
        setupAnchorRowId,
        messageRunActive: props.messageRunActive,
        disclosureToggleSettling: false,
      };
      const [rowStore] = useState(() => createThreadFeedRowStore(storeState));
      useLayoutEffect(() => {
        rowStore.commitSnapshot(storeState);
      });

      return (
        <div>
          {presentedFeed.map((item) => (
            <TestRow key={item.id} item={item} rowStore={rowStore} />
          ))}
        </div>
      );
    }

    let projection = makeSyntheticConversation();
    const activeRun: ThreadFeedLatestRun = {
      runId: RunId.make("run-3"),
      status: "running",
      startedAt: DateTime.formatIso(v2Now),
      completedAt: null,
    };

    let currentProps: Omit<HarnessProps, "projection"> = {
      latestRun: activeRun,
      copiedRowId: null,
      expandedWorkRows: {},
      setupWorkingStartedAt: null,
      messageRunActive: true,
    };

    const renderHarness = (overrides?: Partial<Omit<HarnessProps, "projection">>) => {
      if (overrides) {
        currentProps = { ...currentProps, ...overrides };
      }
      act(() => {
        root.render(<FeedHarness projection={projection} {...currentProps} />);
      });
    };

    // 1. Initial open: every visible row renders exactly once.
    renderHarness();
    const rowIds = [...renderCounts.keys()];
    expect(rowIds.length).toBeGreaterThanOrEqual(7);
    for (const id of rowIds) {
      expect(renderCounts.get(id)).toBe(1);
    }
    const streamingRowId = "m-a-3";
    const activeToolGroupId = rowIds.find(
      (id) => id.includes("t-3") && !id.startsWith("work-toggle:") && !id.startsWith("work-live:"),
    )!;
    const activeToolToggleId = rowIds.find(
      (id) => id.includes("t-3") && (id.startsWith("work-toggle:") || id.startsWith("work-live:")),
    )!;
    const firstUserRowId = "m-u-1";
    expect(activeToolGroupId).toBeDefined();
    expect(activeToolToggleId).toBeDefined();

    // 2. 10 streamed assistant chunks: ONLY the streaming assistant row renders (10x), 0x on all other rows.
    renderCounts.clear();
    for (let chunk = 1; chunk <= 10; chunk++) {
      const current = projection.visibleTurnItems.find((e) => e.item.id === "a-3")!.item;
      if (current.type !== "assistant_message") throw new Error("expected assistant_message");
      projection = applyTurnItemUpdate(projection, {
        ...current,
        text: `Streaming answer chunk ${chunk}`,
      });
      renderHarness();
    }
    expect(renderCounts.get(streamingRowId)).toBe(10);
    for (const id of rowIds) {
      if (id !== streamingRowId) {
        expect(renderCounts.get(id) ?? 0).toBe(0);
      }
    }

    // 3. Tool item output update while running: ONLY that tool's toggle & activity group render, 0x on all messages & other groups.
    renderCounts.clear();
    const toolItem = projection.visibleTurnItems.find((e) => e.item.id === "t-3")!.item;
    if (toolItem.type !== "command_execution") throw new Error("expected command_execution");
    projection = applyTurnItemUpdate(projection, {
      ...toolItem,
      output: "running... 50% complete",
    });
    renderHarness();
    expect(renderCounts.get(activeToolGroupId)).toBe(1);
    expect(renderCounts.get(activeToolToggleId)).toBe(1);
    for (const id of rowIds) {
      if (id !== activeToolGroupId && id !== activeToolToggleId) {
        expect(renderCounts.get(id) ?? 0).toBe(0);
      }
    }

    // 4. Copying a work row: ONLY the matching activity group renders.
    renderCounts.clear();
    const activeActivityId = buildThreadFeed(projection.visibleTurnItems)
      .filter((entry) => entry.type === "activity-group")
      .flatMap((entry) => entry.activities)
      .find((activity) => activity.projectedItem.item.id === "t-3")!.id;
    renderHarness({ copiedRowId: activeActivityId });
    expect(renderCounts.get(activeToolGroupId)).toBe(1);
    for (const id of rowIds) {
      if (id !== activeToolGroupId) {
        expect(renderCounts.get(id) ?? 0).toBe(0);
      }
    }

    // 5. Expanding a work row: ONLY the matching activity group renders.
    renderCounts.clear();
    renderHarness({ expandedWorkRows: { [activeActivityId]: true } });
    expect(renderCounts.get(activeToolGroupId)).toBe(1);
    for (const id of rowIds) {
      if (id !== activeToolGroupId) {
        expect(renderCounts.get(id) ?? 0).toBe(0);
      }
    }

    renderCounts.clear();
    const firstUserMessageId = MessageId.make(firstUserRowId);
    renderHarness({
      expandedWorkRows: {
        [activeActivityId]: true,
        [userMessageExpansionKey(firstUserMessageId)]: true,
      },
    });
    expect(Array.from(renderCounts)).toEqual([[firstUserRowId, 1]]);

    renderCounts.clear();
    renderHarness({ editingMessageId: firstUserMessageId });
    expect(Array.from(renderCounts)).toEqual([[firstUserRowId, 1]]);

    // 6. Worktree setup working header: ONLY the setup anchor (first user row) renders.
    renderCounts.clear();
    renderHarness({ setupWorkingStartedAt: DateTime.formatIso(v2Now) });
    expect(renderCounts.get(firstUserRowId)).toBe(1);
    for (const id of rowIds) {
      if (id !== firstUserRowId) {
        expect(renderCounts.get(id) ?? 0).toBe(0);
      }
    }

    // 7. Turn settlement: ONLY the active turn's assistant row re-renders for unsettledTurnId change (older turns stay at 0).
    renderCounts.clear();
    renderHarness({
      latestRun: {
        ...activeRun,
        status: "completed",
        completedAt: DateTime.formatIso(v2Now),
      },
    });
    expect(renderCounts.get(streamingRowId)).toBe(1);
    expect(renderCounts.get("m-u-1") ?? 0).toBe(0);
    expect(renderCounts.get("m-a-1") ?? 0).toBe(0);
    expect(renderCounts.get("m-u-2") ?? 0).toBe(0);
    expect(renderCounts.get("m-a-2") ?? 0).toBe(0);
  });
});

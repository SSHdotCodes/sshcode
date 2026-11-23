import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  isSingleRowReplacement,
  visibleTurnItemsRevision,
} from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as DateTime from "effect/DateTime";
import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  failedFeedRunIds,
  filterDiscordThreadFeed,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "./threadActivity";

type MessageEntry = Extract<ThreadFeedEntry, { readonly type: "message" }>;

interface FeedRevision {
  readonly revision: object;
  readonly previousRevision: object | null;
  readonly originRevision: object;
  readonly index: number | null;
  readonly previousEntry?: MessageEntry;
  readonly originEntry?: MessageEntry;
}

const feedRevisions = new WeakMap<object, FeedRevision>();

export function threadFeedRevision(feed: object): FeedRevision {
  let revision = feedRevisions.get(feed);
  if (!revision) {
    const token = {};
    revision = { revision: token, originRevision: token, previousRevision: null, index: null };
    feedRevisions.set(feed, revision);
  }
  return revision;
}

function replaceStreamingMessage<T extends ThreadFeedEntry>(
  feed: ReadonlyArray<T>,
  index: number,
  entry: T,
): T[] {
  const previousEntry = feed[index];
  const next = feed.slice();
  next[index] = entry;
  const previous = threadFeedRevision(feed);
  feedRevisions.set(next, {
    revision: {},
    previousRevision: previous.revision,
    originRevision: previous.index === index ? previous.originRevision : previous.revision,
    index,
    ...(previousEntry?.type === "message"
      ? {
          previousEntry,
          originEntry: previous.index === index ? previous.originEntry : previousEntry,
        }
      : {}),
  });
  return next;
}

/** A token changes one message, not the grouping or ordering of the transcript. */
export function createThreadFeedProjector() {
  let previous:
    | {
        readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
        readonly version: ReturnType<typeof visibleTurnItemsRevision>;
        readonly options: Parameters<typeof buildThreadFeed>[1];
        readonly feed: ThreadFeedEntry[];
        readonly messageIndices: ReadonlyMap<string, number>;
      }
    | undefined;
  return (
    rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
    options?: Parameters<typeof buildThreadFeed>[1],
  ): ThreadFeedEntry[] => {
    const update = visibleTurnItemsRevision(rows);
    const sameOptions =
      previous &&
      previous.options?.attempts === options?.attempts &&
      previous.options?.nodes === options?.nodes &&
      previous.options?.liveThoughts === options?.liveThoughts &&
      (previous.options?.anchoredMessages === options?.anchoredMessages ||
        (!previous.options?.anchoredMessages?.length && !options?.anchoredMessages?.length));
    if (previous && sameOptions && previous.rows === rows) return previous.feed;
    if (
      previous &&
      sameOptions &&
      isSingleRowReplacement(previous.version, update) &&
      update.index !== null
    ) {
      const row = rows[update.index];
      const old = previous.rows[update.index];
      const item = row?.item;
      const index =
        item?.type === "assistant_message"
          ? previous.messageIndices.get(item.messageId)
          : undefined;
      const entry = index === undefined ? undefined : previous.feed[index];
      if (
        row &&
        old &&
        item?.type === "assistant_message" &&
        old.item.type === "assistant_message" &&
        item.streaming &&
        old.item.streaming &&
        item.messageId === old.item.messageId &&
        item.runId === old.item.runId &&
        row.visibility === old.visibility &&
        row.sourceThreadId === old.sourceThreadId &&
        row.sourceItemId === old.sourceItemId &&
        index !== undefined &&
        entry?.type === "message" &&
        entry.message.text.trim().length > 0 &&
        item.text.trim().length > 0 &&
        entry.createdAt === DateTime.formatIso(item.startedAt ?? item.updatedAt)
      ) {
        const feed = replaceStreamingMessage(previous.feed, index, {
          ...entry,
          message: {
            ...entry.message,
            text: item.text,
            attachments: item.attachments ?? [],
            updatedAt: DateTime.formatIso(item.updatedAt),
            projectedItem: row,
          },
        });
        previous = { ...previous, rows, version: update, options, feed };
        return feed;
      }
    }
    const feed = buildThreadFeed(rows, options);
    previous = {
      rows,
      version: update,
      options,
      feed,
      messageIndices: new Map(
        feed.flatMap((entry, index) =>
          entry.type === "message" ? [[entry.id, index] as const] : [],
        ),
      ),
    };
    return feed;
  };
}

/** Reuse folds and tool groups while only an already-visible streaming message changes. */
export function createThreadFeedPresentationProjector() {
  let previous:
    | {
        readonly version: FeedRevision;
        readonly options: readonly unknown[];
        readonly feed: ThreadFeedEntry[];
        readonly messageIndices: ReadonlyMap<string, number>;
      }
    | undefined;
  return (...args: Parameters<typeof deriveThreadFeedPresentation>): ThreadFeedEntry[] => {
    const [feed, run, expandedRuns, expandedGroups, startedAt, runless] = args;
    const options = [
      run?.runId,
      run?.status,
      run?.startedAt,
      run?.completedAt,
      expandedRuns,
      expandedGroups,
      startedAt,
      runless,
    ];
    const update = threadFeedRevision(feed);
    const previousOptions = previous?.options;
    const sameOptions = options.every((value, index) => value === previousOptions?.[index]);
    if (previous && sameOptions && previous.version.revision === update.revision)
      return previous.feed;
    if (
      previous &&
      isSingleRowReplacement(previous.version, update) &&
      update.index !== null &&
      sameOptions
    ) {
      const entry = feed[update.index];
      const index = entry?.type === "message" ? previous.messageIndices.get(entry.id) : undefined;
      if (index !== undefined && entry?.type === "message") {
        const presented = replaceStreamingMessage(previous.feed, index, entry);
        previous = { ...previous, version: update, feed: presented };
        return presented;
      }
    }
    const presented = deriveThreadFeedPresentation(...args);
    previous = {
      version: update,
      options,
      feed: presented,
      messageIndices: new Map(
        presented.flatMap((entry, index) =>
          entry.type === "message" ? [[entry.id, index] as const] : [],
        ),
      ),
    };
    return presented;
  };
}

function summarizeFeed(feed: ReadonlyArray<ThreadFeedEntry>) {
  const terminalIdsByTurn = new Map<string, string>();
  const messageIds = new Set<string>();
  let firstUserIndex = -1;
  let hasContent = false;
  let hasHtmlRenders = false;
  for (const [index, entry] of feed.entries()) {
    hasContent ||= entry.type !== "thinking";
    hasHtmlRenders ||= entry.type === "html-render";
    if (entry.type !== "message") continue;
    messageIds.add(entry.message.id);
    if (firstUserIndex < 0 && entry.message.role === "user") firstUserIndex = index;
    if (entry.message.role === "assistant" && entry.message.runId)
      terminalIdsByTurn.set(entry.message.runId, entry.id);
  }
  return {
    firstUserIndex,
    messageIds,
    hasContent,
    hasHtmlRenders,
    terminalAssistantMessageIds: new Set(terminalIdsByTurn.values()),
    failedRunIds: failedFeedRunIds(feed, null),
  };
}

const feedSummaries = new WeakMap<object, ReturnType<typeof summarizeFeed>>();

export function threadFeedSummary(feed: ReadonlyArray<ThreadFeedEntry>) {
  const update = threadFeedRevision(feed);
  let summary = feedSummaries.get(update.revision);
  if (!summary) {
    summary =
      (update.previousRevision && feedSummaries.get(update.previousRevision)) ||
      feedSummaries.get(update.originRevision) ||
      summarizeFeed(feed);
    feedSummaries.set(update.revision, summary);
  }
  return summary;
}

export function threadFeedFailedRunIds(
  summary: ReturnType<typeof threadFeedSummary>,
  latestRun: ThreadFeedLatestRun | null,
) {
  return latestRun?.status === "failed" && !summary.failedRunIds.has(latestRun.runId)
    ? new Set([...summary.failedRunIds, latestRun.runId])
    : summary.failedRunIds;
}

/** Filters and tail appends leave existing messages intact, so a chunk keeps its revision. */
export function createMessagePreservingFeedProjector<
  T extends ThreadFeedEntry,
  Args extends readonly unknown[],
>(transform: (feed: ReadonlyArray<T>, ...args: Args) => ReadonlyArray<T>) {
  let previous:
    | {
        revision: FeedRevision;
        args: Args;
        rows: ReadonlyArray<T>;
        messageIndices: ReadonlyMap<string, number>;
      }
    | undefined;
  return (feed: ReadonlyArray<T>, ...args: Args): ReadonlyArray<T> => {
    const revision = threadFeedRevision(feed);
    const previousArgs = previous?.args;
    const sameArgs =
      previousArgs &&
      args.length === previousArgs.length &&
      args.every((arg, index) => arg === previousArgs[index]);
    if (previous && sameArgs && revision.revision === previous.revision.revision)
      return previous.rows;
    if (
      previous &&
      sameArgs &&
      isSingleRowReplacement(previous.revision, revision) &&
      revision.index !== null
    ) {
      const entry = feed[revision.index];
      const index = entry?.type === "message" ? previous.messageIndices.get(entry.id) : undefined;
      if (entry?.type === "message" && index !== undefined) {
        const rows = replaceStreamingMessage(previous.rows, index, entry);
        previous = { ...previous, revision, rows };
        return rows;
      }
    }
    const rows = transform(feed, ...args);
    previous = {
      revision,
      args,
      rows,
      messageIndices: new Map(
        rows.flatMap((entry, index) =>
          entry.type === "message" ? [[entry.id, index] as const] : [],
        ),
      ),
    };
    return rows;
  };
}

export function createDiscordThreadFeedProjector<T extends ThreadFeedEntry>() {
  return createMessagePreservingFeedProjector<T, []>(filterDiscordThreadFeed);
}

type StabilizableThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: unknown;
  readonly acknowledged?: boolean;
  readonly serverQueued?: boolean;
};

function sameFeedActivities(
  a: ReadonlyArray<ThreadFeedActivity>,
  b: ReadonlyArray<ThreadFeedActivity>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.projectedItem !== right.projectedItem ||
      left.summary !== right.summary ||
      left.prominent !== right.prominent ||
      left.live !== right.live ||
      left.groupedToolDetail !== right.groupedToolDetail ||
      left.status !== right.status ||
      left.lifecycleStatus !== right.lifecycleStatus
    ) {
      return false;
    }
  }
  return true;
}

function sameFeedEntry(a: StabilizableThreadFeedEntry, b: StabilizableThreadFeedEntry): boolean {
  if (a === b) return true;
  if (
    a.type !== b.type ||
    a.id !== b.id ||
    a.createdAt !== b.createdAt ||
    a.continuesWorkLog !== b.continuesWorkLog ||
    a.pendingMessage !== b.pendingMessage ||
    a.acknowledged !== b.acknowledged ||
    a.serverQueued !== b.serverQueued
  ) {
    return false;
  }
  switch (a.type) {
    case "message": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "message" }>;
      return (
        a.message.projectedItem === right.message.projectedItem &&
        a.message.text === right.message.text &&
        a.message.updatedAt === right.message.updatedAt &&
        a.message.streaming === right.message.streaming &&
        a.message.role === right.message.role &&
        a.message.runId === right.message.runId &&
        a.message.attachments === right.message.attachments &&
        a.message.context === right.message.context &&
        a.message.questionAnswer === right.message.questionAnswer &&
        a.message.inputIntent === right.message.inputIntent
      );
    }
    case "activity-group": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;
      return a.runId === right.runId && sameFeedActivities(a.activities, right.activities);
    }
    case "work-toggle": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "work-toggle" }>;
      return (
        a.runId === right.runId &&
        a.groupId === right.groupId &&
        a.hiddenCount === right.hiddenCount &&
        a.expanded === right.expanded &&
        a.summary === right.summary &&
        a.summaryKind === right.summaryKind &&
        a.toolSurface === right.toolSurface &&
        a.toolIcon === right.toolIcon &&
        a.summaryToolIcon === right.summaryToolIcon &&
        a.hasFailure === right.hasFailure &&
        a.live === right.live &&
        a.shimmer === right.shimmer &&
        sameFeedActivities(a.activities, right.activities)
      );
    }
    case "viewed-images": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "viewed-images" }>;
      return a.runId === right.runId && sameFeedActivities(a.activities, right.activities);
    }
    case "run-fold": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "run-fold" }>;
      return a.runId === right.runId && a.label === right.label && a.expanded === right.expanded;
    }
    case "thinking": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "thinking" }>;
      return a.runId === right.runId;
    }
    case "html-render": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "html-render" }>;
      return a.runId === right.runId && a.render === right.render;
    }
    case "mcp-app": {
      const right = b as Extract<ThreadFeedEntry, { readonly type: "mcp-app" }>;
      return (
        a.runId === right.runId &&
        a.sourceThreadId === right.sourceThreadId &&
        a.itemId === right.itemId &&
        a.revision === right.revision &&
        a.app === right.app
      );
    }
  }
}

/**
 * Preserve unchanged row object references across full feed rebuilds (tool
 * updates, work-group toggles, new items) so memoized list rows bail out when
 * only another row changed.
 */
export function createStableThreadFeedProjector<T extends StabilizableThreadFeedEntry>() {
  let previous:
    | {
        input: ReadonlyArray<T>;
        inputRevision: FeedRevision;
        output: ReadonlyArray<T>;
        byId: Map<string, T>;
      }
    | undefined;

  return (feed: ReadonlyArray<T>): ReadonlyArray<T> => {
    const inputRevision = threadFeedRevision(feed);
    if (
      previous &&
      (previous.input === feed || previous.inputRevision.revision === inputRevision.revision)
    ) {
      return previous.output;
    }
    if (
      previous &&
      isSingleRowReplacement(previous.inputRevision, inputRevision) &&
      inputRevision.index !== null &&
      feed.length === previous.output.length
    ) {
      const replacement = feed[inputRevision.index]!;
      const output =
        previous.output === previous.input
          ? feed
          : replaceStreamingMessage(previous.output, inputRevision.index, replacement);
      previous.byId.set(replacement.id, replacement);
      previous = { input: feed, inputRevision, output, byId: previous.byId };
      return output;
    }

    const byId = new Map<string, T>();
    const prevById = previous?.byId;
    let allSameAsPreviousOutput = previous !== undefined && feed.length === previous.output.length;
    let reusedAny = false;
    const stabilized = new Array<T>(feed.length);

    for (let i = 0; i < feed.length; i++) {
      const next = feed[i]!;
      const prev = prevById?.get(next.id);
      const chosen = prev && sameFeedEntry(prev, next) ? prev : next;
      if (chosen !== next) reusedAny = true;
      if (allSameAsPreviousOutput && chosen !== previous!.output[i]) {
        allSameAsPreviousOutput = false;
      }
      stabilized[i] = chosen;
      byId.set(chosen.id, chosen);
    }

    const output = allSameAsPreviousOutput ? previous!.output : reusedAny ? stabilized : feed;
    previous = { input: feed, inputRevision, output, byId };
    return output;
  };
}

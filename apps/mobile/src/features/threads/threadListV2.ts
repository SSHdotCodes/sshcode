import {
  chatTitleSearchScore,
  liftNamedChats,
  rankChatsByTitleSearch,
  type SearchableChat,
} from "@t3tools/client-runtime/composerThreadItems";
import { groupComparisonThreads } from "@t3tools/client-runtime/state/model-comparison";
import { threadHasUnseenCompletion } from "../../lib/thread-summaries";
export { threadHasUnseenCompletion };
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import {
  connectionWorkStatus,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { presentBackgroundWaitInThreadRow } from "@t3tools/client-runtime/state/thread-execution";
import { longRunningFactsForShell, pinnedWaitingLine } from "@t3tools/shared/chatControls";
import {
  type EnvironmentThreadSearchMatch,
  threadSearchMatchKey,
} from "@t3tools/client-runtime/state/thread-search";
import { sessionBoxFacesFor } from "@t3tools/client-runtime/state/session-boxes";
import type { SessionBoxIconId } from "@t3tools/shared/sessionBoxes";
import {
  createInboxReturnTracker,
  failureNeedsYou,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  holdOrderedItems,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

/** Working section beta: when this device saw each thread leave the Working
    shelf. Only the arrangement sheet still reads it; the Home list and the
    iPad sidebar lead with working threads instead of folding them away. */
export const threadListInboxReturns = createInboxReturnTracker();

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Six visual states. Color distinguishes approval, input, active work, and
 * failures. Ready is the unlabeled resting state; waiting (runtime status "idle") is the agent
 * parked on open background tasks, grey like working rather than a false Done.
 * The orchestrator v2 presentation bridge parks runtime at idle when the
 * post-settlement background roster holds the run's completion (subagents,
 * monitors); commands left running, such as a dev server, read as ready.
 */
export type ThreadListV2Status =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

/** Settle keeps history accessible; older servers retain the archive fallback. */
export function resolveThreadListV2SwipeActions(input: {
  readonly settlementSupported?: boolean;
  readonly settled?: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  /** Row is on the snoozed shelf. */
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  return {
    primary: input.settlementSupported ? (input.settled ? "unsettle" : "settle") : "archive",
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

/**
 * Key for a row's swipe layer. Settle, unsettle, snooze and wake collapse the
 * row before their command and leave it collapsed once it succeeds, so the
 * key must change whenever a thread moves between sections: with a shelf
 * open the thread stays in the list under the same item key, and a stale
 * swipe layer would keep it at zero height.
 */
export function threadListV2SwipeResetKey(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "snoozedUntil">;
  readonly snoozed: boolean;
  readonly settled: boolean;
}): string {
  const { thread } = input;
  return `${thread.environmentId}:${thread.id}:${input.snoozed}:${thread.snoozedUntil}:${input.settled}`;
}

/**
 * The point at which a queued-turn snooze guard expires on its own. Rows arm
 * a one-shot timer for this boundary so Snooze appears without waiting for an
 * unrelated render. User-blocked threads return null because only fresh
 * server data can make them snoozable.
 */
export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestRun"
    | "latestUserMessageAt"
    | "runtime"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (thread.pendingSubagentRequest != null) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** Keep cached work from looking live while its environment is disconnected. */
export function resolveThreadListV2DisplayStatus(
  status: ThreadListV2Status,
  phase: EnvironmentConnectionPhase | undefined,
  longRunningStatus?: string | null,
): ThreadListV2Status | "connecting" | "reconnecting" | "offline" {
  if (status !== "working" && status !== "waiting" && !longRunningStatus) return status;
  return connectionWorkStatus(phase) ?? status;
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function longRunningRowFacts(thread: EnvironmentThreadShell, nowMs: number) {
  return longRunningFactsForShell({
    ...thread,
    runtimeStatus: thread.runtime?.status ?? null,
    workingStartedAt: resolveThreadWorkingStartedAt(thread),
    nowMs,
  });
}

function threadRowWaitingLine(thread: EnvironmentThreadShell, nowMs: number): string | null {
  const facts = longRunningRowFacts(thread, nowMs);
  if (facts.needsYou || facts.working) return null;
  return (
    (thread.runtime?.status === "idle"
      ? presentBackgroundWaitInThreadRow(thread.pendingBackgroundTasks)
      : null) ?? pinnedWaitingLine(facts)
  );
}

/** Most recently active first. The shell's activity instant leads the row's updated time. */
/** The latest work on a thread: creation, the last user message, or the
    latest run's request, start, or finish. Lifecycle edits (pin, settle,
    rename) never count, so they cannot reorder the list. Rows sort and label
    by this one stamp, so a row's time always matches its place. */
export function resolveThreadListV2ActivityAt(
  thread: Pick<
    EnvironmentThreadShell,
    "createdAt" | "latestUserMessageAt" | "latestRun" | "unsettledAt"
  >,
): string {
  let latest = thread.createdAt;
  let latestMs = parseTimestampMs(latest);
  for (const candidate of [
    // Un-settling brings a thread back into the list, so it surfaces at the
    // top rather than sinking to the slot its old messages would give it.
    thread.unsettledAt,
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
  ]) {
    if (candidate == null) continue;
    const candidateMs = Date.parse(candidate);
    if (!Number.isNaN(candidateMs) && candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}

/**
 * How long a finished turn must stay finished before the chat moves. A third
 * of turns start again within a minute on their own (a child reporting back,
 * a monitor waking, a queued message), and moving each would bounce the row.
 */
const FINISHED_SETTLE_MS = 2 * 60_000;

function finishedWithin(
  thread: EnvironmentThreadShell,
  status: ThreadListV2Status,
  nowMs: number,
): boolean {
  if (status === "failed" || status === "limited") return false;
  const completedAt = thread.latestRun?.completedAt;
  if (completedAt == null) return false;
  const completedAtMs = Date.parse(completedAt);
  return !Number.isNaN(completedAtMs) && nowMs - completedAtMs < FINISHED_SETTLE_MS;
}

/**
 * Waiting on the user: an approval or answer, an unseen failure/limit, an
 * actionable plan, or a finished turn not opened since that has had time to
 * settle. These lead even the working chats, so a long run can't bury them.
 */
export function threadListV2WaitsOnYou(
  thread: EnvironmentThreadShell,
  status: ThreadListV2Status,
  nowMs: number,
): boolean {
  if (status === "approval" || status === "input") return true;
  if (status === "failed" || status === "limited") {
    // Pre-tracking servers omit lastVisitedAt and mobile does not record local
    // visits for them, so skip the unopened-failure rule instead of pinning
    // seen failures in Needs-you for 24h.
    if (thread.lastVisitedAt === undefined) return false;
    return failureNeedsYou(thread, nowMs);
  }
  if (status === "working" || status === "waiting") return false;
  if (thread.hasActionableProposedPlan) return true;
  return threadHasUnseenCompletion(thread) && !finishedWithin(thread, status, nowMs);
}

/** Threads the agent is still on, or that wait on the user, lead the list. */
function threadListV2Leads(status: ThreadListV2Status): boolean {
  return (
    status === "approval" || status === "input" || status === "working" || status === "waiting"
  );
}

/** Newest activity first; each key resolves once per sort. */
function sortThreadsByActivity(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  return threads
    .map((thread) => ({
      thread,
      activityMs: parseTimestampMs(resolveThreadListV2ActivityAt(thread)),
    }))
    .sort(
      (left, right) =>
        right.activityMs - left.activityMs ||
        left.thread.id.localeCompare(right.thread.id) ||
        left.thread.environmentId.localeCompare(right.thread.environmentId),
    )
    .map(({ thread }) => thread);
}

/** Working chats by what the user last asked, so agent-started turns don't reshuffle them. */
function sortThreadsByAsked(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  return threads
    .map((thread) => ({
      thread,
      askedMs: parseTimestampMs(
        thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt ?? thread.createdAt,
      ),
    }))
    .sort(
      (left, right) =>
        right.askedMs - left.askedMs ||
        left.thread.id.localeCompare(right.thread.id) ||
        left.thread.environmentId.localeCompare(right.thread.environmentId),
    )
    .map(({ thread }) => thread);
}

/** Canonical card section for Move up/down, independent of search or scope. */
export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  // An empty set is treated as absent so `?.` skips building the key.
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threads = input.threads.filter((thread) => {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
      return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    const pinned = thread.pinnedAt != null;
    return input.section === "pinned" ? pinned : !pinned;
  });
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly settled?: boolean;
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  /** Pinned-block row: renders the pin glyph and offers Unpin. */
  readonly pinned: boolean;
  /** One-line status for work the chat is waiting on or its next scheduled run. */
  readonly longRunningStatus?: string;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  /** A search query forces settled rows into the list, so the shelf cannot
      be collapsed while it is active. */
  readonly settledShelfSearchExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  /** Index in `items` for unsent tasks, after pinned rows and chats that
      are working, waiting on background work, or need the user. */
  readonly pendingTasksIndex: number;
  /** Snoozed threads matching the current search. */
  readonly snoozedCount: number;
  /** A search query shows snoozed matches too, so the shelf is open while it
      is active, as the settled one is. */
  readonly snoozedShelfSearchExpanded?: boolean;
  /** Index in `items` where the Snoozed shelf header belongs. The header is
      still rendered when the shelf is collapsed and no snoozed rows exist. */
  readonly snoozedShelfHeaderIndex: number | null;
  /** Soonest wake time among snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** Precomputed so recycled-list equality can see a minute-tick change. */
  readonly snoozeWakeLabelText: string | undefined;
  /** Row timestamp precomputed against the parent clock so the recycler's
      equality only sees a change on rows that actually draw a time. Blank
      while the row renders a status label or the wake countdown instead. */
  readonly timeLabel: string;
  /** Minute clock feeding the row's native snooze menu, carried only on rows
      whose menu holds snooze presets (capability-gated rows the user may
      snooze). Keeping it out of the list's `extraData` means the minute tick
      re-renders just these rows instead of every visible one. */
  readonly snoozePresetMinute: string | undefined;
  /** Inset hairline drawn under the row. Precomputed from the final order so
      a neighbour change (e.g. the snoozed shelf appearing) updates the row
      through recycled-list equality instead of leaving a stale divider. */
  readonly showTrailingDivider: boolean;
  /** A message for this thread is waiting in the outbox. Carried on the item
      so an outbox write (which never touches the thread shell) reaches the
      row through recycled-list equality instead of leaving a stale icon. */
  readonly hasQueuedMessages: boolean;
  /** Move up/down availability within the pinned block. Carried on the item
      for the same reason: a reorder in flight (or its commit) changes menu
      availability without changing any shell. */
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** The row's painting, picked against the other rows so chats on a topic differ. */
  readonly face: SessionBoxIconId | undefined;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** Same rule as the thread rows: a hairline unless the next row carries its
      own section rule or none follows. */
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** Shelf preferences still loading: the toggle is disabled until they
      arrive. Carried on the item because a recycled cell ignores the render
      closure — without it the header would stay visibly disabled (or enabled
      too early) after the preference load lands. */
  readonly disabled: boolean;
  /** Expanded by the search rather than the user: a plain section label. */
  readonly searchExpanded: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
  /** Expanded by the search rather than the user: the header is a plain
      section label, so a tap cannot silently flip the saved preference. */
  readonly searchExpanded: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

/** Recycled-list equality for the flat v2 list (Home + iPad sidebar).
    Item objects are rebuilt on every minute tick and every partition run;
    without this the lists would consider every mounted row changed and
    re-render all of them (each carrying a swipeable + a PR subscription).
    The clock-derived fields are per-row precomputed text, so a minute tick
    only flips equality on rows whose visible text (or snooze menu) actually
    moved. Thread references are stable across rebuilds. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.item.settled === item.item.settled &&
        previous.item.longRunningStatus === item.item.longRunningStatus &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown &&
        previous.face === item.face
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled &&
        previous.searchExpanded === item.searchExpanded
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled &&
        previous.searchExpanded === item.searchExpanded
      );
  }
}

/** The latest activity a row renders when it shows no status label. Blank for
    status-labelled rows and snoozed rows with a wake countdown — those never
    draw a time, so their minute tick must not invalidate the cell. */
function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  if (showSnoozeWakeLabel || item.longRunningStatus) return "";
  if (resolveThreadListV2Status(item.thread) !== "ready") return "";
  // The Settled shelf orders by when each thread settled; label it the same way.
  const settledAt = item.settled ? resolveSettledThreadTimestamp(item.thread) : null;
  return relativeTime(settledAt ?? resolveThreadListV2ActivityAt(item.thread));
}

/**
 * Builds the shared mobile order: pinned → working or waiting on the user →
 * unsent tasks → everything else by recent activity → snoozed shelf. Unsent
 * tasks wait on a reconnect or on the user, so they sit just below live work.
 */
export function buildThreadListV2ListItems(input: {
  readonly layout: ThreadListV2Layout;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly settledShelfExpanded?: boolean;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozeLabelNow?: string;
  /** Environments whose server supports thread.snooze. Rows on other
      environments never carry the minute clock that feeds the snooze menu.
      Absent = no gating (tests). */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Thread keys (`environmentId:threadId`) with a message waiting in the
      outbox; stamped onto the matching rows as `hasQueuedMessages`. */
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Menu availability for Move up/down, keyed by `environmentId:threadId`.
      Produced by `computeThreadMoveAvailability` in one pass per section; a
      recycled cell ignores the render closure, so the stamps ride on the
      item. Absent = never available (tests). */
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  /** True while the shelf expansion preference is still loading; stamped
      onto the shelf header so the disabled state reaches recycled cells. */
  readonly shelfPreferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const { layout } = input;
  // An empty set is treated as absent so `?.` skips building the key.
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const faces = sessionBoxFacesFor(layout.items.map((item) => item.thread));
  const threadItems = layout.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined;
    // The minute clock belongs on the item, not the list's extraData, so the
    // recycler's equality can confine the per-minute re-render to rows whose
    // snooze menu actually shows preset times.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread, { now: input.snoozeLabelNow })
        ? input.snoozeLabelNow
        : undefined;
    const threadKey = `${item.thread.environmentId}:${item.thread.id}`;
    const move = input.moveAvailability?.get(threadKey);
    return {
      type: "v2-thread",
      key: `v2-thread:${threadKey}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages: queuedThreadKeys?.has(threadKey) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
      face: faces.get(item.thread.id),
    };
  });
  const pendingItems = input.pendingTasks.map((pendingTask): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showTrailingDivider: false,
  }));
  const result: ThreadListV2ListItem[] = [];
  for (let index = 0; index <= threadItems.length; index++) {
    if (index === layout.pendingTasksIndex) result.push(...pendingItems);
    if (index === layout.snoozedShelfHeaderIndex && layout.snoozedCount > 0) {
      result.push({
        type: "v2-snoozed-shelf",
        key: "v2-snoozed-shelf",
        count: layout.snoozedCount,
        expanded: input.snoozedShelfExpanded === true || layout.snoozedShelfSearchExpanded === true,
        disabled: input.shelfPreferencesLoading === true,
        searchExpanded: layout.snoozedShelfSearchExpanded === true,
      });
    }
    if (index === layout.settledShelfHeaderIndex && (layout.settledCount ?? 0) > 0) {
      result.push({
        type: "v2-settled-shelf",
        key: "v2-settled-shelf",
        count: layout.settledCount ?? 0,
        expanded: input.settledShelfExpanded === true || layout.settledShelfExpanded === true,
        disabled: input.shelfPreferencesLoading === true,
        searchExpanded: layout.settledShelfSearchExpanded === true,
      });
    }
    const item = threadItems[index];
    if (item) result.push(item);
  }
  // Hairlines depend on the final neighbour, so they are stamped after the
  // splice: a recycled cell only re-renders when its divider actually flips.
  return result.map((entry, index) => {
    if (entry.type === "v2-snoozed-shelf" || entry.type === "v2-settled-shelf") {
      return entry;
    }
    const next = result[index + 1];
    const showTrailingDivider = next?.type === "v2-thread" || next?.type === "v2-pending";
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

/**
 * One flat list, like a chat app's conversation list: pinned threads keep
 * their arrangement on top, then threads that are working or waiting on the
 * user, then everything else by most recent activity. Settled threads join
 * a collapsed history shelf. Snoozed threads have their own shelf until they wake.
 */
/** A chat as the list search reads it: title, model, harness and pull request. */
function searchableChat(thread: EnvironmentThreadShell): SearchableChat {
  return {
    title: thread.title,
    model: thread.modelSelection?.model,
    providerInstanceId: thread.providerInstanceId,
    extraTerms: threadPullRequestSearchTerms(thread),
  };
}

function matchesListTitle(thread: EnvironmentThreadShell, query: string) {
  return chatTitleSearchScore(query, searchableChat(thread)) !== null;
}

/**
 * Local title rows stay instant; content rows keep server rank regardless of chat age or
 * shelf, except that the chats the words name come first (`liftNamedChats`): the server
 * ranks what was said and cannot see which model a chat ran on.
 */
export function rankedContentSearchMatches(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  matches: ReadonlyArray<EnvironmentThreadSearchMatch>,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  const titles = new Set(
    groupComparisonThreads(threads)
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          matchesListTitle(thread, normalized),
      )
      .map((thread) =>
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
  );
  const shells = new Map(
    threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  return liftNamedChats({
    query,
    results: matches.filter((match) => !titles.has(threadSearchMatchKey(match))),
    chatOf: (match) => {
      const shell = shells.get(threadSearchMatchKey(match));
      if (shell) {
        return {
          title: shell.title,
          model: shell.modelSelection?.model,
          providerInstanceId: shell.providerInstanceId,
        };
      }
      return match.title === undefined ? null : { title: match.title };
    },
  });
}

export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  /** Environments whose server supports thread.settle/unsettle. A settled
      thread there leaves the pinned block (parity with web), matching the
      pinned section Move up/down plans against. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Threads on
      other environments never park on the snoozed shelf — the user could
      not wake them. Absent = no gating (tests). */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Second-precise clock used for time-based classification. */
  readonly now: string;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly settledShelfExpanded?: boolean;
  readonly snoozedShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
  /** Thread keys (`environmentId:threadId`) with a message waiting in the
      outbox. A pinned thread with queued work stays pinned even when the
      server has settled it. */
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Keeps an opened chat in the Needs-you tier until the user leaves it so
      tapping/marking it read does not drop the row away immediately. */
  readonly heldNeedsYouKey?: string | null;
  /** While the user is touching or scrolling the list, keep previously shown
      active rows in their relative order so rows cannot jump under a finger. */
  readonly heldMainOrderKeys?: ReadonlyArray<string> | null;
}): ThreadListV2Layout {
  const now = input.now;
  const nowMs = parseTimestampMs(now);
  const pending =
    input.pendingOrder?.section === "pinned"
      ? reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({ ...input, section: "pinned", pendingOrder: null }),
        )
      : null;
  const query = input.searchQuery.trim().toLocaleLowerCase();

  const pinned: EnvironmentThreadShell[] = [];
  const waitingOnYou: EnvironmentThreadShell[] = [];
  const leading: EnvironmentThreadShell[] = [];
  const rest: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  // An empty set is treated as absent so `?.` skips building the key.
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  for (const thread of groupComparisonThreads(input.threads)) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    if (
      query.length > 0 &&
      !matchesListTitle(thread, query) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    ) {
      continue;
    }
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    // Snooze outranks pinning until the thread wakes.
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    const isSettled =
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      !threadListV2Leads(resolveThreadListV2Status(thread)) &&
      !hasQueuedTurnStart(thread, { now }) &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true;
    if (isSettled) {
      settled.push(thread);
      continue;
    }
    const status = resolveThreadListV2Status(thread);
    const threadKey = `${thread.environmentId}:${thread.id}`;
    if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (
      threadListV2WaitsOnYou(thread, status, nowMs) ||
      (input.heldNeedsYouKey != null && threadKey === input.heldNeedsYouKey)
    ) {
      waitingOnYou.push(thread);
    } else if (threadListV2Leads(status) || finishedWithin(thread, status, nowMs)) {
      // A turn that just finished keeps its place among the working chats.
      leading.push(thread);
    } else {
      rest.push(thread);
    }
  }

  // A search lists what it names best first, in one list: the usual order (pinned, working,
  // then settled history) buried the chat a search named under weaker matches.
  if (query.length > 0) {
    // In the usual order, which settles equal matches.
    const flags = new Map<EnvironmentThreadShell, ThreadListV2Item>();
    for (const thread of applyPendingThreadOrder(
      sortPinnedThreadsByOrderKey(pinned),
      "pinned",
      pending,
    )) {
      flags.set(thread, { thread, snoozed: false, pinned: true });
    }
    for (const thread of [
      ...sortThreadsByActivity(waitingOnYou),
      ...sortThreadsByAsked(leading),
      ...sortThreadsByActivity(rest),
    ]) {
      flags.set(thread, { thread, snoozed: false, pinned: false });
    }
    for (const thread of snoozed) flags.set(thread, { thread, snoozed: true, pinned: false });
    for (const thread of sortSettledThreads(settled)) {
      flags.set(thread, { thread, settled: true, snoozed: false, pinned: false });
    }
    const ranked = rankChatsByTitleSearch([...flags.keys()], query, searchableChat);
    // Chats only the message search found keep their place after the title matches.
    const found = new Set(ranked);
    const items = [...ranked, ...[...flags.keys()].filter((thread) => !found.has(thread))].map(
      (thread) => {
        const item = flags.get(thread)!;
        const line = item.settled || item.snoozed ? null : threadRowWaitingLine(thread, nowMs);
        return line === null ? item : { ...item, longRunningStatus: line };
      },
    );
    return {
      items,
      pendingTasksIndex: items.length,
      settledCount: settled.length,
      settledShelfExpanded: true,
      settledShelfSearchExpanded: true,
      settledShelfHeaderIndex: null,
      snoozedCount: snoozed.length,
      snoozedShelfSearchExpanded: true,
      snoozedShelfHeaderIndex: null,
      nextSnoozeWakeAt,
    };
  }

  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleSnoozed =
    input.snoozedShelfExpanded === true || query.length > 0
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  // Pinned and main-list rows say what they have out (monitors, subagents, a next run).
  const waiting = (thread: EnvironmentThreadShell) => {
    const line = threadRowWaitingLine(thread, nowMs);
    return line === null ? {} : { longRunningStatus: line };
  };
  const items: ThreadListV2Item[] = [];
  for (const thread of applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  )) {
    items.push({
      thread,
      snoozed: false,
      pinned: true,
      ...waiting(thread),
    });
  }
  const sortedWaitingOnYou = sortThreadsByActivity(waitingOnYou);
  const sortedLeading = sortThreadsByAsked(leading);
  const sortedRest = sortThreadsByActivity(rest);
  const orderedMain =
    input.heldMainOrderKeys != null && input.heldMainOrderKeys.length > 0
      ? holdOrderedItems(
          [...sortedWaitingOnYou, ...sortedLeading, ...sortedRest],
          input.heldMainOrderKeys,
          (thread) => `${thread.environmentId}:${thread.id}`,
        )
      : [...sortedWaitingOnYou, ...sortedLeading, ...sortedRest];
  const leadingKeys = new Set<string>();
  for (const thread of sortedWaitingOnYou) leadingKeys.add(`${thread.environmentId}:${thread.id}`);
  for (const thread of sortedLeading) leadingKeys.add(`${thread.environmentId}:${thread.id}`);
  let pendingTasksIndex = items.length;
  for (const thread of orderedMain) {
    items.push({
      thread,
      snoozed: false,
      pinned: false,
      ...waiting(thread),
    });
    if (leadingKeys.has(`${thread.environmentId}:${thread.id}`)) {
      pendingTasksIndex = items.length;
    }
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({ thread, snoozed: true, pinned: false });
  }
  const orderedSettled = sortSettledThreads(settled);
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of orderedSettled) {
    if (
      input.settledShelfExpanded ||
      query.length > 0 ||
      `${thread.environmentId}:${thread.id}` === selectedThreadKey
    ) {
      items.push({ thread, settled: true, snoozed: false, pinned: false });
    }
  }
  return {
    items,
    pendingTasksIndex,
    settledCount: orderedSettled.length,
    settledShelfExpanded: input.settledShelfExpanded === true || query.length > 0,
    settledShelfSearchExpanded: query.length > 0,
    settledShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfSearchExpanded: query.length > 0,
    snoozedShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}

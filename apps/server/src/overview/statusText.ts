import {
  isHelperThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The live status Overview reads at the start of every turn, so most
 * questions need no tool call. Plain text, most urgent first, and short: it
 * goes into every Overview prompt.
 */

/** The turn's app-context entry that carries the status. */
export const OVERVIEW_STATUS_CONTEXT_KEY = "sshcode_overview_status";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Finished chats older than this are left to t3_thread_list. */
const RECENT_WINDOW_MS = 2 * DAY;
const MAX_RECENT = 12;
const MAX_PREVIEW_CHARS = 240;
const MAX_ERROR_CHARS = 160;
const MAX_NAMED_SUBAGENTS = 4;

const LIVE_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

type Thread = OrchestrationV2ThreadShell;

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value);

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

const isLive = (thread: Thread) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : LIVE_STATUSES.has(thread.status);

const isSettled = (thread: Thread) =>
  thread.settledOverride === "settled" ||
  (thread.settledAt !== null && thread.settledOverride !== "active");

function needsYou(thread: Thread): string | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (kind === "user_input") return "asked the user a question";
  if (kind !== undefined && kind !== "auth_refresh") return `wants the user's approval (${kind})`;
  if (thread.hasActionableProposedPlan) return "has a plan for the user to review";
  return null;
}

function stateOf(thread: Thread): string {
  if (isLive(thread)) {
    const startedAt = thread.activityRunStartedAt ?? thread.latestRunStartedAt ?? null;
    return startedAt === null ? "working" : `working, started ${DateTime.formatIso(startedAt)}`;
  }
  const at = DateTime.formatIso(thread.updatedAt);
  switch (thread.status) {
    case "failed":
      return thread.lastErrorClass === "usage_limit"
        ? `stopped at a usage limit at ${at}`
        : `failed at ${at}${thread.lastError ? `: ${oneLine(thread.lastError, MAX_ERROR_CHARS)}` : ""}`;
    case "interrupted":
    case "cancelled":
      return `stopped at ${at}`;
    case "completed":
      return `finished at ${at}`;
    default:
      return `idle since ${at}`;
  }
}

/** The top-level chat a subagent works for, following parents up the tree. */
function rootOf(thread: Thread, byId: ReadonlyMap<ThreadId, Thread>): ThreadId | null {
  const seen = new Set<ThreadId>();
  let current: Thread | undefined = thread;
  while (current?.lineage.relationshipToParent === "subagent") {
    const parentId: ThreadId | null = current.lineage.parentThreadId;
    if (
      current.lineage.parentEnvironmentId !== undefined ||
      parentId === null ||
      seen.has(parentId)
    )
      return null;
    seen.add(parentId);
    current = byId.get(parentId);
  }
  return current === undefined || current === thread ? null : current.id;
}

function subagentLine(subagents: ReadonlyArray<Thread>): string | null {
  if (subagents.length === 0) return null;
  const working = subagents.filter(isLive);
  const asking = working.filter((thread) => needsYou(thread) !== null);
  const failed = subagents.filter((thread) => !isLive(thread) && thread.status === "failed");
  const counts = [
    `${subagents.length} total`,
    ...(working.length > 0 ? [`${working.length} working`] : []),
    ...(asking.length > 0 ? [`${asking.length} waiting on the user`] : []),
    ...(failed.length > 0 ? [`${failed.length} failed`] : []),
  ];
  const named = [...asking, ...working.filter((thread) => !asking.includes(thread)), ...failed]
    .slice(0, MAX_NAMED_SUBAGENTS)
    .map(
      (thread) =>
        `"${oneLine(thread.title, 60)}" (id ${thread.id}, ${thread.modelSelection.model}, ${needsYou(thread) ?? stateOf(thread)})`,
    );
  return `  Subagents: ${counts.join(", ")}${named.length > 0 ? `. ${named.join("; ")}` : ""}`;
}

function threadBlock(
  thread: Thread,
  subagents: ReadonlyArray<Thread>,
  now: number,
): ReadonlyArray<string> {
  const ask = needsYou(thread);
  const head = [
    `- "${oneLine(thread.title, 80)}" (id ${thread.id})`,
    thread.modelSelection.model,
    ...(ask === null ? [] : [ask]),
    stateOf(thread),
    ...((thread.pendingBackgroundTasks ?? []).length > 0
      ? [`${thread.pendingBackgroundTasks?.length} background tasks still running`]
      : []),
    ...(thread.snoozedUntil != null && millis(thread.snoozedUntil) > now ? ["snoozed"] : []),
  ].join(" · ");
  const latest = thread.latestVisibleMessage;
  const subagentSummary = subagentLine(subagents);
  return [
    head,
    ...(latest === null || latest.text.trim().length === 0
      ? []
      : [
          `  Last message (${latest.role === "assistant" ? "agent" : "user"}, ${DateTime.formatIso(latest.updatedAt)}): ${oneLine(latest.text, MAX_PREVIEW_CHARS)}`,
        ]),
    ...(subagentSummary === null ? [] : [subagentSummary]),
  ];
}

export function formatOverviewStatus(input: {
  readonly threads: ReadonlyArray<Thread>;
  readonly now: number;
  readonly timeZone?: string;
}): string {
  const timeZone = input.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const visible = input.threads.filter(
    (thread) =>
      !isHelperThreadId(thread.id) && thread.deletedAt === null && thread.archivedAt === null,
  );
  const byId = new Map(visible.map((thread) => [thread.id, thread] as const));
  const subagentsByRoot = new Map<ThreadId, Array<Thread>>();
  const chats: Array<Thread> = [];
  for (const thread of visible) {
    if (thread.lineage.relationshipToParent !== "subagent") {
      chats.push(thread);
      continue;
    }
    const root = rootOf(thread, byId);
    if (root === null) continue;
    const siblings = subagentsByRoot.get(root);
    if (siblings === undefined) subagentsByRoot.set(root, [thread]);
    else siblings.push(thread);
  }
  const subagentsOf = (thread: Thread) => subagentsByRoot.get(thread.id) ?? [];
  const newestFirst = (left: Thread, right: Thread) =>
    millis(right.updatedAt) - millis(left.updatedAt);

  const waiting = chats
    .filter(
      (thread) =>
        needsYou(thread) !== null ||
        subagentsOf(thread).some((child) => isLive(child) && needsYou(child) !== null),
    )
    .toSorted(newestFirst);
  const working = chats
    .filter(
      (thread) => !waiting.includes(thread) && (isLive(thread) || subagentsOf(thread).some(isLive)),
    )
    .toSorted(newestFirst);
  const rest = chats
    .filter((thread) => !waiting.includes(thread) && !working.includes(thread))
    .toSorted(newestFirst);
  const recent = rest
    .filter(
      (thread) => !isSettled(thread) && input.now - millis(thread.updatedAt) < RECENT_WINDOW_MS,
    )
    .slice(0, MAX_RECENT);
  const unlisted = rest.length - recent.length;

  const section = (title: string, threads: ReadonlyArray<Thread>) =>
    threads.length === 0
      ? []
      : [
          "",
          `${title}:`,
          ...threads.flatMap((thread) => threadBlock(thread, subagentsOf(thread), input.now)),
        ];

  return [
    `Now: ${DateTime.formatIso(DateTime.makeUnsafe(input.now))} (time zone ${timeZone}).`,
    `${chats.length} chats: ${waiting.length} waiting on the user, ${working.length} working, ${recent.length} finished or idle in the last 2 days${unlisted > 0 ? `, ${unlisted} older or settled (not listed)` : ""}.`,
    ...section("Waiting on the user", waiting),
    ...section("Working", working),
    ...section("Recently finished or idle", recent),
  ].join("\n");
}

/** A record includes its urgency section, so moving sections is a change too. */
function statusRecords(status: string) {
  const [clock = "", summary = "", ...lines] = status.split("\n");
  const records = new Map<string, string>();
  let section = "";
  let id: string | undefined;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (!line.startsWith(" ") && !line.startsWith("- ")) {
      section = line;
      id = undefined;
      continue;
    }
    const match = /^- .* \(id ([^)]+)\)/u.exec(line);
    if (match) {
      id = match[1]!;
      records.set(id, `${section}\n${line}`);
    } else if (id !== undefined) {
      records.set(id, `${records.get(id)}\n${line}`);
    }
  }
  return { clock, summary, records };
}

/** Send full facts to a new context; otherwise replace/remove only changed records. */
export function overviewStatusUpdate(status: string, previous?: string): string {
  if (previous === undefined) return `Full snapshot (replaces earlier status):\n${status}`;
  const current = statusRecords(status);
  const before = statusRecords(previous);
  const changed = [...current.records].filter(([id, text]) => before.records.get(id) !== text);
  const removed = [...before.records.keys()].filter((id) => !current.records.has(id));
  return [
    current.clock,
    ...(current.summary === before.summary ? [] : [current.summary]),
    ...(removed.length === 0 ? [] : [`No longer listed (ids): ${removed.join(", ")}.`]),
    ...(changed.length === 0
      ? removed.length === 0 && current.summary === before.summary
        ? ["No chat changes."]
        : []
      : ["Changed records (replace by id):", ...changed.map(([, text]) => text)]),
  ].join("\n");
}

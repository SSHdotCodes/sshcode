/**
 * What the local box-namer model wrote for each chat, shared between the shell builders
 * (which read it synchronously while they assemble rows) and the `BoxNamer` worker (which
 * fills it in the background). Until the worker is running, every lookup misses and the
 * shell keeps its rule-based name and "now" line.
 *
 * When the model (box-v2 and later) says a chat's work has moved to a different task, the
 * chat is offered the title it wrote (`subscribeRetitle`), unless the user named it
 * themselves (`boxTitles`). The "now" line never renames a chat: it also describes asides
 * and follow-ups of the same task.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Give the synchronous cache a process epoch.
import * as NodeCrypto from "node:crypto";
import { sameSessionTopic } from "@t3tools/shared/sessionBoxes";
import type { ShellDecorationCursor } from "@t3tools/contracts";

export interface BoxNamerBasis {
  readonly title: string;
  /** The latest typed request the "now" line was written from. */
  readonly requestId: string;
}

export interface BoxNamerEntry extends BoxNamerBasis {
  readonly name: string | null;
  /** Null when the model judged that the title still says what the chat is on. */
  readonly now: string | null;
  /** A new title when the chat's work has moved to a different task; box-v1 models never write one. */
  readonly retitle?: string | null | undefined;
}

export interface BoxNamerLookup {
  /** The model's name for this title, if it has one. */
  readonly name: string | null;
  /** Undefined until the model has read this request; null when the title still fits. */
  readonly now: string | null | undefined;
}

/** A chat whose work has moved on from the title the model read. */
export interface RetitleCandidate {
  readonly threadId: string;
  readonly requestId: string;
  /** The title the model read; only this title is replaced. */
  readonly title: string;
  /** The title the model wrote for the chat's new task. */
  readonly next: string;
  /** The request before was on the same new task, so the chat has stayed on it. */
  readonly settled: boolean;
}

/** Retitles carry this command id prefix, so they aren't taken for the user's renames. */
export const AUTO_TITLE_COMMAND_PREFIX = "box-namer-retitle:";

/** How long the agent works on a new topic before a single request retitles the chat. */
export const AUTO_TITLE_WORK_MS = 3 * 60_000;

let active = false;
const entries = new Map<string, BoxNamerEntry>();
const wanted = new Map<string, BoxNamerBasis>();
let onWanted: (() => void) | null = null;
const namedListeners = new Set<(threadId: string) => void>();
const SHELL_DECORATION_HISTORY_LIMIT = 512;
const decorationEpoch = NodeCrypto.randomUUID();
const latestDecorationByThread = new Map<string, number>();
let decorationRevision = 0;
let lastEvictedDecoration = 0;
const retitleListeners = new Set<(candidate: RetitleCandidate) => void>();
const titlesByHand = new Set<string>();
/** Requests that already renamed their chat: one rename per request, so titles can't flap. */
const retitledRequests = new Set<string>();
let onTitlesByHandChanged: (() => void) | null = null;

/** Calls `listener` with each chat that may take a new title; returns an unsubscribe. */
export function subscribeRetitle(listener: (candidate: RetitleCandidate) => void): () => void {
  retitleListeners.add(listener);
  return () => retitleListeners.delete(listener);
}

/** Chats the user (or an agent asked to) renamed: their titles are never replaced. */
export const boxTitles = {
  load(threadIds: ReadonlyArray<string>, onChange: () => void) {
    for (const threadId of threadIds) titlesByHand.add(threadId);
    onTitlesByHandChanged = onChange;
  },
  markByHand(threadId: string) {
    if (titlesByHand.has(threadId)) return;
    titlesByHand.add(threadId);
    onTitlesByHandChanged?.();
  },
  /** "Regenerate title" hands the title back to the app. */
  clearByHand(threadId: string) {
    if (titlesByHand.delete(threadId)) onTitlesByHandChanged?.();
  },
  isByHand(threadId: string): boolean {
    return titlesByHand.has(threadId);
  },
  byHand(): ReadonlyArray<string> {
    return [...titlesByHand];
  },
  /** Records that `requestId` renamed its chat. */
  retitled(requestId: string) {
    retitledRequests.add(requestId);
  },
};

/**
 * The title a chat should take now, or null to keep its own. It must still carry the title
 * the model read, not be a subagent's or archived, and have stayed on the new topic: a
 * second request agreed, or the agent has worked on this one for a while.
 */
export function autoTitleFor(input: {
  readonly candidate: RetitleCandidate;
  readonly thread: {
    readonly title: string;
    readonly archivedAt: unknown;
    readonly deletedAt: unknown;
    readonly lineage: { readonly relationshipToParent: string | null };
  };
  /** The chat's latest run: when it started, and when it ended if it has. */
  readonly latestRun: {
    readonly startedAtMs: number | null;
    readonly endedAtMs: number | null;
  } | null;
  readonly nowMs: number;
}): string | null {
  const { candidate, thread } = input;
  if (titlesByHand.has(candidate.threadId) || retitledRequests.has(candidate.requestId))
    return null;
  if (thread.archivedAt != null || thread.deletedAt != null) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (thread.title !== candidate.title) return null;
  const title = candidate.next.replace(/…$/u, "").trim();
  if (title.length < 3 || sameSessionTopic(title, thread.title)) return null;
  if (!candidate.settled) {
    // One request alone counts once the agent has spent a while on it, so a quick aside
    // ("what time is it there?") never renames the chat.
    const latest = entries.get(candidate.threadId);
    if (latest?.requestId !== candidate.requestId || (latest.retitle ?? null) === null) return null;
    const run = input.latestRun;
    if (run?.startedAtMs == null) return null;
    if ((run.endedAtMs ?? input.nowMs) - run.startedAtMs < AUTO_TITLE_WORK_MS) return null;
  }
  return title[0]!.toUpperCase() + title.slice(1);
}

/** Records non-event shell changes for both live delivery and reconnects. */
export function announceBoxChange(threadId: string) {
  latestDecorationByThread.delete(threadId);
  latestDecorationByThread.set(threadId, ++decorationRevision);
  if (latestDecorationByThread.size > SHELL_DECORATION_HISTORY_LIMIT) {
    const oldest = latestDecorationByThread.entries().next().value;
    if (oldest !== undefined) {
      latestDecorationByThread.delete(oldest[0]);
      lastEvictedDecoration = oldest[1];
    }
  }
  for (const listener of namedListeners) listener(threadId);
}

export function shellDecorationCursor(): ShellDecorationCursor {
  return { epoch: decorationEpoch, revision: decorationRevision };
}

export function shellDecorationChangesAfter(cursor: ShellDecorationCursor | undefined) {
  const since = cursor?.revision ?? 0;
  if (
    (cursor !== undefined && cursor.epoch !== decorationEpoch) ||
    since < lastEvictedDecoration ||
    since > decorationRevision
  ) {
    return null;
  }
  return {
    cursor: shellDecorationCursor(),
    threadIds: [...latestDecorationByThread]
      .filter(([, revision]) => revision > since)
      .map(([threadId]) => threadId),
  };
}

/** Calls `listener` with each chat the model has just named; returns an unsubscribe. */
export function subscribeBoxNamed(listener: (threadId: string) => void): () => void {
  namedListeners.add(listener);
  return () => namedListeners.delete(listener);
}

/**
 * The model's name and "now" line for a chat, and a request for fresh ones when its title
 * or latest request changed since the model last read it.
 */
export function lookupBoxNaming(threadId: string, basis: BoxNamerBasis): BoxNamerLookup | null {
  if (!active) return null;
  const entry = entries.get(threadId);
  const current = entry !== undefined && entry.requestId === basis.requestId;
  if (!current || entry.title !== basis.title) {
    const pending = wanted.get(threadId);
    if (pending?.requestId !== basis.requestId || pending.title !== basis.title) {
      // Re-adding moves the chat to the back, which `take` serves first.
      wanted.delete(threadId);
      wanted.set(threadId, basis);
      onWanted?.();
    }
  }
  if (entry === undefined) return null;
  return {
    name: entry.title === basis.title ? entry.name : null,
    now: current ? entry.now : undefined,
  };
}

export const boxNamerCache = {
  activate(saved: ReadonlyArray<readonly [string, BoxNamerEntry]>, notify: () => void) {
    for (const [threadId, entry] of saved) entries.set(threadId, entry);
    onWanted = notify;
    active = true;
  },
  isActive(): boolean {
    return active;
  },
  /** Queues a chat whose saved name doesn't match its current title and latest request. */
  want(threadId: string, basis: BoxNamerBasis) {
    const entry = entries.get(threadId);
    if (entry?.requestId === basis.requestId && entry.title === basis.title) return;
    wanted.set(threadId, basis);
    onWanted?.();
  },
  deactivate() {
    active = false;
    onWanted = null;
    wanted.clear();
  },
  /** The next chat to name, newest request first, or undefined when none waits. */
  take(): readonly [string, BoxNamerBasis] | undefined {
    const last = [...wanted].at(-1);
    if (last !== undefined) wanted.delete(last[0]);
    return last;
  },
  put(threadId: string, entry: BoxNamerEntry) {
    const previous = entries.get(threadId);
    entries.set(threadId, entry);
    if (
      previous?.name !== entry.name ||
      previous?.now !== entry.now ||
      previous?.title !== entry.title ||
      previous?.requestId !== entry.requestId
    ) {
      announceBoxChange(threadId);
    }
    const next = entry.retitle ?? null;
    if (next === null || titlesByHand.has(threadId)) return;
    const before = previous?.retitle ?? null;
    const candidate: RetitleCandidate = {
      threadId,
      requestId: entry.requestId,
      title: entry.title,
      next,
      settled:
        previous !== undefined &&
        previous.requestId !== entry.requestId &&
        before !== null &&
        sameSessionTopic(before, next),
    };
    for (const listener of retitleListeners) listener(candidate);
  },
  entries(): ReadonlyArray<readonly [string, BoxNamerEntry]> {
    return [...entries];
  },
};

import type { ChatTabView } from "@t3tools/client-runtime/state/chat-tabs";
import {
  sessionBoxDefaultFace,
  sessionBoxHue,
  sessionBoxTopic,
} from "@t3tools/shared/sessionBoxes";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { failureNeedsYou } from "@t3tools/client-runtime/state/thread-inbox";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";

type AttentionThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
  | "latestRun"
  | "updatedAt"
  | "lineage"
  | "lastVisitedAt"
  | "hasActionableProposedPlan"
>;

type Visits = Readonly<Record<string, string | undefined>>;

/** A failure counts only until the chat has been opened; see failureNeedsYou.
    `localLastVisitedAt` is this browser's own visit record for the chat. */
export function threadNeedsYouCount(
  thread: AttentionThread,
  localLastVisitedAt: string | undefined,
  now = Date.now(),
): number {
  const requests = Number(thread.hasPendingApprovals) + Number(thread.hasPendingUserInput);
  // A parent carries its children's request when those children aren't shown.
  if (requests > 0) return requests;
  if (thread.pendingSubagentRequest != null || thread.hasActionableProposedPlan) return 1;
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  return Number(failureNeedsYou({ ...thread, lastVisitedAt }, now));
}

export function threadIsUnread(
  thread: EnvironmentThreadShell,
  visits: Readonly<Record<string, string | undefined>>,
): boolean {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, visits[key]);
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) return true;
  const message = thread.source.latestVisibleMessage;
  if (!lastVisitedAt || message?.role !== "assistant") return false;
  const visitedAt = Date.parse(lastVisitedAt);
  return Number.isNaN(visitedAt) || DateTime.toEpochMillis(message.updatedAt) > visitedAt;
}

export function machineFilterVisible(threads: readonly { environmentId: string }[]): boolean {
  return new Set(threads.map((thread) => thread.environmentId)).size > 1;
}

/** Counts per `environmentId`, which a caller may have remapped to the
    machine a chat is shown under; `visitKey` then carries the chat's own key. */
export function machineAttentionCounts(
  threads: readonly (AttentionThread & { readonly visitKey?: string })[],
  visits: Visits,
  now = Date.now(),
): Map<string, number> {
  const counts = new Map<string, number>();
  const parentsWithChildren = new Set(
    threads
      .filter((thread) => thread.lineage.relationshipToParent === "subagent")
      .map((thread) => `${thread.environmentId}:${thread.lineage.parentThreadId}`),
  );
  for (const thread of threads) {
    const own = parentsWithChildren.has(`${thread.environmentId}:${thread.id}`)
      ? { ...thread, pendingSubagentRequest: null }
      : thread;
    const visitKey =
      thread.visitKey ?? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    counts.set(
      thread.environmentId,
      (counts.get(thread.environmentId) ?? 0) + threadNeedsYouCount(own, visits[visitKey], now),
    );
  }
  return counts;
}

export const DISCORD_CATEGORIES = [
  "pinned",
  "needsYou",
  "working",
  "recent",
  "snoozed",
  "settled",
] as const;
export type DiscordCategory = (typeof DISCORD_CATEGORIES)[number];
export const DISCORD_CATEGORY_LABELS: Record<DiscordCategory, string> = {
  pinned: "Pinned",
  needsYou: "Needs you",
  working: "Working",
  recent: "Chats",
  snoozed: "Snoozed",
  settled: "Settled",
};

export function discordCategory(input: {
  section: "pinned" | "active" | "working" | "snoozed" | "settled";
  needsYou: boolean;
  working: boolean;
}): DiscordCategory {
  if (input.section === "snoozed" || input.section === "settled" || input.section === "pinned")
    return input.section;
  if (input.needsYou) return "needsYou";
  return input.working ? "working" : "recent";
}

/** Nest only within an environment. Orphans remain reachable as channels. */
export function nestDiscordThreads<
  T extends Pick<EnvironmentThreadShell, "id" | "environmentId" | "lineage">,
>(threads: readonly T[]): { roots: T[]; children: Map<string, T[]> } {
  const keys = new Set(threads.map((thread) => `${thread.environmentId}:${thread.id}`));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parent = `${thread.environmentId}:${thread.lineage.parentThreadId}`;
    if (
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.parentThreadId !== thread.id &&
      keys.has(parent)
    ) {
      const siblings = children.get(parent) ?? [];
      siblings.push(thread);
      children.set(parent, siblings);
    } else roots.push(thread);
  }
  return { roots, children };
}

/** Search from the current position in the full sidebar order, then wrap. */
export function nextAttentionThreadKey(
  order: readonly string[],
  candidates: ReadonlySet<string>,
  current: string | null,
  direction: "next" | "previous",
): string | null {
  const step = direction === "next" ? 1 : -1;
  const index = current === null ? -1 : order.indexOf(current);
  const start = index < 0 ? (step === 1 ? -1 : 0) : index;
  for (let offset = 1; offset <= order.length; offset++) {
    const key = order[(start + step * offset + order.length) % order.length];
    if (key !== undefined && candidates.has(key)) return key;
  }
  return null;
}

export interface DiscordThreadNode {
  thread: EnvironmentThreadShell;
  children: DiscordThreadNode[];
  hiddenCount: number;
  expanded: boolean;
}

/** Keep the path to an active descendant even when its parent has gone quiet. */
export function buildDiscordThreadTree(
  root: EnvironmentThreadShell,
  children: ReadonlyMap<string, readonly EnvironmentThreadShell[]>,
  expanded: ReadonlySet<string>,
  visible: (thread: EnvironmentThreadShell) => boolean,
): DiscordThreadNode {
  const keyFor = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const containsVisible = (thread: EnvironmentThreadShell, seen: ReadonlySet<string>): boolean => {
    const key = keyFor(thread);
    if (seen.has(key)) return false;
    return (
      visible(thread) ||
      (children.get(key) ?? []).some((child) => containsVisible(child, new Set([...seen, key])))
    );
  };
  const build = (thread: EnvironmentThreadShell, seen: ReadonlySet<string>): DiscordThreadNode => {
    const key = keyFor(thread);
    const nextSeen = new Set([...seen, key]);
    const entries = (children.get(key) ?? []).filter((child) => !nextSeen.has(keyFor(child)));
    const shown = entries.filter((child) => expanded.has(key) || containsVisible(child, nextSeen));
    return {
      thread,
      expanded: expanded.has(key),
      hiddenCount: entries.length - shown.length,
      children: shown.map((child) => build(child, nextSeen)),
    };
  };
  return build(root, new Set());
}

export function flattenDiscordThreadTree(node: DiscordThreadNode): EnvironmentThreadShell[] {
  return [node.thread, ...node.children.flatMap(flattenDiscordThreadTree)];
}

/** Use the same topic paintings as chats, with stable initials if the art cannot load. */
export function discordServerIdentity(name: string) {
  const key = name.trim().toLocaleLowerCase("en-US");
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
  return {
    initials: initials || "S",
    hue: sessionBoxHue(key),
    face: sessionBoxDefaultFace(key, sessionBoxTopic(name)),
  };
}

export function discordServers(
  tabs: readonly ChatTabView[],
  threads: readonly EnvironmentThreadShell[],
  visits: Readonly<Record<string, string | undefined>>,
) {
  const byKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  return tabs.map((tab) => {
    const members = [...tab.threadKeys].flatMap((key) => {
      const thread = byKey.get(key);
      return thread ? [thread] : [];
    });
    return {
      tab,
      unread: members.some((thread) => threadIsUnread(thread, visits)),
      needsYou: [...machineAttentionCounts(members, visits).values()].reduce(
        (total, count) => total + count,
        0,
      ),
    };
  });
}

/** Preserve chat order within each machine and omit categories without channels. */
export function groupDiscordChannels<T>(
  entries: readonly T[],
  machines: readonly string[],
  machineOf: (entry: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const machine of machines) groups.set(machine, []);
  for (const entry of entries) {
    const machine = machineOf(entry);
    const group = groups.get(machine) ?? [];
    group.push(entry);
    groups.set(machine, group);
  }
  return new Map([...groups].filter(([, channels]) => channels.length > 0));
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  compareSessionBoxes,
  presentSessionBoxCached,
  sessionBoxConnectionPresentation,
  sessionBoxFacesFor,
  sessionBoxSiblingShare,
  type SessionBoxPresentation,
} from "@t3tools/client-runtime/state/session-boxes";

import {
  threadHasUnseenCompletion,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
  type ThreadListV2SearchListItem,
} from "../threads/threadListV2";

export interface SessionBoxEntry {
  readonly thread: EnvironmentThreadShell;
  readonly box: SessionBoxPresentation;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly snoozed: boolean;
  /** While searching: the words around the match inside the chat, if it matched there. */
  readonly match: string | null;
}

export type SessionBoxMenuActionKind =
  | "open"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "unsnooze"
  | "rename"
  | "archive";

export interface SessionBoxMenuActionSpec {
  readonly kind: SessionBoxMenuActionKind;
  readonly label: string;
  readonly destructive?: boolean;
}

export function resolveSessionBoxMenuActions(
  entry: Pick<SessionBoxEntry, "pinned" | "settled" | "snoozed">,
  capabilities: {
    readonly pinningSupported: boolean;
    readonly settlementSupported: boolean;
    readonly snoozeSupported: boolean;
  },
): ReadonlyArray<SessionBoxMenuActionSpec> {
  const actions: SessionBoxMenuActionSpec[] = [{ kind: "open", label: "Open" }];
  if (capabilities.pinningSupported) {
    actions.push(entry.pinned ? { kind: "unpin", label: "Unpin" } : { kind: "pin", label: "Pin" });
  }
  if (entry.snoozed) {
    if (capabilities.snoozeSupported) {
      actions.push({ kind: "unsnooze", label: "Unsnooze" });
    }
  } else if (capabilities.settlementSupported) {
    actions.push(
      entry.settled ? { kind: "unsettle", label: "Unsettle" } : { kind: "settle", label: "Settle" },
    );
  }
  actions.push(
    { kind: "rename", label: "Rename" },
    { kind: "archive", label: "Archive", destructive: true },
  );
  return actions;
}

export interface SessionBoxHeadingItem {
  readonly type: "box-heading";
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export interface SessionBoxRowItem {
  readonly type: "box-row";
  readonly key: string;
  readonly entries: ReadonlyArray<SessionBoxEntry>;
  /** What a recycled row compares: everything the boxes draw. */
  readonly signature: string;
}

import type { DiscordHeading } from "../discord/discordHeading";

export type HomeListItem =
  | DiscordHeading
  | ThreadListV2ListItem
  | ThreadListV2SearchListItem
  | SessionBoxHeadingItem
  | SessionBoxRowItem;

type Group = "pinned" | "needsYou" | "working" | "recent" | "results";
const GROUP_LABELS: Record<Group, string> = {
  pinned: "Pinned",
  needsYou: "Needs you",
  working: "Working",
  recent: "Recent",
  results: "Results",
};

/** A search snippet cut to start just before the query, so a one-line box shows it. */
export function matchExcerpt(snippet: string, query: string): string {
  const text = snippet.replace(/\s+/g, " ").trim();
  const at = query ? text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : -1;
  if (at <= 8) return text;
  const start = text.lastIndexOf(" ", at - 4);
  return `…${text.slice(start > 0 ? start + 1 : at - 8)}`;
}

function entrySignature(entry: SessionBoxEntry): string {
  const { box, thread } = entry;
  return [
    thread.environmentId,
    thread.id,
    thread.title,
    thread.runtime?.providerInstanceId ?? thread.modelSelection?.instanceId,
    thread.modelSelection?.model,
    box.label,
    box.now,
    box.status,
    box.statusShort,
    box.connectionStatus,
    box.tone,
    box.face,
    box.badge,
    box.mascot,
    box.hue,
    entry.pinned,
    entry.settled,
    entry.snoozed,
    entry.match,
  ].join("|");
}

function rows(prefix: string, entries: ReadonlyArray<SessionBoxEntry>, columns: number) {
  const result: SessionBoxRowItem[] = [];
  for (let start = 0; start < entries.length; start += columns) {
    const slice = entries.slice(start, start + columns);
    result.push({
      type: "box-row",
      key: `${prefix}:${start / columns}`,
      entries: slice,
      signature: slice.map(entrySignature).join("\n"),
    });
  }
  return result;
}

/**
 * Turns the home list into rows of session boxes. Live chats are grouped into what
 * needs you, what is working and the rest, each ranked by the needs-you model; pinned
 * chats keep their order on top. While searching, the matches stay boxes in one group,
 * in the list's own order, each showing where it matched. Shelves (snoozed, settled)
 * and unsent tasks keep their place and their own headers.
 */
export function buildSessionBoxListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly columns: number;
  readonly now: number;
  readonly connectionPhases?: ReadonlyMap<
    import("@t3tools/contracts").EnvironmentId,
    import("@t3tools/client-runtime/connection").EnvironmentConnectionPhase
  >;
  readonly search?: {
    readonly query: string;
    readonly snippetFor: (thread: EnvironmentThreadShell) => string | null;
  };
}): HomeListItem[] {
  const titles: string[] = [];
  for (const item of input.items)
    if (item.type === "v2-thread") titles.push(item.item.thread.title);
  const siblingShare = sessionBoxSiblingShare(titles);
  const faces = sessionBoxFacesFor(
    input.items.flatMap((item) => (item.type === "v2-thread" ? [item.item.thread] : [])),
  );
  const { search } = input;
  const entryFor = (
    item: Extract<ThreadListV2ListItem, { type: "v2-thread" }>,
  ): SessionBoxEntry => {
    const snippet = search?.snippetFor(item.item.thread) ?? null;
    return {
      thread: item.item.thread,
      pinned: item.item.pinned,
      settled: item.item.settled === true,
      snoozed: item.item.snoozed === true,
      match: snippet ? matchExcerpt(snippet, search?.query ?? "") : null,
      box: sessionBoxConnectionPresentation(
        presentSessionBoxCached(item.item.thread, {
          now: input.now,
          siblingShare,
          face: faces.get(item.item.thread.id),
          compact: true,
          unseen: threadHasUnseenCompletion(item.item.thread),
        }),
        input.connectionPhases?.get(item.item.thread.environmentId),
      ),
    };
  };

  const result: HomeListItem[] = [];
  const groups: Record<Group, SessionBoxEntry[]> = {
    pinned: [],
    needsYou: [],
    working: [],
    recent: [],
    results: [],
  };
  const pending: ThreadListV2ListItem[] = [];
  let shelf: string | null = null;
  let shelfEntries: SessionBoxEntry[] = [];
  const flushShelf = () => {
    if (shelf !== null) result.push(...rows(`box-${shelf}`, shelfEntries, input.columns));
    shelfEntries = [];
  };
  let mainEmitted = false;
  const emitMain = () => {
    if (mainEmitted) return;
    mainEmitted = true;
    for (const group of ["needsYou", "working", "recent"] as const) {
      groups[group].sort((left, right) =>
        compareSessionBoxes(
          { box: left.box, updatedAt: left.thread.updatedAt },
          { box: right.box, updatedAt: right.thread.updatedAt },
        ),
      );
    }
    for (const group of ["results", "pinned", "needsYou", "working", "recent"] as const) {
      const entries = groups[group];
      if (entries.length === 0) continue;
      result.push({
        type: "box-heading",
        key: `box-heading:${group}`,
        label: GROUP_LABELS[group],
        count: entries.length,
      });
      result.push(...rows(`box-${group}`, entries, input.columns));
    }
    result.push(...pending);
  };

  for (const item of input.items) {
    if (item.type === "v2-snoozed-shelf" || item.type === "v2-settled-shelf") {
      if (shelf === null) emitMain();
      else flushShelf();
      shelf = item.type === "v2-snoozed-shelf" ? "snoozed" : "settled";
      result.push(item);
      continue;
    }
    if (item.type === "v2-pending") {
      if (shelf === null) pending.push(item);
      else result.push(item);
      continue;
    }
    const entry = entryFor(item);
    if (shelf !== null) {
      shelfEntries.push(entry);
      continue;
    }
    const box = entry.box;
    const group: Group = search
      ? "results"
      : entry.pinned
        ? "pinned"
        : box.tone === "asking"
          ? "needsYou"
          : box.tone === "working"
            ? "working"
            : "recent";
    groups[group].push(entry);
  }
  if (shelf === null) emitMain();
  else flushShelf();
  return result;
}

export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  if (item.type === "discord-heading") {
    return (
      previous.type === "discord-heading" &&
      previous.label === item.label &&
      previous.count === item.count &&
      previous.expanded === item.expanded
    );
  }
  if (previous.type === "discord-heading") return false;
  if (item.type === "box-heading") {
    return (
      previous.type === "box-heading" &&
      previous.label === item.label &&
      previous.count === item.count
    );
  }
  if (item.type === "box-row") {
    return previous.type === "box-row" && previous.signature === item.signature;
  }
  if (previous.type === "box-heading" || previous.type === "box-row") return false;
  return threadListV2ListItemsAreEqual(previous, item);
}

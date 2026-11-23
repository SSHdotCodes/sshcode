import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { HomeListItem } from "../sessionBoxes/sessionBoxListItems";
import {
  resolveThreadListV2Status,
  resolveThreadListV2DisplayStatus,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";

import { DISCORD_CATEGORIES, type DiscordCategory, type DiscordHeading } from "./discordHeading";

export function discordHomeList(
  items: ReadonlyArray<ThreadListV2ListItem>,
  collapsed: ReadonlySet<string>,
  children: ReadonlyArray<EnvironmentThreadShell>,
  connectionPhases?: ReadonlyMap<
    import("@t3tools/contracts").EnvironmentId,
    import("@t3tools/client-runtime/connection").EnvironmentConnectionPhase
  >,
): ReadonlyArray<HomeListItem> {
  const groups = new Map<DiscordCategory, ThreadListV2ListItem[]>(
    DISCORD_CATEGORIES.map((name) => [name, []]),
  );
  const childrenByParent = new Map<string, EnvironmentThreadShell[]>();
  for (const child of children) {
    if (
      child.archivedAt !== null ||
      child.lineage.relationshipToParent !== "subagent" ||
      child.lineage.parentEnvironmentId !== undefined
    )
      continue;
    const key = `${child.environmentId}:${child.lineage.parentThreadId}`;
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(child);
    childrenByParent.set(key, siblings);
  }
  for (const item of items) {
    if (item.type === "v2-settled-shelf" || item.type === "v2-snoozed-shelf") {
      continue;
    }
    if (item.type === "v2-pending") {
      groups.get("Working")!.push(item);
      continue;
    }
    const status = resolveThreadListV2DisplayStatus(
      resolveThreadListV2Status(item.item.thread),
      connectionPhases?.get(item.item.thread.environmentId),
    );
    const category = item.item.snoozed
      ? "Snoozed"
      : item.item.settled
        ? "Settled"
        : item.item.pinned
          ? "Pinned"
          : ["approval", "input", "failed", "limited"].includes(status)
            ? "Needs you"
            : status === "working"
              ? "Working"
              : "Chats";
    groups.get(category)!.push(item);
  }
  const appendChildren = (
    row: ThreadListV2ListItem,
    ancestors: ReadonlySet<string>,
  ): ThreadListV2ListItem[] => {
    if (row.type !== "v2-thread") return [row];
    const thread = row.item.thread;
    const key = `${thread.environmentId}:${thread.id}`;
    if (ancestors.has(key)) return [];
    const path = new Set([...ancestors, key]);
    const descendants = (childrenByParent.get(key) ?? []).flatMap((child) =>
      appendChildren(
        {
          ...row,
          key: `v2-thread:${child.environmentId}:${child.id}`,
          item: { ...row.item, thread: child, pinned: false, snoozed: false, settled: false },
          hasQueuedMessages: false,
          face: undefined,
          timeLabel: "",
        },
        path,
      ),
    );
    if (
      ancestors.size > 0 &&
      descendants.length === 0 &&
      !["working", "waiting", "approval", "input", "failed", "limited"].includes(
        resolveThreadListV2Status(thread),
      )
    )
      return [];
    return [row, ...descendants];
  };
  return DISCORD_CATEGORIES.flatMap((label): HomeListItem[] => {
    const rows = groups.get(label)!;
    if (rows.length === 0) return [];
    const expanded = !collapsed.has(label);
    const heading: DiscordHeading = {
      type: "discord-heading",
      key: `discord-heading:${label}`,
      label,
      count: rows.length,
      expanded,
    };
    if (!expanded) return [heading];
    return [heading, ...rows.flatMap((row) => appendChildren(row, new Set()))];
  });
}

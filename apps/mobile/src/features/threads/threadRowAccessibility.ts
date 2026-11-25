import type { MenuAction } from "@react-native-menu/menu";

import type { ThreadListV2Status } from "./threadListV2";

const QUICK_ACTION_IDS = new Set([
  "mark-read",
  "mark-unread",
  "share",
  "settle",
  "unsettle",
  "unsnooze",
  "snooze",
  "pin",
  "unpin",
  "archive",
  "rename",
]);

/** Reuse the available menu actions so VoiceOver follows the same capability gates. */
export function threadRowAccessibilityActions(
  menu: ReadonlyArray<MenuAction>,
  canOperate: boolean,
): Array<{ name: string; label: string }> {
  if (!canOperate) return [];
  const flatten = (
    actions: ReadonlyArray<MenuAction>,
    parent?: string,
  ): Array<{ name: string; label: string }> =>
    actions.flatMap((action) => {
      if (action.attributes?.disabled || action.attributes?.hidden) return [];
      const label = [parent, action.title, action.subtitle].filter(Boolean).join(", ");
      if (action.subactions) return flatten(action.subactions, label);
      return action.id ? [{ name: action.id, label }] : [];
    });
  return flatten(menu.filter((action) => action.id && QUICK_ACTION_IDS.has(action.id)));
}

type DisplayStatus = ThreadListV2Status | "connecting" | "reconnecting" | "offline";

const SPOKEN_STATUS: Record<DisplayStatus, string> = {
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline",
  approval: "Approval needed",
  input: "Waiting for your input",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Usage limit reached",
  ready: "Ready",
};

function spokenSnoozeState(wakeLabel: string | undefined): string {
  if (!wakeLabel) return "Snoozed";
  const remaining = /^(\d+)(m|h|d)$/.exec(wakeLabel);
  if (!remaining) return `Snoozed, ${wakeLabel}`;
  const unit = remaining[2] === "m" ? "minute" : remaining[2] === "h" ? "hour" : "day";
  return `Snoozed, wakes in ${remaining[1]} ${unit}${remaining[1] === "1" ? "" : "s"}`;
}

export function threadRowAccessibilityLabel(input: {
  readonly title: string;
  readonly providerName?: string | undefined;
  readonly status: DisplayStatus;
  readonly goalActive: boolean;
  readonly unread: boolean;
  readonly queued: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly snoozed: boolean;
  readonly waitingLabel?: string | null | undefined;
  readonly wakeLabel?: string | undefined;
  readonly pullRequestLabel?: string | undefined;
}): string {
  return [
    input.title,
    input.providerName,
    input.status === "working" && input.goalActive
      ? "Working toward goal"
      : input.status === "waiting" || input.status === "ready"
        ? (input.waitingLabel ?? SPOKEN_STATUS[input.status])
        : SPOKEN_STATUS[input.status],
    input.unread ? "Unread" : null,
    input.queued ? "Messages queued to send" : null,
    input.pinned ? "Pinned" : null,
    input.settled ? "Settled" : null,
    input.snoozed ? spokenSnoozeState(input.wakeLabel) : null,
    input.pullRequestLabel,
  ]
    .filter(Boolean)
    .join(", ");
}

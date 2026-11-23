import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type NotificationItem = Extract<OrchestrationV2TurnItem, { type: "notification" }>;

// The server words a monitor's summary as "<what it watches>: <what happened>".
// The description may hold colons of its own, so what happened is matched by name.
const MONITOR_SUMMARY =
  /^([\s\S]*): (output|wakeOn disabled|no output for [^:]+|stopped(?:: output rate limit exceeded)?|timed out|exited with code -?\d+|exited on signal [^\s:]+|process failed|process disappeared without an exit receipt|ended: the server restarted[^:]*)$/;

export interface MonitorNotificationParts {
  readonly description: string;
  readonly event: string;
}

export function monitorNotificationParts(item: NotificationItem): MonitorNotificationParts | null {
  if (item.source.kind !== "monitor") return null;
  const match = MONITOR_SUMMARY.exec(item.summary);
  const description = match?.[1]?.trim() ?? "";
  const event = match?.[2];
  return event === undefined || description.length === 0 ? null : { description, event };
}

function monitorEventLead(event: string, updates: number): string | null {
  if (event === "output") return updates > 1 ? `${updates} updates` : null;
  if (event === "exited with code 0") return "Finished";
  if (event === "wakeOn disabled") return "Output matching off";
  return event.charAt(0).toUpperCase() + event.slice(1);
}

/**
 * Every row from one monitor opens with the same long description, and a
 * one-line row cuts off its end. What happened therefore leads the label.
 * `updates` is how many output reports the row stands for.
 */
export function monitorNotificationLabel(item: NotificationItem, updates = 1): string {
  const parts = monitorNotificationParts(item);
  if (parts === null) return item.summary;
  const lead = monitorEventLead(parts.event, updates);
  return lead === null ? parts.description : `${lead} · ${parts.description}`;
}

/** True when `next` is one more output report from the monitor that sent `first`. */
export function monitorUpdateContinues(first: NotificationItem, next: NotificationItem): boolean {
  return (
    first.outcome === "updated" &&
    next.outcome === "updated" &&
    first.runId === next.runId &&
    first.summary === next.summary &&
    monitorNotificationParts(first)?.event === "output"
  );
}

/** One row for a run of output reports: the first one's identity, all their output. */
export function mergeMonitorUpdates(items: ReadonlyArray<NotificationItem>): NotificationItem {
  const first = items[0]!;
  if (items.length === 1) return first;
  const last = items[items.length - 1]!;
  const detail = items
    .map((item) => item.detail?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
  return {
    ...last,
    id: first.id,
    ordinal: first.ordinal,
    startedAt: first.startedAt,
    summary: monitorNotificationLabel(first, items.length),
    detail,
  };
}

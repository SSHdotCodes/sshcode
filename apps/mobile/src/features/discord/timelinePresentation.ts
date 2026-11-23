import { isSingleRowReplacement } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { threadFeedRevision } from "../../lib/threadFeedProjection";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export interface TimelineDecoration {
  readonly day: string | null;
  readonly isNew: boolean;
  readonly grouped: boolean;
}

const localDay = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function timelineDayLabel(timestamp: string, now: Date): string {
  const date = new Date(timestamp);
  if (localDay(date) === localDay(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDay(date) === localDay(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Computed from the open-time watermark, never the visit acknowledgement. */
export function timelineDecorations(
  entries: ReadonlyArray<ThreadFeedEntry>,
  visitedAtOpen: string | null | undefined,
  now = new Date(),
): ReadonlyMap<string, TimelineDecoration> {
  const result = new Map<string, TimelineDecoration>();
  const visited = visitedAtOpen ? Date.parse(visitedAtOpen) : NaN;
  let newPlaced = false;
  let previousDay: string | null = null;
  let previousAuthor: string | null = null;
  let previousTime = NaN;
  for (const entry of entries) {
    if (entry.type !== "message") {
      previousAuthor = null;
      continue;
    }
    const message = entry.message;
    const date = new Date(message.createdAt);
    if (!Number.isFinite(date.getTime())) {
      previousAuthor = null;
      continue;
    }
    const day = localDay(date);
    const label =
      previousDay !== day && (previousDay !== null || day !== localDay(now))
        ? timelineDayLabel(message.createdAt, now)
        : null;
    const isNew: boolean =
      !newPlaced &&
      Number.isFinite(visited) &&
      message.role === "assistant" &&
      Date.parse(message.updatedAt) > visited;
    newPlaced ||= isNew;
    const author = `${message.role}:${message.senderThreadId ?? ""}:${message.createdBy ?? ""}`;
    const time = date.getTime();
    const grouped =
      !label &&
      !isNew &&
      previousAuthor === author &&
      time >= previousTime &&
      time - previousTime <= 7 * 60_000;
    result.set(entry.id, { day: label, isNew, grouped });
    previousDay = day;
    previousAuthor = author;
    previousTime = time;
  }
  return result;
}

/** Reuse decorations when an in-place stream update cannot change any boundary. */
export function createTimelineDecorationsProjector() {
  let previous:
    | {
        entries: ReadonlyArray<ThreadFeedEntry>;
        revision: ReturnType<typeof threadFeedRevision>;
        visitedAtOpen: string | null | undefined;
        day: string;
        result: ReadonlyMap<string, TimelineDecoration>;
      }
    | undefined;
  return (
    entries: ReadonlyArray<ThreadFeedEntry>,
    visitedAtOpen: string | null | undefined,
    now = new Date(),
  ) => {
    const revision = threadFeedRevision(entries);
    const day = localDay(now);
    if (previous && previous.visitedAtOpen === visitedAtOpen && previous.day === day) {
      if (revision.revision === previous.revision.revision) return previous.result;
      if (isSingleRowReplacement(previous.revision, revision) && revision.index !== null) {
        const old = previous.entries[revision.index];
        const next = entries[revision.index];
        const visited = visitedAtOpen ? Date.parse(visitedAtOpen) : NaN;
        if (
          old?.type === "message" &&
          next?.type === "message" &&
          old.id === next.id &&
          old.message.createdAt === next.message.createdAt &&
          old.message.role === next.message.role &&
          old.message.senderThreadId === next.message.senderThreadId &&
          old.message.createdBy === next.message.createdBy &&
          Date.parse(old.message.updatedAt) > visited ===
            Date.parse(next.message.updatedAt) > visited
        ) {
          previous = { entries, revision, visitedAtOpen, day, result: previous.result };
          return previous.result;
        }
      }
    }
    const result = timelineDecorations(entries, visitedAtOpen, now);
    previous = { entries, revision, visitedAtOpen, day, result };
    return result;
  };
}

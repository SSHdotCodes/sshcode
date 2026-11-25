import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  ServerConfig,
} from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;
export type ThreadFindAnchorReader = () => ThreadFindStart | undefined;

export function threadFindMode(
  config: Pick<ServerConfig, "threadFind" | "threadFindProgressive"> | null | undefined,
): "single" | "progressive" | null {
  if (config?.threadFind !== true) return null;
  return config.threadFindProgressive === true ? "progressive" : "single";
}

export function threadFindEntryId(projected: OrchestrationV2ProjectedTurnItem | undefined) {
  const item = projected?.item;
  if (item?.type === "user_message" || item?.type === "assistant_message") return item.messageId;
  if (item?.type === "proposed_plan") return item.id;
  return undefined;
}

function feedEntryId(row: ThreadFeedEntry | undefined) {
  if (row?.type === "message") return threadFindEntryId(row.message.projectedItem);
  if (row?.type === "activity-group" || row?.type === "work-toggle") {
    for (const activity of row.activities) {
      const id = threadFindEntryId(activity.projectedItem);
      if (id) return id;
    }
  }
  return undefined;
}

export function threadFindViewportStart(
  feed: ReadonlyArray<ThreadFeedEntry>,
  viewport: { readonly start: number; readonly end: number } | undefined,
): ThreadFindStart | undefined {
  if (viewport && viewport.start >= 0) {
    for (let index = viewport.start; index <= Math.min(viewport.end, feed.length - 1); index++) {
      const entryId = feedEntryId(feed[index]);
      if (entryId) return { entryId, occurrence: 0 };
    }
  }
  for (let index = feed.length - 1; index >= 0; index--) {
    const entryId = feedEntryId(feed[index]);
    if (entryId) return { entryId, occurrence: 0 };
  }
  return undefined;
}

import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

// These rows are pure timeline chrome whose rendered height is independent of
// their content. Content-driven rows must be measured by LegendList: returning
// a fixed size makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 42;
const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
  options: {
    /** A work group showing its tool calls' images under the toggle is content-sized. */
    readonly inlineImages?: boolean;
  } = {},
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return options.inlineImages ? undefined : WORK_GROUP_TOGGLE_HEIGHT;
    case "thinking":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "activity-group":
    case "message":
    case "agent-card":
    case "html-render":
    case "mcp-app":
      return undefined;
  }
}

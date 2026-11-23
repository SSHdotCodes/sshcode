import type { AppSymbolName } from "../../components/AppSymbol";
import type { StatusAccessoryItem } from "../../lib/statusAccessoryItems";
import type { WorkspaceConnectionState } from "../../state/workspaceModel";

export const STATUS_ACCESSORY_ITEM_INFO: Record<
  StatusAccessoryItem,
  { readonly title: string; readonly description: string; readonly icon: AppSymbolName }
> = {
  limits: {
    title: "Usage limits",
    description: "A ring per signed-in agent with the share used of its tightest limit.",
    icon: "chart.bar.xaxis",
  },
  connection: {
    title: "Connection",
    description: "Slow connections and connection problems with your computer.",
    icon: "wifi",
  },
  working: {
    title: "Working",
    description: "How many sessions are working right now.",
    icon: "bolt.circle",
  },
  needsYou: {
    title: "Needs you",
    description: "Sessions waiting on an approval or an answer.",
    icon: "bell.badge",
  },
  nextReset: {
    title: "Next reset",
    description: "When the tightest usage limit resets.",
    icon: "arrow.clockwise",
  },
};

export type ConnectionSummary = "connected" | "connecting" | "offline" | "none";

/** The one word the capsule says about the computers this phone talks to. */
export function summarizeConnection(state: WorkspaceConnectionState): ConnectionSummary {
  if (!state.hasConnections) return "none";
  if (state.networkStatus === "offline") return "offline";
  if (state.connectionState === "connected") return "connected";
  if (state.hasConnectingEnvironment || state.isLoadingConnections) return "connecting";
  return "offline";
}

/**
 * Items left to right while they fit the capsule; the rest drop off the end,
 * so a narrow phone keeps the first choices instead of clipping all of them.
 */
export function fitStatusAccessoryItems<T>(
  items: readonly T[],
  widthOf: (item: T) => number,
  available: number,
  gap: number,
): T[] {
  const shown: T[] = [];
  let used = 0;
  for (const item of items) {
    const width = widthOf(item) + (shown.length === 0 ? 0 : gap);
    if (used + width > available) break;
    shown.push(item);
    used += width;
  }
  return shown;
}

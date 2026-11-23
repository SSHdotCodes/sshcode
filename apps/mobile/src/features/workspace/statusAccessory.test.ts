import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceConnectionState } from "../../state/workspaceModel";
import {
  moveStatusAccessoryItem,
  resolveStatusAccessoryItems,
  sanitizeStatusAccessoryItems,
  statusAccessoryItemsNeedClock,
} from "../../lib/statusAccessoryItems";
import { fitStatusAccessoryItems, summarizeConnection } from "./statusAccessory";

const connected: WorkspaceConnectionState = {
  isLoadingConnections: false,
  hasConnections: true,
  hasReadyEnvironment: true,
  hasConnectingEnvironment: false,
  connectingEnvironments: [],
  connectionState: "connected",
  connectionError: null,
  networkStatus: "online",
};

describe("status accessory items", () => {
  it("keeps known items once, in the stored order", () => {
    expect(sanitizeStatusAccessoryItems(["working", "nope", "limits", "working"])).toEqual([
      "working",
      "limits",
    ]);
    expect(sanitizeStatusAccessoryItems("limits")).toBeUndefined();
  });

  it("defaults to limits and connection until the user chooses, even to show nothing", () => {
    expect(resolveStatusAccessoryItems(undefined)).toEqual(["limits", "connection"]);
    expect(resolveStatusAccessoryItems([])).toEqual([]);
  });

  it("moves items within bounds", () => {
    expect(moveStatusAccessoryItem(["limits", "connection", "working"], "working", -5)).toEqual([
      "working",
      "limits",
      "connection",
    ]);
  });

  it("needs the minute clock for every time-derived item, not just the countdown", () => {
    // The default items: the rings pool usage windows, so they tick too.
    expect(statusAccessoryItemsNeedClock(resolveStatusAccessoryItems(undefined))).toBe(true);
    expect(statusAccessoryItemsNeedClock(["limits", "nextReset"])).toBe(true);
    expect(statusAccessoryItemsNeedClock(["connection", "working", "needsYou"])).toBe(false);
    expect(statusAccessoryItemsNeedClock([])).toBe(false);
  });

  it("drops trailing items that do not fit", () => {
    const widths = { a: 30, b: 40, c: 20 } as const;
    expect(
      fitStatusAccessoryItems(["a", "b", "c"] as const, (item) => widths[item], 80, 6),
    ).toEqual(["a", "b"]);
  });

  it("summarizes the connection", () => {
    expect(summarizeConnection(connected)).toBe("connected");
    expect(summarizeConnection({ ...connected, networkStatus: "offline" })).toBe("offline");
    expect(
      summarizeConnection({
        ...connected,
        connectionState: "reconnecting",
        hasConnectingEnvironment: true,
      }),
    ).toBe("connecting");
    expect(summarizeConnection({ ...connected, hasConnections: false })).toBe("none");
  });
});

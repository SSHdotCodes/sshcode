// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { WorkspaceConnectionState } from "../../state/workspaceModel";
import { useConnectionAccessoryStatus } from "./useConnectionAccessoryStatus";

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
const connecting: WorkspaceConnectionState = {
  ...connected,
  hasReadyEnvironment: false,
  hasConnectingEnvironment: true,
  connectionState: "reconnecting",
};
let container: HTMLDivElement;
let root: Root;

function Probe(props: { readonly state: WorkspaceConnectionState }) {
  return <span>{useConnectionAccessoryStatus(props.state) ?? "quiet"}</span>;
}
function render(state: WorkspaceConnectionState) {
  act(() => root.render(<Probe state={state} />));
  return container.textContent;
}
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
  return container.textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("connection accessory", () => {
  it("keeps a quick connection quiet, including its brief unavailable phase", () => {
    expect(
      render({ ...connecting, connectionState: "available", hasConnectingEnvironment: false }),
    ).toBe("quiet");
    advance(20);
    expect(render(connecting)).toBe("quiet");
    advance(280);
    expect(render(connected)).toBe("quiet");
    expect(advance(1_000)).toBe("quiet");
  });

  it("shows a slow connection after the grace period and clears on recovery immediately", () => {
    render(connecting);
    expect(advance(799)).toBe("quiet");
    expect(advance(1)).toBe("connecting");
    // Recovery clears the warning immediately.
    expect(render(connected)).toBe("quiet");
    // A second interruption gets its own grace period.
    expect(render(connecting)).toBe("quiet");
    expect(advance(799)).toBe("quiet");
    expect(advance(1)).toBe("connecting");
  });

  it("surfaces network and authentication failures immediately", () => {
    expect(render({ ...connecting, networkStatus: "offline" })).toBe("offline");
    expect(
      render({
        ...connecting,
        connectionState: "error",
        hasConnectingEnvironment: false,
        connectionError: "Pair this computer again.",
      }),
    ).toBe("offline");
  });

  it("does not report a missing computer while the saved catalog loads", () => {
    render({ ...connecting, isLoadingConnections: true, hasConnections: false });
    expect(advance(2_000)).toBe("quiet");
    expect(render(connecting)).toBe("quiet");
    expect(advance(800)).toBe("connecting");
  });

  it("still explains an empty catalog once loaded", () => {
    render({ ...connected, hasConnections: false });
    expect(advance(800)).toBe("none");
  });
});

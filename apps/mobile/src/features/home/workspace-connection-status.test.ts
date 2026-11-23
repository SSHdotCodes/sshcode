import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusPresentation } from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(workspaceConnectionStatusPresentation(workspaceState())).toBeNull();
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "No internet connection",
      hasDetails: false,
      showsProgress: false,
    });
  });

  it("names the environment while reconnecting", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting to Julius’s Mac mini",
      hasDetails: false,
      showsProgress: true,
    });
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Can’t reach your Mac",
      hasDetails: true,
      showsProgress: false,
    });
  });

  it("keeps connection details discoverable during automatic retries", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      connectionError: "LAN timed out.",
      connectingEnvironments: [
        {
          environmentId: "mac" as never,
          environmentLabel: "Mac",
          displayUrl: "",
          isRelayManaged: true,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "LAN timed out.",
          connectionErrorTraceId: null,
        },
      ],
    });
    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      // The header's chevron stands in for "tap for details"; the words did not fit.
      label: "Reconnecting · saved chats",
      hasDetails: true,
      showsProgress: true,
    });
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing chats...",
      hasDetails: false,
      showsProgress: true,
    });
  });

  it("shows a failed sync even when cached rows and a ready connection remain", () => {
    expect(
      workspaceConnectionStatusPresentation(
        workspaceState({
          shellSnapshotError: "Snapshot failed",
          hasPendingShellSnapshot: true,
        }),
      ),
    ).toEqual({ label: "Couldn’t sync chats", hasDetails: true, showsProgress: false });
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Loading chats...",
      hasDetails: false,
      showsProgress: true,
    });
  });
});

function machine(
  connectionState: WorkspaceEnvironment["connectionState"],
  isEnabled = true,
): WorkspaceEnvironment {
  return {
    environmentId: "machine" as never,
    environmentLabel: "Mac",
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState,
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

describe("partially connected workspace title", () => {
  const retrying = workspaceState({
    hasConnectingEnvironment: true,
    connectingEnvironments: [machine("reconnecting")],
    connectionError: "Timed out",
  });
  it("counts connected machines instead of showing an overall retry spinner", () => {
    expect(
      workspaceConnectionStatusPresentation(retrying, [
        machine("connected"),
        machine("reconnecting"),
        machine("error"),
      ]),
    ).toEqual({
      label: "1 of 3 machines connected",
      showsProgress: false,
      hasDetails: true,
      symbol: "laptopcomputer",
    });
  });
  it("updates the real count as another machine connects", () => {
    expect(
      workspaceConnectionStatusPresentation(retrying, [
        machine("connected"),
        machine("connected"),
        machine("connecting"),
      ])?.label,
    ).toBe("2 of 3 machines connected");
  });
  it("excludes switched-off machines", () => {
    expect(
      workspaceConnectionStatusPresentation(retrying, [
        machine("connected"),
        machine("reconnecting"),
        machine("offline", false),
      ])?.label,
    ).toBe("1 of 2 machines connected");
    expect(
      workspaceConnectionStatusPresentation(workspaceState(), [
        machine("connected"),
        machine("offline", false),
      ]),
    ).toBeNull();
  });
  it("keeps the current retry text and spinner when none is connected", () => {
    expect(
      workspaceConnectionStatusPresentation(retrying, [machine("reconnecting"), machine("error")]),
    ).toMatchObject({ label: "Reconnecting · saved chats", showsProgress: true });
  });
  it("hides the title once every machine is connected", () => {
    expect(
      workspaceConnectionStatusPresentation(workspaceState(), [
        machine("connected"),
        machine("connected"),
      ]),
    ).toBeNull();
  });
  it("keeps offline reporting authoritative over a stale connected phase", () => {
    expect(
      workspaceConnectionStatusPresentation(workspaceState({ networkStatus: "offline" }), [
        machine("connected"),
        machine("offline"),
      ]),
    ).toMatchObject({ label: "No internet connection", showsProgress: false });
  });
});

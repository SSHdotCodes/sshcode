import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

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

describe("Home empty state", () => {
  it("says the list is empty only once a thread list has arrived", () => {
    expect(deriveHomeEmptyState(workspaceState())).toEqual({
      title: "No chats yet",
      detail: "Start a new chat with the compose button below.",
      loading: false,
    });
  });

  it("shows loading while a connected environment is still sending its threads", () => {
    expect(
      deriveHomeEmptyState(
        workspaceState({ hasLoadedShellSnapshot: false, hasPendingShellSnapshot: true }),
      ),
    ).toEqual({ title: "Loading chats", detail: "", loading: true });
  });

  it("shows a failed thread load instead of an empty list", () => {
    expect(
      deriveHomeEmptyState(
        workspaceState({ hasLoadedShellSnapshot: false, shellSnapshotError: "Request timed out" }),
      ),
    ).toEqual({ title: "Couldn't load chats", detail: "Request timed out", loading: false });
  });

  it("says why a machine that keeps failing to reconnect is unavailable, without a spinner", () => {
    expect(
      deriveHomeEmptyState(
        workspaceState({
          hasLoadedShellSnapshot: false,
          hasReadyEnvironment: false,
          hasConnectingEnvironment: true,
          connectionState: "reconnecting",
          connectionError: "Connection refused",
        }),
      ),
    ).toEqual({ title: "Environment unavailable", detail: "Connection refused", loading: false });
  });

  it("spins while a first connection attempt is under way", () => {
    expect(
      deriveHomeEmptyState(
        workspaceState({
          hasLoadedShellSnapshot: false,
          hasReadyEnvironment: false,
          hasConnectingEnvironment: true,
          connectionState: "connecting",
        }),
      ),
    ).toMatchObject({ title: "Connecting to environment", loading: true });
  });

  it("explains an unreachable environment that never sent threads", () => {
    expect(
      deriveHomeEmptyState(
        workspaceState({
          hasLoadedShellSnapshot: false,
          hasReadyEnvironment: false,
          connectionState: "offline",
        }),
      ),
    ).toMatchObject({ title: "Environment unavailable", loading: false });
  });
});

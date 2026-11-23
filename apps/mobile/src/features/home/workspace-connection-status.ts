import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  /** Short enough for the header beside its buttons; a long one is cut mid-word. */
  readonly label: string;
  /** Tapping opens the reason; the header shows a chevron instead of spelling that out. */
  readonly hasDetails: boolean;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
  readonly symbol?: "laptopcomputer";
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.shellSnapshotError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "No internet connection";
  if (state.connectionError !== null && state.hasConnectingEnvironment) {
    return state.hasLoadedShellSnapshot ? "Reconnecting · saved chats" : "Connecting";
  }
  if (state.connectionError !== null) return "Can’t reach your Mac";
  if (state.shellSnapshotError !== null) return "Couldn’t sync chats";
  if (state.connectingEnvironments.length === 1) {
    return `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    return `Reconnecting ${state.connectingEnvironments.length} environments`;
  }
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing chats..." : "Loading chats...";
  }
  return "Not connected";
}

/** Header-title presentation of the connection state, or null while connected. */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
  environments: readonly WorkspaceEnvironment[] = [],
): WorkspaceConnectionStatusPresentation | null {
  const machines = environments.filter((environment) => environment.isEnabled);
  const connected = machines.filter(
    (environment) => environment.connectionState === "connected",
  ).length;
  if (state.networkStatus !== "offline" && connected > 0 && connected < machines.length) {
    return {
      label: `${connected} of ${machines.length} machines connected`,
      hasDetails: state.connectionError !== null || state.shellSnapshotError !== null,
      showsProgress: false,
      symbol: "laptopcomputer",
    };
  }
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state),
    hasDetails:
      state.networkStatus !== "offline" &&
      (state.connectionError !== null || state.shellSnapshotError !== null),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.connectionError === null || state.hasConnectingEnvironment) &&
      state.shellSnapshotError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}

import type { WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
}

/**
 * What Home says while it has no threads to show. "No threads yet" is only
 * true once a thread list has arrived: before that the list is still
 * loading, or failed to load, and saying it is empty would be wrong.
 */
export function deriveHomeEmptyState(state: WorkspaceState): HomeEmptyState {
  if (state.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!state.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load its chats and start new chats.",
      loading: false,
    };
  }

  if (!state.hasLoadedShellSnapshot) {
    if (
      state.connectionState === "available" ||
      state.connectionState === "offline" ||
      state.connectionState === "error" ||
      state.connectionState === "unsupported"
    ) {
      return {
        title:
          state.connectionState === "unsupported"
            ? "Client not supported"
            : "Environment unavailable",
        detail:
          state.connectionError ??
          "The saved environment is offline. Check the URL or start the environment, then retry.",
        loading: false,
      };
    }
    if (state.shellSnapshotError !== null && !state.hasConnectingEnvironment) {
      return { title: "Couldn't load chats", detail: state.shellSnapshotError, loading: false };
    }
    if (state.hasConnectingEnvironment) {
      // A reconnect that keeps failing retries in the background for as long
      // as the machine is unreachable; say why instead of spinning forever.
      return state.connectionError !== null
        ? { title: "Environment unavailable", detail: state.connectionError, loading: false }
        : {
            title: "Connecting to environment",
            detail: "Loading chats from the saved environment.",
            loading: true,
          };
    }
    // Connected, with the thread list still on its way.
    return { title: "Loading chats", detail: "", loading: true };
  }

  // Chats need no project, so an environment without any is simply empty.
  return {
    title: "No chats yet",
    detail: "Start a new chat with the compose button below.",
    loading: false,
  };
}

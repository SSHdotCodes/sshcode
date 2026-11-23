import { useEffect, useState } from "react";

import type { WorkspaceConnectionState } from "../../state/workspaceModel";
import { summarizeConnection } from "./statusAccessory";

// Match the workspace header: routine reconnects finish before either surface appears.
const CONNECTION_STATUS_GRACE_MS = 800;

/** Keep routine startup and short reconnects quiet; known failures surface immediately. */
export function useConnectionAccessoryStatus(state: WorkspaceConnectionState) {
  const summary = state.isLoadingConnections ? null : summarizeConnection(state);
  const quiet = summary === null || summary === "connected";
  const [visible, setVisible] = useState(false);
  if (quiet && visible) setVisible(false);
  useEffect(() => {
    if (quiet) return;
    const timer = setTimeout(() => setVisible(true), CONNECTION_STATUS_GRACE_MS);
    return () => clearTimeout(timer);
  }, [quiet]);
  if (quiet) return null;
  if (state.networkStatus === "offline" || state.connectionError !== null) return summary;
  return visible ? summary : null;
}

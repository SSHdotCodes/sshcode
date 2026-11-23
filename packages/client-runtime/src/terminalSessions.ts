// @effect-diagnostics globalDate:off -- Pure client relative labels accept an injectable clock.
import type { ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";

export const TERMINAL_SESSION_LABEL = "Terminal session";
/** Older servers omit `claudeRemoteControl`. Do not call the Remote Control RPCs. */
export const TERMINAL_HOST_UPDATE_MESSAGE =
  "Update SSHCode on this machine to use Terminal sessions.";
export const TERMINAL_MESSAGE_MAX_LENGTH = 100_000;

export type TerminalHostPhase =
  | "ready"
  | "loading"
  | "unsupported"
  | "disconnected"
  | "reconnecting"
  | "absent";

/**
 * One host only. All uses the primary host so the same Claude login is not
 * listed once for every connected computer. A chosen machine replaces that.
 */
export function terminalListEnvironmentId(
  selectedMachineId: string | null,
  primaryEnvironmentId: EnvironmentId | null,
  environmentIds: readonly EnvironmentId[],
  /** This client has a machine of its own that has not registered yet: wait for it. */
  primaryPending = false,
): EnvironmentId | null {
  if (selectedMachineId !== null && selectedMachineId !== "all") {
    return environmentIds.find((id) => id === selectedMachineId) ?? null;
  }
  if (primaryEnvironmentId !== null && environmentIds.some((id) => id === primaryEnvironmentId)) {
    return primaryEnvironmentId;
  }
  // Another saved machine can load first after a restart. Listing its sessions
  // as "All" would show the wrong computer until this one arrives.
  if (primaryPending) return null;
  return environmentIds[0] ?? null;
}

export function terminalHostPhase(input: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly configLoaded: boolean;
  readonly claudeRemoteControl: boolean | undefined;
  /** No machine yet because this client's own one is still starting. */
  readonly starting?: boolean;
}): { readonly phase: TerminalHostPhase; readonly message: string | null } {
  if (input.environmentId === null) {
    return input.starting === true
      ? { phase: "loading", message: null }
      : { phase: "absent", message: "No machine is connected." };
  }
  if (!input.connected) {
    return input.connecting
      ? { phase: "reconnecting", message: "Reconnecting…" }
      : {
          phase: "disconnected",
          message: "Disconnected. Sessions appear again when this machine reconnects.",
        };
  }
  if (!input.configLoaded) return { phase: "loading", message: null };
  if (input.claudeRemoteControl !== true) {
    return { phase: "unsupported", message: TERMINAL_HOST_UPDATE_MESSAGE };
  }
  return { phase: "ready", message: null };
}

/** Local title filter. Session ids are unique across hosts that share a Claude login. */
export function filterTerminalSessions(
  sessions: readonly ClaudeRcSession[],
  query: string,
): readonly ClaudeRcSession[] {
  const seen = new Set<string>();
  const unique: ClaudeRcSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  const needle = query.trim().toLocaleLowerCase();
  const matched =
    needle.length === 0
      ? unique
      : unique.filter((session) => session.title.toLocaleLowerCase().includes(needle));
  return matched.sort(
    (left, right) =>
      Number(right.working) - Number(left.working) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function terminalSessionRelativeTime(at: string, now = Date.now()): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return "";
  const minutes = Math.max(0, Math.floor((now - parsed) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

/** Keep the draft when the send fails. Clear it only when that same draft succeeded. */
export function composerTextAfterSend(current: string, draft: string, success: boolean): string {
  if (!success) return current;
  return current.trim() === draft ? "" : current;
}

export function terminalCommandFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

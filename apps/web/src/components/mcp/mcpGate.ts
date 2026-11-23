import {
  type AuthClientSession,
  type OutsideAgentSignIn,
  type AuthMcpClientAccess,
  type AuthSessionState,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  sessionGrantsScope,
} from "@t3tools/contracts";

/** This is a UI gate. The existing server commands still authorize every change and approval. */
export function resolveMcpGate(input: {
  readonly connected: boolean;
  readonly canAccept: boolean;
  readonly canEnable: boolean;
  readonly outsideAgents: boolean | undefined;
  readonly mcpUrl: string | null;
  readonly publicUrl: string | null;
  readonly needsPublicUrl: boolean;
  readonly connectAvailable: boolean;
}) {
  if (!input.connected) return "disconnected";
  if (input.outsideAgents === undefined) return "checking";
  if (!input.canAccept) return "no-permission";
  if (input.needsPublicUrl && input.publicUrl === null)
    return input.connectAvailable ? "public-address-needed" : "connect-unavailable";
  if (!input.outsideAgents) return input.canEnable ? "turn-on" : "no-settings-permission";
  if (input.mcpUrl === null) return "no-address";
  return "open";
}

/** Setup suggests an access level; the owner still confirms it in the sign-in prompt. */
export function canSuggestMcpAccess(session: AuthSessionState | null, access: AuthMcpClientAccess) {
  if (session === null || !sessionGrantsScope(session, AuthOrchestrationReadScope)) return false;
  if (access === "read-only") return true;
  if (!sessionGrantsScope(session, AuthOrchestrationOperateScope)) return false;
  return (
    access !== "full-access" ||
    (sessionGrantsScope(session, AuthSettingsWriteScope) &&
      sessionGrantsScope(session, AuthSourceControlWriteScope))
  );
}

/** Relay discovery supplies the public address. Strip path, query and fragment before copying. */
export function resolvePublicMcpUrl(input: {
  readonly relayBaseUrl?: string | undefined;
}): string | null {
  if (!input.relayBaseUrl) return null;
  try {
    const url = new URL(input.relayBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.pathname = "/mcp";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export interface McpApprovalPreference {
  readonly access: AuthMcpClientAccess;
  readonly startedAt: number;
  readonly expiresAt: number;
}

/** Old sign-ins and later sign-in windows keep the fork's existing supervised default. */
export function suggestedMcpAccess(
  preference: McpApprovalPreference | null,
  signIn: OutsideAgentSignIn,
  now: number,
): AuthMcpClientAccess {
  return preference !== null &&
    now < preference.expiresAt &&
    signIn.requestedAt >= preference.startedAt &&
    signIn.requestedAt < preference.expiresAt
    ? preference.access
    : "approval-required";
}

/** Owner approval alone is not a completed OAuth login; wait for a newly issued MCP session. */
export function mcpSignInCompleted(
  clients: readonly Pick<AuthClientSession, "subject" | "client" | "issuedAt">[],
  approved: OutsideAgentSignIn | null,
): boolean {
  return (
    approved !== null &&
    clients.some(
      (client) =>
        client.subject === "mcp-client" &&
        // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- AuthClientSession.client is display metadata, not an RPC client
        client.client.label === approved.clientName &&
        client.issuedAt.epochMilliseconds >= approved.requestedAt,
    )
  );
}

import type { EnvironmentId } from "@t3tools/contracts";
import type { McpApprovalPreference } from "./mcpGate";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";

// A suggestion on this client only. It carries no credential and never approves a request.
export const mcpApprovalPreferenceAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<McpApprovalPreference | null>(null).pipe(Atom.keepAlive),
);

export function rememberMcpApprovalPreference(
  environmentId: EnvironmentId,
  preference: McpApprovalPreference,
) {
  appAtomRegistry.set(mcpApprovalPreferenceAtom(environmentId), preference);
}

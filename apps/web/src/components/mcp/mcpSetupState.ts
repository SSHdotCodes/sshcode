import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const mcpSetupRequestAtom = Atom.make<{
  readonly environmentId: EnvironmentId | null;
} | null>(null).pipe(Atom.keepAlive);
export const activeMcpSetupEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
);

export function openUseInAnotherApp(environmentId: EnvironmentId | null) {
  appAtomRegistry.set(mcpSetupRequestAtom, { environmentId });
}
export const closeMcpSetup = () => appAtomRegistry.set(mcpSetupRequestAtom, null);

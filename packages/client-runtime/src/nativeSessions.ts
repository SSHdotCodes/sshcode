import type * as Atom from "effect/reactivity/Atom";
import { WS_METHODS, type TerminalHandoffStatus } from "@t3tools/contracts";
import type * as EnvironmentRegistry from "./connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./state/runtime.ts";

export function terminalHandoffSendBlock(status: TerminalHandoffStatus | null): string | null {
  return status?.phase === "in-terminal"
    ? "This chat is open in Terminal. Bring it back to send here."
    : status?.phase === "handing-off"
      ? "Handing this chat to Terminal…"
      : null;
}

export function createTerminalHandoffEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "terminal handoff status",
      tag: WS_METHODS.terminalHandoffStatus,
      idleTtlMs: 0,
      resubscribeOnWakeup: true,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "open in Terminal",
      tag: WS_METHODS.terminalHandoffOpen,
    }),
    bringBack: createEnvironmentRpcCommand(runtime, {
      label: "bring back from Terminal",
      tag: WS_METHODS.terminalHandoffReturn,
    }),
  };
}

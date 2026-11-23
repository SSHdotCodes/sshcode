import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  createTerminalHandoffEnvironmentAtoms,
  terminalHandoffSendBlock,
} from "@t3tools/client-runtime/native-sessions";
import { connectionAtomRuntime } from "../connection/runtime";
import { readLocalApi } from "../localApi";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { useEnvironment } from "./environments";

const terminal = createTerminalHandoffEnvironmentAtoms(connectionAtomRuntime);
export function useTerminalHandoff(ref: ScopedThreadRef | null) {
  const environment = useEnvironment(ref?.environmentId ?? null);
  const supported = environment?.serverConfig?.environment.capabilities.terminalHandoff === true;
  const status = useEnvironmentQuery(
    supported && ref
      ? terminal.status({ environmentId: ref.environmentId, input: { threadId: ref.threadId } })
      : null,
  ).data;
  const allowed = useAtomValue(terminal.open.permissionAtom(ref?.environmentId ?? null));
  const open = useAtomCommand(terminal.open);
  const bringBack = useAtomCommand(terminal.bringBack);
  const local =
    environment !== null &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target));
  const unavailableReason = !local
    ? "Available on the local Mac"
    : !supported
      ? "Available on the local Mac"
      : status
        ? status.unavailableReason
        : "Checking CLI session…";
  return {
    status,
    showAction: status?.unavailableReason !== "This CLI cannot resume chats",
    allowed,
    unavailableReason,
    blockReason: terminalHandoffSendBlock(status),
    open: async () => {
      if (ref && allowed && status?.phase === "here" && unavailableReason === null)
        await open({ environmentId: ref.environmentId, input: { threadId: ref.threadId } });
    },
    bringBack: async () => {
      if (
        !ref ||
        !allowed ||
        !(await readLocalApi()?.dialogs.confirm(
          "Quit the CLI in Terminal first, then bring it back",
        ))
      )
        return;
      await bringBack({ environmentId: ref.environmentId, input: { threadId: ref.threadId } });
    },
  };
}

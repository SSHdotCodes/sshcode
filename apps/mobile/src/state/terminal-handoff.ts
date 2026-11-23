import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalHandoffEnvironmentAtoms,
  terminalHandoffSendBlock,
} from "@t3tools/client-runtime/native-sessions";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Alert } from "react-native";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

const terminal = createTerminalHandoffEnvironmentAtoms(connectionAtomRuntime);
export function useTerminalHandoff(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  supported: boolean,
) {
  const status = useEnvironmentQuery(
    supported ? terminal.status({ environmentId, input: { threadId } }) : null,
  ).data;
  const allowed = useAtomValue(terminal.bringBack.permissionAtom(environmentId));
  const bringBack = useAtomCommand(terminal.bringBack);
  return {
    status,
    allowed,
    blockReason: terminalHandoffSendBlock(status),
    bringBack: () =>
      Alert.alert("Bring back", "Quit the CLI in Terminal first, then bring it back", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Bring back",
          onPress: () => {
            void bringBack({ environmentId, input: { threadId } });
          },
        },
      ]),
  };
}

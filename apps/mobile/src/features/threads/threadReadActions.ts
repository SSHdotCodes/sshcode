import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export type ThreadReadAction = "mark-read" | "mark-unread";

export function threadReadMenuAction(
  thread: Pick<EnvironmentThreadShell, "lastVisitedAt">,
  unread: boolean,
) {
  // This field is absent on servers that predate visited tracking.
  if (thread.lastVisitedAt === undefined) return null;
  return unread
    ? { id: "mark-read" as const, title: "Mark read", image: "envelope.open" }
    : { id: "mark-unread" as const, title: "Mark unread", image: "envelope.badge" };
}

export function useThreadReadAction() {
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const unread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const inFlightRef = useRef(new Set<string>());

  return useCallback(
    async (thread: EnvironmentThreadShell, action: ThreadReadAction): Promise<boolean> => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightRef.current.has(key)) return false;
      const title = action === "mark-read" ? "Could not mark read" : "Could not mark unread";
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
        Alert.alert(title, "This connection cannot change chat read markers.");
        return false;
      }
      if (
        appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)?.environment
          .capabilities.threadVisitedTracking !== true
      ) {
        Alert.alert(title, "This environment does not support read markers.");
        return false;
      }
      if (action === "mark-read" && Number.isNaN(Date.parse(thread.updatedAt))) {
        Alert.alert(title, "The chat's latest update is unavailable. Try again.");
        return false;
      }
      inFlightRef.current.add(key);
      try {
        const result =
          action === "mark-read"
            ? await visit({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, visitedAt: thread.updatedAt },
              })
            : await unread({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag !== "Success") {
          const error = Cause.squash(result.cause);
          Alert.alert(title, error instanceof Error ? error.message : "Please try again.");
          return false;
        }
        void Haptics.selectionAsync().catch(() => undefined);
        return true;
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [unread, visit],
  );
}

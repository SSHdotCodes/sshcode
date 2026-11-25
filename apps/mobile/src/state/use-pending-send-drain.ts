import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { subscribeNetworkRecovery } from "../connection/network-recovery";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  acknowledgedSideChatsAtom,
  acknowledgedUserInputKeysAtom,
  pendingSends,
} from "./pending-sends";
import {
  isClosedRuntimeRequestError,
  isClosedRuntimeRequestMessage,
  pendingSendKey,
} from "./pending-send-model";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentsWithScope } from "./session";
import { serverEnvironment } from "./server";
import { threadEnvironment } from "./threads";
import { createPendingDeliveryRetries } from "./pending-delivery-retries";
import { shouldRetryThreadOutboxDelivery } from "./thread-outbox-model";
import { useAtomCommand } from "./use-atom-command";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

const options = { reportFailure: false, reportDefect: false } as const;

export function usePendingSendDrain(): void {
  const openSideChat = useAtomCommand(serverEnvironment.openSideChat, options);
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, options);
  const sends = useAtomValue(pendingSends.sendsAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const allowed = useEnvironmentsWithScope(connectedEnvironments, AuthOrchestrationOperateScope);
  const active = useRef(new Set<string>());
  const acknowledged = useAtomValue(pendingSends.acknowledgedIdsAtom);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  const [retries] = useState(() =>
    createPendingDeliveryRetries(() => setTick((value) => value + 1)),
  );
  const wake = useCallback(() => {
    retries.reset();
    if (mounted.current) setTick((value) => value + 1);
  }, [retries]);
  useEffect(() => {
    mounted.current = true;
    let loaded: Promise<void> | undefined;
    const load = (): Promise<void> =>
      (loaded ??= pendingSends.load().catch(() => {
        loaded = undefined;
        if (!mounted.current) return;
        Alert.alert(
          "Some pending sends could not be loaded",
          "Your saved sends are still on this phone.",
          [
            { text: "Dismiss", style: "cancel" },
            { text: "Retry", onPress: () => void load() },
          ],
        );
      }));
    void load();
    const unsubscribe = subscribeNetworkRecovery(() => {
      wake();
      void load();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      retries.reset();
    };
  }, [retries, wake]);
  useEffect(() => {
    retries.observeConnections(connectedEnvironments);
  }, [connectedEnvironments, retries]);
  useEffect(() => {
    retries.prune(new Set(sends.map((send) => send.id)));
    for (const send of sends) {
      if (active.current.has(send.id) || retries.waiting(send.id)) continue;
      const cleanupOnly =
        acknowledged.has(send.id) ||
        (send.kind === "user-input" && send.error && isClosedRuntimeRequestMessage(send.error));
      if (
        !cleanupOnly &&
        (send.error ||
          !allowed.has(send.environmentId) ||
          !connectedEnvironments.some(
            (env) =>
              env.environmentId === send.environmentId && env.connectionState === "connected",
          ))
      )
        continue;
      const retry = retries.onFailure(send.id, send.environmentId);
      active.current.add(send.id);
      const deliver = async () => {
        if (!cleanupOnly) {
          if (!readEnvironmentScope(send.environmentId, AuthOrchestrationOperateScope)) return;
          const result =
            send.kind === "side-question"
              ? await openSideChat({
                  environmentId: send.environmentId,
                  input: {
                    threadId: send.threadId,
                    prompt: send.prompt,
                    messageId: send.id,
                  },
                })
              : await respondToUserInput({
                  environmentId: send.environmentId,
                  input: {
                    commandId: send.id,
                    threadId: send.threadId,
                    requestId: send.requestId,
                    answers: send.answers,
                    ...(send.attachmentsByQuestionId
                      ? { attachmentsByQuestionId: send.attachmentsByQuestionId }
                      : {}),
                  },
                });
          if (result._tag === "Failure") {
            const cause: Cause.Cause<unknown> = result.cause;
            const error = Cause.squash(cause);
            if (
              Cause.hasInterruptsOnly(cause) ||
              shouldRetryThreadOutboxDelivery(error) ||
              (typeof error === "object" &&
                error !== null &&
                "reason" in error &&
                error.reason === "busy")
            ) {
              throw error;
            }
            if (send.kind === "user-input" && isClosedRuntimeRequestError(error)) {
              pendingSends.acknowledge(send);
              await pendingSends.remove(send);
              retries.clear(send.id);
              return;
            }
            await pendingSends.fail(
              send,
              error instanceof Error ? error.message : "Could not send. Try again.",
            );
            return;
          }
          pendingSends.acknowledge(send);
          if (send.kind === "user-input") {
            appAtomRegistry.set(
              acknowledgedUserInputKeysAtom,
              new Set([
                ...appAtomRegistry.get(acknowledgedUserInputKeysAtom),
                pendingSendKey(send),
              ]),
            );
          }
          if (send.kind === "side-question" && "sideChatId" in result.value) {
            const key = scopedThreadKey(send.environmentId, send.threadId);
            appAtomRegistry.set(acknowledgedSideChatsAtom, {
              ...appAtomRegistry.get(acknowledgedSideChatsAtom),
              [key]: result.value,
            });
          }
        }
        await pendingSends.remove(send);
        retries.clear(send.id);
      };
      void deliver()
        .catch(retry)
        .finally(() => {
          active.current.delete(send.id);
          if (mounted.current) setTick((value) => value + 1);
        });
    }
  }, [
    acknowledged,
    allowed,
    connectedEnvironments,
    openSideChat,
    respondToUserInput,
    retries,
    sends,
    tick,
  ]);
}

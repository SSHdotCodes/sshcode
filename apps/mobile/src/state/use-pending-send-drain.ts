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
import { shouldRetryThreadOutboxDelivery, threadOutboxRetryDelayMs } from "./thread-outbox-model";
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
  const acknowledged = useRef(new Set<string>());
  const retries = useRef(new Map<string, { attempt: number; after: number }>());
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  const wake = useCallback(() => {
    retries.current.clear();
    if (mounted.current) setTick((value) => value + 1);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const load = () =>
      pendingSends.load().catch(() => {
        if (!mounted.current) return;
        Alert.alert(
          "Some pending sends could not be loaded",
          "Your saved sends are still on this phone.",
          [
            { text: "Dismiss", style: "cancel" },
            { text: "Retry", onPress: () => void load() },
          ],
        );
      });
    void load();
    const unsubscribe = subscribeNetworkRecovery(() => {
      wake();
      void load();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [wake]);
  const connectedKey = connectedEnvironments
    .filter((env) => env.connectionState === "connected")
    .map((env) => env.environmentId)
    .sort()
    .join(",");
  useEffect(wake, [connectedKey, wake]);
  useEffect(() => {
    let nextRetry = Number.POSITIVE_INFINITY;
    for (const send of sends) {
      // Saved before this check existed: an answer to a card that is already closed.
      if (send.error && send.kind === "user-input" && isClosedRuntimeRequestMessage(send.error)) {
        void pendingSends.remove(send).catch(() => undefined);
        continue;
      }
      if (
        send.error ||
        active.current.has(send.id) ||
        !allowed.has(send.environmentId) ||
        !connectedEnvironments.some(
          (env) => env.environmentId === send.environmentId && env.connectionState === "connected",
        )
      )
        continue;
      const after = retries.current.get(send.id)?.after ?? 0;
      if (after > Date.now()) {
        nextRetry = Math.min(nextRetry, after);
        continue;
      }
      active.current.add(send.id);
      const deliver = async () => {
        if (!readEnvironmentScope(send.environmentId, AuthOrchestrationOperateScope)) return;
        if (!acknowledged.current.has(send.id)) {
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
              await pendingSends.remove(send);
              acknowledged.current.delete(send.id);
              retries.current.delete(send.id);
              return;
            }
            await pendingSends.fail(
              send,
              error instanceof Error ? error.message : "Could not send. Try again.",
            );
            return;
          }
          acknowledged.current.add(send.id);
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
        acknowledged.current.delete(send.id);
        retries.current.delete(send.id);
      };
      void deliver()
        .catch(() => {
          const attempt = (retries.current.get(send.id)?.attempt ?? 0) + 1;
          retries.current.set(send.id, {
            attempt,
            after: Date.now() + threadOutboxRetryDelayMs(attempt),
          });
        })
        .finally(() => {
          active.current.delete(send.id);
          if (mounted.current) setTick((value) => value + 1);
        });
    }
    if (!Number.isFinite(nextRetry)) return;
    const timer = setTimeout(
      () => setTick((value) => value + 1),
      Math.max(0, nextRetry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [allowed, connectedEnvironments, openSideChat, respondToUserInput, sends, tick]);
}

import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  attachmentTokenAllowance,
  estimateTextTokens,
  historicalMessage,
} from "@t3tools/provider-core/server/handoffBudget";

/** Context accepted by this native transcript, excluding refused prompts and replaced sessions. */
export function nativeContextState(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns" | "contextHandoffs"
  >;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly run: OrchestrationV2Run;
  readonly nativeThreadId: string | null | undefined;
  readonly recoveringPromptOfRunId?: OrchestrationV2Run["id"] | undefined;
}) {
  const { projection, providerThread, run, nativeThreadId } = input;
  const sameNativeThread = providerThread.nativeThreadRef?.nativeId === nativeThreadId;
  const rolledBackRunIds = new Set(
    projection.runs.filter((source) => source.status === "rolled_back").map((source) => source.id),
  );
  const settledHandoffs = projection.contextHandoffs.filter(
    (handoff) =>
      !rolledBackRunIds.has(handoff.targetRunId) &&
      handoff.toProviderThreadId === providerThread.id &&
      handoff.delivery?.nativeThreadId === nativeThreadId &&
      handoff.delivery?.status !== "pending",
  );
  const deliveredItemIds = new Set(
    settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
  );
  // A handoff may deliver an item shortened: the native thread holds that much of it.
  const deliveredBytes = new Map<string, number>();
  for (const handoff of settledHandoffs) {
    const delivered = new Set<string>(handoff.delivery?.itemIds ?? []);
    for (const message of handoff.history?.messages ?? [])
      if (delivered.has(message.itemId))
        deliveredBytes.set(message.itemId, Buffer.byteLength(message.text));
  }
  const coveredItemIds = new Set([
    ...deliveredItemIds,
    ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
  ]);
  const deliveredAttemptIds = new Set(
    projection.providerTurns.filter((turn) => !turn.promptDropped).map((turn) => turn.runAttemptId),
  );
  const acceptedAttempts = projection.attempts.filter(
    (source) =>
      !rolledBackRunIds.has(source.runId) &&
      source.providerThreadId === providerThread.id &&
      deliveredAttemptIds.has(source.id),
  );
  const recoverySourceByRun = new Map(
    projection.runs.flatMap((run) =>
      run.promptRecoveryOfRunId === undefined ? [] : [[run.id, run.promptRecoveryOfRunId] as const],
    ),
  );
  const nativeInputRunIds = new Set<OrchestrationV2Run["id"]>();
  const legacyInputRunIds = new Set<OrchestrationV2Run["id"]>();
  const recoveredPromptRunIds = new Set<OrchestrationV2Run["id"]>();
  for (const attempt of acceptedAttempts) {
    if (attempt.nativeThreadId !== undefined && attempt.nativeThreadId !== nativeThreadId) continue;
    const recovered =
      attempt.reason === "steering_restart" ? undefined : recoverySourceByRun.get(attempt.runId);
    if (recovered !== undefined) recoveredPromptRunIds.add(recovered);
    const inputRuns = attempt.nativeThreadId === undefined ? legacyInputRunIds : nativeInputRunIds;
    inputRuns.add(recovered ?? attempt.runId);
  }
  const steeringAttemptIds = new Set(
    projection.attempts
      .filter((attempt) => attempt.reason === "steering_restart")
      .map((attempt) => attempt.id),
  );
  const legacyRecoveredRunIds = new Set(
    projection.runs
      .filter(
        (source) =>
          source.providerThreadId === providerThread.id &&
          settledHandoffs.some(
            (handoff) =>
              handoff.strategy === "full_thread_summary" &&
              handoff.fromProviderThreadIds.includes(providerThread.id) &&
              source.ordinal >= handoff.coveredRunOrdinals.from &&
              source.ordinal <= handoff.coveredRunOrdinals.to,
          ),
      )
      .map((source) => source.id),
  );
  const missedRuns = projection.runs.filter(
    (source) =>
      source.ordinal < run.ordinal &&
      source.providerThreadId === providerThread.id &&
      source.id !== input.recoveringPromptOfRunId &&
      (source.promptRecoveryOfRunId === undefined ||
        (source.activeAttemptId !== null && steeringAttemptIds.has(source.activeAttemptId))) &&
      (source.status === "failed" || source.status === "interrupted") &&
      !deliveredAttemptIds.has(source.activeAttemptId) &&
      !recoveredPromptRunIds.has(source.id),
  );
  const missedRunIds = new Set(missedRuns.map((source) => source.id));
  // Imported history has no native attachments. Legacy attempts without a native
  // identity must not revive attachments explicitly recovered into a replacement.
  const estimateHistory = (items: ReadonlyArray<OrchestrationV2TurnItem>): number => {
    return sameNativeThread
      ? items.reduce((sum, item) => {
          if (
            item.runId === run.id ||
            (item.runId !== null && rolledBackRunIds.has(item.runId)) ||
            (item.runId !== null &&
              !deliveredItemIds.has(item.id) &&
              (missedRunIds.has(item.runId) ||
                (!nativeInputRunIds.has(item.runId) &&
                  (coveredItemIds.has(item.id) || legacyRecoveredRunIds.has(item.runId))))) ||
            (item.providerThreadId !== providerThread.id && !deliveredItemIds.has(item.id))
          )
            return sum;
          const delivered = deliveredItemIds.has(item.id) ? deliveredBytes.get(item.id) : undefined;
          const historical = delivered === undefined ? historicalMessage(item) : null;
          const nativeAttachments =
            item.type === "user_message" &&
            item.providerThreadId === providerThread.id &&
            item.runId !== null &&
            (nativeInputRunIds.has(item.runId) ||
              (legacyInputRunIds.has(item.runId) &&
                !coveredItemIds.has(item.id) &&
                !legacyRecoveredRunIds.has(item.runId)))
              ? attachmentTokenAllowance(item.attachments)
              : 0;
          return (
            sum +
            (delivered ?? (historical === null ? 0 : estimateTextTokens(historical.text))) +
            nativeAttachments
          );
        }, 0)
      : 0;
  };
  return {
    deliveredItemIds,
    coveredItemIds,
    acceptedAttempts,
    nativeInputRunIds,
    legacyInputRunIds,
    missedRuns,
    missedRunIds,
    estimateHistory,
  };
}

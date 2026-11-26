import { useIsFocused } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export function playThreadFeedback(kind: "sent" | "completed" | "failed" | "asked"): void {
  const feedback =
    kind === "sent"
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : Haptics.notificationAsync(
          kind === "completed"
            ? Haptics.NotificationFeedbackType.Success
            : kind === "asked"
              ? Haptics.NotificationFeedbackType.Warning
              : Haptics.NotificationFeedbackType.Error,
        );
  // Feedback must never turn an accepted send into a failed operation.
  void feedback.catch(() => undefined);
}

interface FeedbackSnapshot {
  readonly threadKey: string;
  readonly runs: ReadonlyMap<string, OrchestrationV2Run["status"]> | null;
  /** The question or approval open at this sample, for telling a new one from one already seen. */
  readonly requestId: string | null;
  readonly armedRuns: Set<string>;
  readonly seenErrors: Set<string>;
}

export type ThreadFeedbackRun = Pick<OrchestrationV2Run, "id" | "status">;

interface ComposerFailure {
  readonly message: string;
  readonly messageId?: string | null;
}

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Only announce transitions witnessed while this thread is on screen. */
export function useThreadFeedback(
  threadKey: string,
  runs: ReadonlyArray<ThreadFeedbackRun> | null,
  composerError: ComposerFailure | null,
  {
    syncStatus,
    connected,
    visible,
    supportsSyncMarker,
    pendingRequestId = null,
  }: {
    readonly syncStatus: EnvironmentThreadStatus;
    readonly connected: boolean;
    readonly visible: boolean;
    readonly supportsSyncMarker: boolean;
    /** The question the agent is waiting on, if any: one arriving on screen gets a tap. */
    readonly pendingRequestId?: string | null;
  },
): void {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const previousRef = useRef<FeedbackSnapshot | null>(null);
  const hiddenArmedRunsRef = useRef<Pick<FeedbackSnapshot, "threadKey" | "armedRuns"> | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // Reset immediately, including an inactive/active pair in one render.
      const previous = previousRef.current;
      if (previous !== null) {
        hiddenArmedRunsRef.current = {
          threadKey: previous.threadKey,
          armedRuns: new Set(previous.armedRuns),
        };
      }
      previousRef.current = null;
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (hiddenArmedRunsRef.current?.threadKey !== threadKey) hiddenArmedRunsRef.current = null;
    if (!visible || !focused || !foreground || AppState.currentState !== "active") {
      const previous = previousRef.current;
      if (previous?.threadKey === threadKey) {
        hiddenArmedRunsRef.current = {
          threadKey,
          armedRuns: new Set(previous.armedRuns),
        };
      }
      previousRef.current = null;
      return;
    }
    const previous = previousRef.current;
    // Shell fallbacks and cached/resuming projections cannot establish live work.
    // Each return to live detail starts a fresh baseline before any notification.
    const liveRuns: FeedbackSnapshot["runs"] =
      supportsSyncMarker && connected && syncStatus === "live" && runs !== null
        ? new Map(runs.map((run) => [run.id, run.status]))
        : null;
    const seenErrors = previous?.threadKey === threadKey ? previous.seenErrors : new Set<string>();
    const errorKey =
      composerError === null
        ? null
        : JSON.stringify([composerError.messageId ?? null, composerError.message]);
    const sendFailed = errorKey !== null && !seenErrors.has(errorKey);
    if (errorKey !== null) seenErrors.add(errorKey);
    const sameThread = previous?.threadKey === threadKey;
    const armedRuns =
      liveRuns === null || !sameThread ? new Set<string>() : new Set(previous.armedRuns);
    // Keep known live work armed across a brief absence, but consume the first
    // visible sample silently and discard anything that finished while hidden.
    if (liveRuns !== null && hiddenArmedRunsRef.current !== null) {
      for (const id of hiddenArmedRunsRef.current.armedRuns) {
        const status = liveRuns.get(id);
        if (status !== undefined && ACTIVE_RUN_STATUSES.has(status)) armedRuns.add(id);
      }
      hiddenArmedRunsRef.current = null;
    }
    // A retained projection may already say live before its resume replay. Do
    // not arm runs inherited on mount. A non-live → live boundary proves a fresh
    // baseline; runs first appearing after that initial sample are new work.
    if (sameThread && liveRuns !== null) {
      for (const [id, status] of liveRuns) {
        if (ACTIVE_RUN_STATUSES.has(status) && !previous.runs?.has(id)) armedRuns.add(id);
      }
    }
    previousRef.current = {
      threadKey,
      runs: liveRuns,
      requestId: pendingRequestId,
      armedRuns,
      seenErrors,
    };
    if (previous === null || previous.threadKey !== threadKey) return;

    let completed = false;
    let failed = sendFailed;
    for (const [id, status] of liveRuns ?? []) {
      const previousStatus = previous.runs?.get(id);
      if (
        !previous.armedRuns.has(id) ||
        previousStatus === undefined ||
        !ACTIVE_RUN_STATUSES.has(previousStatus)
      )
        continue;
      completed ||= status === "completed";
      failed ||= status === "failed";
    }
    // A question is news only when it arrives from work watched live; one that was already
    // waiting when the chat opened, or replayed on a resume, is on screen, not arriving.
    const asked =
      previous.runs !== null &&
      previous.armedRuns.size > 0 &&
      liveRuns !== null &&
      pendingRequestId !== null &&
      pendingRequestId !== previous.requestId;
    if (failed) {
      playThreadFeedback("failed");
    } else if (asked) {
      playThreadFeedback("asked");
    } else if (completed) {
      playThreadFeedback("completed");
    }
  }, [
    composerError,
    connected,
    focused,
    foreground,
    pendingRequestId,
    runs,
    supportsSyncMarker,
    syncStatus,
    threadKey,
    visible,
  ]);
}

import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentThreadShells } from "../state/threads";
import { toastManager } from "./ui/toast";

const EMPTY_ENVIRONMENT = "" as never;

/**
 * Says how a model change ended, and when it is waiting for an answer. The
 * Models assistant lives in the model picker and its panel goes away when it
 * finishes, so with the picker closed a finished request left no trace: the
 * model was added and nothing said so.
 */
export function ModelManagerNotice() {
  const environmentId = usePrimaryEnvironmentId();
  const busy = useAtomValue(
    environmentThreadShells.modelManagerThreadRefAtom(environmentId ?? EMPTY_ENVIRONMENT),
  );
  // The chat being followed: kept after it stops being busy, to read how it ended.
  const [watched, setWatched] = useState<ScopedThreadRef | null>(null);
  if (environmentId !== null && busy !== null && watched?.threadId !== busy.threadId) {
    setWatched(busy);
  }
  const asked = useRef<string | null>(null);
  const announced = useRef<string | null>(null);
  const shell = useThreadShell(watched);

  useEffect(() => {
    if (watched === null || shell === null) return;
    if (busy !== null) {
      // One notice per wait: the mark is cleared when the answer has been given.
      const waiting = shell.hasPendingApprovals || shell.hasPendingUserInput;
      if (!waiting) asked.current = null;
      else if (asked.current !== watched.threadId) {
        asked.current = watched.threadId;
        toastManager.add({
          type: "info",
          title: "Models needs your answer",
          description: "Open the model picker to reply.",
        });
      }
      return;
    }
    // Busy a moment ago and no longer: say how that run ended, once.
    const run = `${watched.threadId}:${shell.latestRun?.runId ?? ""}`;
    if (announced.current === run) return;
    announced.current = run;
    toastManager.add(
      shell.latestRun?.status === "completed"
        ? {
            type: "success",
            title: "Models finished",
            description: "The model list refreshes in a moment.",
          }
        : {
            type: "warning",
            title: "Models stopped before finishing",
            description: "Open the model picker to try again.",
          },
    );
  }, [busy, shell, watched]);

  return null;
}

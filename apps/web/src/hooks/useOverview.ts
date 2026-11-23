import { useAtomValue } from "@effect/atom-react";
import {
  currentOverviewThread,
  makeOverviewThreadId,
  OVERVIEW_ENABLED_STORAGE_KEY,
  overviewModelSelection,
  overviewEntries,
  overviewIsWorking,
  overviewMessageText,
  type OverviewEntry,
} from "@t3tools/client-runtime/overview";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  OVERVIEW_THREAD_TITLE,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ShellSnapshot,
  type ServerProvider,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";

import { newMessageId, randomUUID } from "../lib/utils";
import { useThreadProjection } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { serverEnvironment } from "../state/server";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useLocalStorage } from "./useLocalStorage";
import { useScratchProject } from "./useScratchProject";

const NO_SNAPSHOT_ATOM = Atom.make<OrchestrationV2ShellSnapshot | null>(null).pipe(
  Atom.withLabel("overview:no-snapshot"),
);
const NO_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider> | null>(null).pipe(
  Atom.withLabel("overview:no-providers"),
);

export function useOverviewEnabled() {
  return useLocalStorage(OVERVIEW_ENABLED_STORAGE_KEY, true, Schema.Boolean);
}

/** The machine's one Overview conversation, which keeps its history, and sending to it. */
export function useOverview(environmentId: EnvironmentId | null) {
  const snapshot = useAtomValue(
    environmentId === null ? NO_SNAPSHOT_ATOM : threadEnvironment.snapshotAtom(environmentId),
  );
  const thread = useMemo(() => currentOverviewThread(snapshot?.threads ?? []), [snapshot]);
  const projection = useThreadProjection(
    environmentId === null || thread === null ? null : { environmentId, threadId: thread.id },
  )?.projection;
  const providers = useAtomValue(
    environmentId === null
      ? NO_PROVIDERS_ATOM
      : serverEnvironment.providersValueAtom(environmentId),
  );
  const modelSelection = useMemo(() => overviewModelSelection(providers), [providers]);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  // Shown until the server echoes the message back.
  const [pending, setPending] = useState<{ id: MessageId; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = useMemo(() => (projection ? overviewEntries(projection) : []), [projection]);
  const awaitingEcho = pending !== null && !stored.some((entry) => entry.id === pending.id);
  const entries: ReadonlyArray<OverviewEntry> = awaitingEcho
    ? [...stored, { id: pending.id, role: "user", text: pending.text, streaming: false }]
    : stored;
  const working = awaitingEcho || (projection ? overviewIsWorking(projection) : false);

  const send = useCallback(
    async (text: string, context?: OrchestrationMessageContext) => {
      const trimmed = text.trim();
      if (environmentId === null || trimmed.length === 0) return;
      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      const message = {
        messageId,
        role: "user" as const,
        text: trimmed,
        attachments: [],
        ...(context ? { context } : {}),
      };
      setError(null);
      setPending({ id: messageId, text: overviewMessageText(trimmed, context) });
      let result;
      if (thread !== null) {
        result = await startTurn({
          environmentId,
          input: {
            threadId: thread.id,
            message,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          },
        });
      } else {
        const project = await openScratchProject(environmentId, "Could not start Overview");
        if (project === null) {
          setPending(null);
          return;
        }
        result = await startTurn({
          environmentId,
          input: {
            threadId: makeOverviewThreadId(randomUUID()),
            message,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.id,
                title: OVERVIEW_THREAD_TITLE,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          },
        });
      }
      if (result._tag === "Failure") {
        setPending(null);
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Overview couldn't send that.");
      }
    },
    [environmentId, modelSelection, openScratchProject, startTurn, thread],
  );

  return { threadId: thread?.id ?? null, entries, working, error, send };
}

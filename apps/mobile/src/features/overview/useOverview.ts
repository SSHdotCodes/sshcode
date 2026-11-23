import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  currentOverviewThread,
  makeOverviewThreadId,
  overviewModelSelection,
  overviewEntries,
  overviewIsWorking,
  type OverviewEntry,
} from "@t3tools/client-runtime/overview";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MessageId,
  OVERVIEW_THREAD_TITLE,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useWorkspaceState } from "../../state/workspace";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

const NO_SNAPSHOT_ATOM = Atom.make<OrchestrationV2ShellSnapshot | null>(null).pipe(
  Atom.withLabel("mobile-overview:no-snapshot"),
);
const NO_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider> | null>(null).pipe(
  Atom.withLabel("mobile-overview:no-providers"),
);

/** On unless switched off; off until preferences load, so the row never flashes. */
export function useOverviewEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled = AsyncResult.isSuccess(preferences) && preferences.value.overviewEnabled !== false;
  const setEnabled = useCallback((value: boolean) => save({ overviewEnabled: value }), [save]);
  return [enabled, setEnabled];
}

/** Overview looks at the machine the phone is connected to. */
export function useOverviewEnvironmentId(): EnvironmentId | null {
  const { environments } = useWorkspaceState();
  return (
    environments.find((entry) => entry.connectionState === "connected")?.environmentId ??
    environments[0]?.environmentId ??
    null
  );
}

export function useOverviewThread(environmentId: EnvironmentId | null) {
  const snapshot = useAtomValue(
    environmentId === null ? NO_SNAPSHOT_ATOM : threadEnvironment.snapshotAtom(environmentId),
  );
  return useMemo(() => currentOverviewThread(snapshot?.threads ?? []), [snapshot]);
}

/** The machine's one Overview conversation, which keeps its history, and sending to it. */
export function useOverview(environmentId: EnvironmentId | null) {
  const thread = useOverviewThread(environmentId);
  const projection = useThreadProjection({
    environmentId,
    threadId: thread?.id ?? null,
  })?.projection;
  const providers = useAtomValue(
    environmentId === null
      ? NO_PROVIDERS_ATOM
      : serverEnvironment.providersValueAtom(environmentId),
  );
  const modelSelection = useMemo(() => overviewModelSelection(providers), [providers]);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, COMMAND_OPTIONS);
  const openScratch = useAtomCommand(projectEnvironment.openScratch, COMMAND_OPTIONS);
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
    async (text: string) => {
      const trimmed = text.trim();
      if (environmentId === null || trimmed.length === 0) return;
      const messageId = MessageId.make(uuidv4());
      const createdAt = new Date().toISOString();
      const message = { messageId, role: "user" as const, text: trimmed, attachments: [] };
      setError(null);
      setPending({ id: messageId, text: trimmed });
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
        const project = await openScratch({ environmentId, input: {} });
        if (project._tag === "Failure") {
          setPending(null);
          if (!isAtomCommandInterrupted(project)) setError("Couldn't start Overview. Try again.");
          return;
        }
        result = await startTurn({
          environmentId,
          input: {
            threadId: makeOverviewThreadId(uuidv4()),
            message,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.value.id,
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
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "Overview couldn't send that.");
        }
      }
    },
    [environmentId, modelSelection, openScratch, startTurn, thread],
  );

  return { threadId: thread?.id ?? null, entries, working, error, send };
}

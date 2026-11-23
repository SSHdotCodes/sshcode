import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentPending } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { readProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Still coming up, as every machine is for a while after the app restarts:
 * connecting, or connected before its config arrived. Not offline or failed.
 */
function isStarting(
  phase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: unknown,
): boolean {
  return (
    phase === "available" ||
    phase === "connecting" ||
    phase === "reconnecting" ||
    (phase === "connected" && !serverConfig)
  );
}

/** Waits until the machine offers its scratch folder; false if it stops starting or takes a minute. */
function waitForScratchFolder(environmentId: EnvironmentId): Promise<boolean> {
  const check = () => {
    const presentation = appAtomRegistry
      .get(environmentPresentations.presentationsAtom)
      .get(environmentId);
    if (!presentation) return "gone";
    const { phase } = presentation.connection;
    if (availableScratchWorkspaceRoot(phase, presentation.serverConfig) !== null) return "ready";
    return isStarting(phase, presentation.serverConfig) ? "starting" : "gone";
  };
  const first = check();
  if (first !== "starting") return Promise.resolve(first === "ready");
  return new Promise((resolve) => {
    let done = false;
    const finish = (ready: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 60_000);
    const unsubscribe = appAtomRegistry.subscribe(
      environmentPresentations.presentationsAtom,
      () => {
        const state = check();
        if (state !== "starting") finish(state === "ready");
      },
    );
  });
}

/**
 * Which machine a thread without a project starts on: the one the user is
 * working on, and only there, even while it is still starting (opening the
 * folder waits for it), never whichever other machine happened to load first.
 * With no current machine (the hosted app with nothing open), the one machine
 * that offers it, never a silent pick, and none while another is starting.
 * While this client's own machine has not registered yet, none: a saved
 * machine that loaded first is not the one the user is working on.
 */
export function resolveScratchEnvironment(
  entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly phase: EnvironmentConnectionPhase | null | undefined;
    readonly serverConfig: Parameters<typeof availableScratchWorkspaceRoot>[1];
  }>,
  current: EnvironmentId | null,
  primaryPending = false,
): EnvironmentId | null {
  if (current === null && primaryPending) return null;
  const offers = (entry: (typeof entries)[number]) =>
    availableScratchWorkspaceRoot(entry.phase, entry.serverConfig) !== null;
  if (current !== null) {
    const entry = entries.find((candidate) => candidate.environmentId === current);
    if (!entry) return null;
    return offers(entry) || isStarting(entry.phase, entry.serverConfig) ? current : null;
  }
  const candidates = entries.filter(
    (entry) => offers(entry) || isStarting(entry.phase, entry.serverConfig),
  );
  return candidates.length === 1 && offers(candidates[0]!) ? candidates[0]!.environmentId : null;
}

/**
 * Whether the first screen may open its new chat. A chat without a project
 * starts on one machine, so that machine's chat list is all it needs: another
 * machine that is offline or slow must not hold the first screen. Without
 * such a machine the choice falls to the projects of every machine.
 */
export function landingReady(input: {
  readonly scratchEnvironmentId: EnvironmentId | null;
  readonly scratchShellLoaded: boolean;
  readonly allShellsLoaded: boolean;
}): boolean {
  return input.allShellsLoaded || (input.scratchEnvironmentId !== null && input.scratchShellLoaded);
}

function knownScratchProject(environmentId: EnvironmentId): EnvironmentProject | undefined {
  return readProjects().find(
    (project) => project.environmentId === environmentId && project.isScratch === true,
  );
}

/**
 * Threads without a project live in the environment's scratch project, a
 * plain folder the server owns (users see it as "No project"). The server
 * creates it on first use; after that it is an ordinary project on the
 * non-git path, and each thread gets its own subfolder.
 */
export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryPending = usePrimaryEnvironmentPending();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  /** The scratch folder of a connected environment, or null when it offers none. */
  const scratchWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null => {
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      return availableScratchWorkspaceRoot(
        environment?.connection.phase,
        environment?.serverConfig,
      );
    },
    [environments],
  );

  const scratchEnvironmentId = useCallback(
    (current: EnvironmentId | null): EnvironmentId | null =>
      resolveScratchEnvironment(
        environments.map((entry) => ({
          environmentId: entry.environmentId,
          phase: entry.connection.phase,
          serverConfig: entry.serverConfig,
        })),
        current,
        primaryPending,
      ),
    [environments, primaryPending],
  );

  /** Resolves to the scratch project once it is in this client's store. */
  const openScratchProject = useCallback(
    async (
      environmentId: EnvironmentId,
      failureTitle = "Could not start without a project",
    ): Promise<EnvironmentProject | null> => {
      // After its first use the folder is already in the store. Waiting on the
      // server again made New chat hang on a busy server, sometimes minutes.
      // It still re-makes a deleted folder, well before the first send.
      const known = knownScratchProject(environmentId);
      if (known !== undefined) {
        void openScratch({ environmentId, input: {} });
        return known;
      }
      // Right after a restart the machine may still be starting: wait for it.
      if (scratchWorkspaceRootFor(environmentId) === null) {
        const label =
          environments.find((entry) => entry.environmentId === environmentId)?.label ??
          "this machine";
        let waitingToast: string | undefined;
        const waiting = setTimeout(() => {
          waitingToast = toastManager.add({ type: "loading", title: `Waiting for ${label}…` });
        }, 1_000);
        const ready = await waitForScratchFolder(environmentId);
        clearTimeout(waiting);
        if (waitingToast !== undefined) toastManager.close(waitingToast);
        if (!ready) {
          reportScratchFailure(
            failureTitle,
            new Error(`${label} isn't connected. Try again once it is.`),
          );
          return null;
        }
      }
      const result = await openScratch({ environmentId, input: {} });
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
      }
      return null;
    },
    [environments, openScratch, scratchWorkspaceRootFor],
  );

  const startScratchThread = useCallback(
    async (environmentId: EnvironmentId) => {
      const open = (project: EnvironmentProject) =>
        handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
          (error: unknown) => reportScratchFailure("Could not start without a project", error),
        );
      if (knownScratchProject(environmentId) !== undefined) {
        const project = await openScratchProject(environmentId);
        if (project) await open(project);
        return;
      }
      // The first chat waits for the server to make the folder. If the user
      // moves on or starts typing meanwhile, the new chat must not take over.
      const requestedHref = window.location.href;
      let typed = false;
      const noteTyping = () => {
        typed = true;
      };
      document.addEventListener("keydown", noteTyping, true);
      const project = await openScratchProject(environmentId).finally(() =>
        document.removeEventListener("keydown", noteTyping, true),
      );
      if (!project) return;
      if (!typed && window.location.href === requestedHref) {
        await open(project);
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "New chat ready",
          actionProps: { children: "Open", onClick: () => void open(project) },
        }),
      );
    },
    [handleNewThread, openScratchProject],
  );

  return { scratchWorkspaceRootFor, scratchEnvironmentId, openScratchProject, startScratchThread };
}

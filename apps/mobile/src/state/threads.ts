import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { ThreadMediaHistory } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
  createCreatedChatShellAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell, hasHydratedEnvironmentShell } from "./shell";
import { createShellPreviewPresentation } from "./shell-preview";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const threadMediaPageCommand =
  ThreadMediaHistory.createThreadMediaCommand(connectionAtomRuntime);
export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});
export const threadPickerShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadFamilies.allSnapshotAtom,
});
export const shellPreviewPresentation = createShellPreviewPresentation({
  catalogAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentShell.stateValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  previewAtom: environmentShell.previewAtom,
});
export const homeThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: shellPreviewPresentation.snapshotAtom,
});

export const createdChatShellAtom = createCreatedChatShellAtoms(
  connectionAtomRuntime,
  environmentShell.stateValueAtom,
  environmentThreadShells.threadShellAtom,
);

// Give the pushed route time to take over the same subscription. A cancelled
// press or a long press releases its speculative subscription after one second.
export function preloadPhoneThread(environmentId: EnvironmentId, threadId: ThreadId): void {
  if (Platform.OS !== "ios" || Platform.isPad || !hasHydratedEnvironmentShell(environmentId))
    return;
  const release = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  setTimeout(release, 1_000);
}

/** Warm one pending card with the same bounded subscription the thread screen will take over. */
export function preloadPendingPhoneThread(environmentId: EnvironmentId, threadId: ThreadId) {
  if (AppState.currentState !== "active" || !hasHydratedEnvironmentShell(environmentId)) return;
  const atom = environmentThreads.stateAtom(environmentId, threadId);
  let stopped = false;
  const release = appAtomRegistry.subscribe(atom, stopWhenReady, { immediate: true });
  const background = AppState.addEventListener("change", (state) => {
    if (state !== "active") stop();
  });
  // A silent socket must not keep an unused transcript loading indefinitely.
  const timeout = setTimeout(stop, 10_000);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    background.remove();
    release();
  }
  function stopWhenReady(result: Atom.Type<typeof atom>) {
    // A retained live cursor can predate the question shown in the shell.
    const hasCard =
      AsyncResult.isSuccess(result) &&
      result.value.status === "live" &&
      Option.isSome(result.value.data) &&
      derivePendingThreadRequests(result.value.data.value).userInputs.length > 0;
    if (
      hasCard ||
      AsyncResult.isFailure(result) ||
      (AsyncResult.isSuccess(result) &&
        (result.value.status === "deleted" || Option.isSome(result.value.error)))
    ) {
      // A retained result can arrive inside subscribe, before its cleanup is assigned.
      queueMicrotask(stop);
    }
  }
  return stop;
}

/** Keeps the subagent tree under `rootThreadId` in the thread list while the caller shows it. */
export function useThreadFamily(
  environmentId: EnvironmentId | null,
  rootThreadId: ThreadId | null,
): void {
  useEffect(() => {
    if (environmentId === null || rootThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId);
  }, [environmentId, rootThreadId]);
}

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}

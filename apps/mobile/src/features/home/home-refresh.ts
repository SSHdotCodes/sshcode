import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";

const REFRESH_TIMEOUT_MS = 20_000;

/** Re-read the chat catalog through its existing subscription, without replacing the connection. */
function refreshHomeEnvironment(environmentId: EnvironmentId): Promise<void> {
  const stateAtom = environmentShell.stateValueAtom(environmentId);
  const previous = appAtomRegistry.get(stateAtom);
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error("Refreshing chats took too long. Pull down to try again.")),
      REFRESH_TIMEOUT_MS,
    );
    unsubscribe = appAtomRegistry.subscribe(stateAtom, (state) => {
      if (state === previous) return;
      if (Option.isSome(state.error)) finish(new Error(state.error.value));
      else if (state.status === "live") finish();
    });
    try {
      appAtomRegistry.refresh(environmentShell.stateAtom(environmentId));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not refresh chats."));
    }
  });
}

export async function refreshHomeThreads(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(environmentIds)].map(refreshHomeEnvironment),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

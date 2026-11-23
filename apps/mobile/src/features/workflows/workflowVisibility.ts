import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";

/** Provenance survives run-history pruning. Normal-chat leads retain their source. */
export function isWorkflowThread(thread: Pick<EnvironmentThreadShell, "source">) {
  return String(thread.source.creationSource) === "workflows";
}

export function workflowListHiddenKeys(threads: readonly EnvironmentThreadShell[]) {
  const roots = new Set(
    threads
      .filter(isWorkflowThread)
      .map((thread) =>
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
  );
  return new Set(
    threads
      .filter(
        (thread) =>
          isWorkflowThread(thread) ||
          roots.has(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.lineage.rootThreadId,
            }),
          ),
      )
      .map((thread) =>
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
  );
}

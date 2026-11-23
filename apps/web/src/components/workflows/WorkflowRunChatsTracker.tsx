import type { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import { workflowHiddenThreadIds } from "@t3tools/shared/workflows";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { useEnvironments } from "../../state/environments";
import { useWorkflowsState } from "./useWorkflows";
import { useWorkflowsBeta } from "./workflowsBeta";

/**
 * Chats a Workflows run created live in the Workflows section, so the main
 * list leaves them out the way it leaves out subagents. Keys are
 * `environmentId:threadId`.
 */
export interface WorkflowRunLink {
  readonly runId: WorkflowRunId;
  readonly name: string;
}

type RunChatsByEnvironment = ReadonlyMap<string, EnvironmentRunChats>;

/** Records one environment's run chats, or forgets the environments a set doesn't keep. */
export function nextRunChats(
  byEnvironment: RunChatsByEnvironment,
  change:
    | { readonly environmentId: string; readonly chats: EnvironmentRunChats }
    | { readonly keep: ReadonlySet<string> },
): RunChatsByEnvironment {
  if ("keep" in change) {
    if ([...byEnvironment.keys()].every((id) => change.keep.has(id))) return byEnvironment;
    return new Map([...byEnvironment].filter(([id]) => change.keep.has(id)));
  }
  return new Map(byEnvironment).set(change.environmentId, change.chats);
}

function hiddenKeys(byEnvironment: RunChatsByEnvironment): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [environment, entry] of byEnvironment) {
    for (const id of entry.hidden) hidden.add(`${environment}:${id}`);
  }
  return hidden;
}

const useRunChatsStore = create<{
  readonly byEnvironment: RunChatsByEnvironment;
  readonly hidden: ReadonlySet<string>;
  readonly update: (change: Parameters<typeof nextRunChats>[1]) => void;
}>((set) => ({
  byEnvironment: new Map(),
  hidden: new Set(),
  update: (change) =>
    set((state) => {
      const byEnvironment = nextRunChats(state.byEnvironment, change);
      if (byEnvironment === state.byEnvironment) return state;
      return { byEnvironment, hidden: hiddenKeys(byEnvironment) };
    }),
}));

export interface EnvironmentRunChats {
  readonly hidden: ReadonlySet<string>;
  /** Every chat in a run, lead included, to the newest run it belongs to. */
  readonly runs: ReadonlyMap<string, WorkflowRunLink>;
}

/** The run a chat belongs to, for a way back from the chat to its run. */
export function useWorkflowRunForChat(
  environmentId: string,
  threadId: string,
): WorkflowRunLink | null {
  return useRunChatsStore(
    (state) => state.byEnvironment.get(environmentId)?.runs.get(threadId) ?? null,
  );
}

/** Run chats the main lists leave out, or null with the Beta off so nothing changes. */
export function useHiddenWorkflowChatKeys(): ReadonlySet<string> | null {
  const enabled = useWorkflowsBeta();
  const hidden = useRunChatsStore((state) => state.hidden);
  return enabled ? hidden : null;
}

/**
 * Leaves out leads the Workflows section started (the server marks them, so
 * this holds after old runs are pruned) and the run chats the tracker knows.
 * Subagents are already left out by lineage.
 */
export function withoutWorkflowRunChats<
  T extends {
    readonly environmentId: string;
    readonly id: string;
    readonly source: { readonly creationSource: string };
  },
>(threads: ReadonlyArray<T>, hidden: ReadonlySet<string> | null): ReadonlyArray<T> {
  if (hidden === null) return threads;
  return threads.filter(
    (thread) =>
      thread.source.creationSource !== "workflows" &&
      !hidden.has(`${thread.environmentId}:${thread.id}`),
  );
}

function EnvironmentRunChatsSource({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { state, loading, error } = useWorkflowsState(environmentId);
  // Until the first state arrives (or while it fails) the last known chats stay put.
  const ready = !loading && error === null;
  const chats = useMemo((): EnvironmentRunChats => {
    const runs = new Map<string, WorkflowRunLink>();
    // Runs come newest first, so a chat links to its latest run.
    for (const run of state.runs) {
      const link = { runId: run.id, name: run.snapshot.name };
      for (const id of [run.leadThreadId, ...run.agents.map((agent) => agent.threadId)]) {
        if (!runs.has(id)) runs.set(id, link);
      }
    }
    return { hidden: workflowHiddenThreadIds(state.runs), runs };
  }, [state.runs]);
  const update = useRunChatsStore((store) => store.update);
  useEffect(() => {
    if (ready) update({ environmentId, chats });
  }, [chats, environmentId, ready, update]);
  return null;
}

/**
 * Mounted once in the app shell. With the Beta off it renders nothing and subscribes to nothing.
 * A disconnected environment keeps its last known run chats, so they don't flicker into the
 * main lists while it reconnects; they go when it leaves the catalog or the Beta turns off.
 */
export function WorkflowRunChatsTracker() {
  const enabled = useWorkflowsBeta();
  const { environments } = useEnvironments();
  const update = useRunChatsStore((store) => store.update);
  const catalogKey = enabled
    ? environments.map((environment) => environment.environmentId).join("\n")
    : "";
  useEffect(() => {
    update({ keep: new Set(catalogKey === "" ? [] : catalogKey.split("\n")) });
  }, [catalogKey, update]);
  if (!enabled) return null;
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => (
      <EnvironmentRunChatsSource
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}

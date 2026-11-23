/**
 * Dev-only stand-in for the Workflows server, for exercising the UI in an
 * isolated app with fake models. Turn on with
 * `localStorage.setItem("t3code:workflows:fixture", "1")` (or `"empty"`) and reload. Runs are
 * a pure function of time, so `__workflowsFixture.freeze(seconds, runId?)` pins every
 * status for screenshots. Production builds drop this module: every use sits
 * behind `import.meta.env.DEV`.
 */
import {
  ThreadId,
  WorkflowRunId,
  type WorkflowAgentStatus,
  type WorkflowCompileRequest,
  type WorkflowCompileResult,
  type WorkflowDefinition,
  type WorkflowOperation,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowStartRequest,
  type WorkflowStartResult,
  type WorkflowsState,
} from "@t3tools/contracts";

import { exampleWorkflow, HAIKU, OPUS, SOL } from "./workflowExamples";
import { validateWorkflow, workflowChildren } from "@t3tools/shared/workflows";

import { isAgent, tidyWorkflow, withDerivedRoot } from "./workflowGraph";
import { setWorkflowClock } from "./useNow";
import type { WorkflowResult } from "./useWorkflows";

const STORAGE_KEY = "t3code:workflows:fixture";
interface Timeline {
  readonly start: number;
  readonly end: number;
  readonly fail: boolean;
}

/**
 * Plays a run from its snapshot: each box starts a moment after its parent,
 * leaves finish after a few seconds, parents finish once their agents have.
 */
export function simulateRun(
  run: WorkflowRun,
  startedAt: number,
  now: number,
  failNodeIndex = 1,
): WorkflowRun {
  const snapshot = run.snapshot;
  const root = snapshot.rootNodeId;
  if (root === null) return run;
  const times: Array<{ node: string; slot: number; parent: string | null } & Timeline> = [];
  let leafIndex = 0;
  const plan = (nodeId: string, parentKey: string | null, begin: number, depth: number): number => {
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    if (!node || !isAgent(node)) return begin;
    const slots = node.count.kind === "exact" ? node.count.n : Math.min(node.count.max, 3 + depth);
    let latest = begin;
    for (let slot = 0; slot < slots; slot++) {
      const start = begin + slot * 700;
      const children = workflowChildren(snapshot, node.id);
      let end: number;
      const key = `${node.id}:${slot}`;
      const entry = { node: node.id, slot, parent: parentKey, start, end: 0, fail: false };
      times.push(entry);
      if (children.length === 0) {
        leafIndex++;
        end = start + 5_000 + ((leafIndex * 2_300) % 7_000);
        entry.fail = leafIndex === failNodeIndex + 1;
      } else {
        let childEnd = start;
        children.forEach((child, index) => {
          childEnd = Math.max(
            childEnd,
            plan(child.id, key, start + 2_000 + index * 900, depth + 1),
          );
        });
        end = childEnd + 2_500;
      }
      entry.end = end;
      latest = Math.max(latest, end);
    }
    return latest;
  };
  plan(root, null, 0, 0);
  const iso = (offset: number) => new Date(startedAt + offset).toISOString();
  const elapsed = now - startedAt;
  const threadFor = (key: string) => ThreadId.make(`fixture-${run.id}-${key.replaceAll(":", "-")}`);
  const agents: WorkflowRunAgent[] = [];
  for (const [index, entry] of times.entries()) {
    if (elapsed < entry.start) continue;
    const done = elapsed >= entry.end;
    const hasLiveChildren = times.some(
      (other) =>
        other.parent === `${entry.node}:${entry.slot}` &&
        elapsed >= other.start &&
        elapsed < other.end,
    );
    const status: WorkflowAgentStatus = done
      ? entry.fail
        ? "failed"
        : "completed"
      : elapsed - entry.start < 900
        ? "pending"
        : hasLiveChildren
          ? "waiting"
          : "running";
    const node = snapshot.nodes.find((candidate) => candidate.id === entry.node);
    const label = node && isAgent(node) ? node.label || node.text : "Agent";
    agents.push({
      nodeId: entry.node as WorkflowRunAgent["nodeId"],
      slot: entry.slot,
      threadId: entry.parent === null ? run.leadThreadId : threadFor(`${entry.node}:${entry.slot}`),
      parentThreadId:
        entry.parent === null
          ? null
          : entry.parent === `${root}:0`
            ? run.leadThreadId
            : threadFor(entry.parent),
      title: `${label} ${entry.slot + 1}`,
      model: node && isAgent(node) && node.model ? node.model.model : (node?.kind ?? null),
      status,
      ...(PROGRESS[status](entry.slot) ? { progress: PROGRESS[status](entry.slot)! } : {}),
      // A couple of open cards and the lead's grades, so the cockpit has something to show.
      ...(status === "running" && index % 5 === 1 ? { needs: "approval" as const } : {}),
      ...(status === "running" && index % 7 === 3 ? { needs: "input" as const } : {}),
      ...(status === "completed" && entry.parent !== null ? { grade: 3 + (index % 3) } : {}),
      startedAt: iso(entry.start),
      completedAt: done ? iso(entry.end) : null,
    });
  }
  const lead = agents.find((agent) => agent.parentThreadId === null);
  const status =
    lead === undefined
      ? "starting"
      : lead.status === "completed"
        ? "completed"
        : lead.status === "failed"
          ? "failed"
          : agents.some((agent) => agent.status === "running" || agent.status === "pending")
            ? "running"
            : "waiting";
  return {
    ...run,
    status: run.status === "cancelled" ? "cancelled" : status,
    agents:
      run.status === "cancelled"
        ? agents.map((agent) =>
            agent.completedAt === null ? { ...agent, status: "cancelled" as const } : agent,
          )
        : agents,
    updatedAt: iso(Math.min(elapsed, Math.max(...times.map((entry) => entry.end)))),
    completedAt: status === "completed" ? (lead?.completedAt ?? null) : null,
  };
}

const PROGRESS: Record<WorkflowAgentStatus, (slot: number) => string | undefined> = {
  planned: () => undefined,
  pending: () => "Opening a chat…",
  running: (slot) =>
    ["Reading the failing test", "Editing settings.tsx", "Running vp test", "Checking types"][
      slot % 4
    ],
  waiting: () => "Waiting on its agents",
  completed: (slot) => ["Fixed 2 tests", "Done, 3 files changed", "Merged cleanly"][slot % 3],
  failed: () => "Tests still fail: 2 snapshots are out of date",
  cancelled: () => "Cancelled",
  interrupted: () => "Interrupted",
};

/** Stop and Retry on single agents, replayed over the simulated run. */
interface AgentActions {
  readonly stops: Array<[threadId: string, at: number]>;
  readonly retries: Array<{ readonly of: ThreadId; readonly id: ThreadId; readonly at: number }>;
}

function withoutCard(agent: WorkflowRunAgent): WorkflowRunAgent {
  const { needs: _needs, ...rest } = agent;
  return rest;
}

export function applyAgentActions(
  run: WorkflowRun,
  actions: AgentActions | undefined,
  now: number,
): WorkflowRun {
  if (!actions) return run;
  const iso = (at: number) => new Date(at).toISOString();
  const stops = new Map(actions.stops);
  const stop = (agent: WorkflowRunAgent): WorkflowRunAgent => {
    const at = stops.get(agent.threadId);
    if (at === undefined || (agent.completedAt !== null && Date.parse(agent.completedAt) <= at)) {
      return agent;
    }
    return {
      ...withoutCard(agent),
      status: "cancelled",
      progress: "Stopped",
      completedAt: iso(at),
    };
  };
  const agents = run.agents.map(stop);
  for (const retry of actions.retries) {
    const original = agents.find((agent) => agent.threadId === retry.of);
    if (!original) continue;
    const age = now - retry.at;
    const status: WorkflowAgentStatus =
      age < 900 ? "pending" : age < 9_000 ? "running" : "completed";
    const { grade: _grade, progress: _progress, ...base } = withoutCard(original);
    agents.push(
      stop({
        ...base,
        threadId: retry.id,
        retryOf: retry.of,
        status,
        progress: PROGRESS[status](original.slot)!,
        ...(status === "completed" ? { grade: 5 } : {}),
        startedAt: iso(retry.at),
        completedAt: status === "completed" ? iso(retry.at + 9_000) : null,
      }),
    );
  }
  return { ...run, agents };
}

interface FixtureApi {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => WorkflowsState;
  readonly mutate: (operation: WorkflowOperation) => Promise<WorkflowResult<void>>;
  readonly compile: (
    input: WorkflowCompileRequest,
  ) => Promise<WorkflowResult<WorkflowCompileResult>>;
  readonly start: (input: WorkflowStartRequest) => Promise<WorkflowResult<WorkflowStartResult>>;
}

let instance: FixtureApi | null | undefined;

export function workflowsFixture(): FixtureApi | null {
  if (instance !== undefined) return instance;
  const mode = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
  if (mode !== "1" && mode !== "empty") {
    instance = null;
    return instance;
  }
  instance = createFixture(mode === "empty");
  return instance;
}

function createFixture(empty: boolean): FixtureApi {
  const listeners = new Set<() => void>();
  const t0 = Date.now();
  const now = new Date(t0).toISOString();
  let frozenAt: number | null = null;
  const clock = () => frozenAt ?? Date.now();
  const sketch = exampleWorkflow(now, false);
  const release = exampleWorkflow(now, true);
  const runStarts = new Map<string, number>();
  const agentActions = new Map<string, AgentActions>();
  let runs: WorkflowRun[] = [];
  let workflows: WorkflowDefinition[] = [release, sketch];

  const makeRun = (definition: WorkflowDefinition, task: string, startedAt: number) => {
    const id = WorkflowRunId.make(`run_${Math.round(startedAt).toString(36)}`);
    const run: WorkflowRun = {
      id,
      workflowId: definition.id,
      snapshot: definition,
      task,
      origin: "workflows",
      // `t3code:workflows:fixture-lead` points new runs at a real chat, so clicking
      // the lead opens something.
      leadThreadId: ThreadId.make(
        window.localStorage.getItem(`${STORAGE_KEY}-lead`) ?? `fixture-${id}-lead`,
      ),
      status: "starting",
      agents: [],
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      completedAt: null,
    };
    runStarts.set(id, startedAt);
    return run;
  };
  runs = empty
    ? []
    : [
        makeRun(release, "Get 0.0.46 out: fix the API tests and polish settings.", t0 - 4_000),
        makeRun(release, "Clean up the flaky provider tests.", t0 - 3_600_000),
      ];
  if (empty) workflows = [];
  // Survives reloads within the tab, so deep links keep working while iterating.
  const SAVED_KEY = `${STORAGE_KEY}:state`;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SAVED_KEY) ?? "null") as {
      workflows: WorkflowDefinition[];
      runs: WorkflowRun[];
      starts: Array<[string, number]>;
      actions?: Array<[string, AgentActions]>;
    } | null;
    if (saved) {
      workflows = saved.workflows;
      runs = saved.runs;
      runStarts.clear();
      for (const [id, start] of saved.starts) runStarts.set(id, start);
      for (const [id, actions] of saved.actions ?? []) agentActions.set(id, actions);
    }
  } catch {
    // A bad saved state just reseeds.
  }
  const persist = () =>
    window.sessionStorage.setItem(
      SAVED_KEY,
      JSON.stringify({ workflows, runs, starts: [...runStarts], actions: [...agentActions] }),
    );
  persist();

  let cached: WorkflowsState | null = null;
  let cachedAt = -1;
  const getState = () => {
    const at = clock();
    // One snapshot per tick keeps useSyncExternalStore stable between renders.
    const tick = Math.floor(at / 1000);
    if (cached && cachedAt === tick) return cached;
    cachedAt = tick;
    cached = {
      version: 1,
      workflows,
      runs: runs.map((run) =>
        applyAgentActions(
          simulateRun(run, runStarts.get(run.id) ?? at, at),
          agentActions.get(run.id),
          at,
        ),
      ),
    };
    return cached;
  };
  const emit = () => {
    persist();
    cached = null;
    for (const listener of listeners) listener();
  };
  let timer: ReturnType<typeof setInterval> | null = null;

  const api: FixtureApi = {
    subscribe: (listener) => {
      listeners.add(listener);
      timer ??= setInterval(() => {
        if (frozenAt === null) emit();
      }, 1000);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getState,
    mutate: async (operation) => {
      if (operation.type === "save") {
        const exists = workflows.some((entry) => entry.id === operation.workflow.id);
        workflows = exists
          ? workflows.map((entry) =>
              entry.id === operation.workflow.id ? operation.workflow : entry,
            )
          : [operation.workflow, ...workflows];
      } else if (operation.type === "delete") {
        workflows = workflows.filter((entry) => entry.id !== operation.id);
      } else if (operation.type === "cancelRun") {
        runs = runs.map((run) =>
          run.id === operation.runId ? { ...run, status: "cancelled" } : run,
        );
      } else if (operation.type === "deleteRun") {
        runs = runs.filter((run) => run.id !== operation.runId);
      } else {
        const agent = getState()
          .runs.find((run) => run.id === operation.runId)
          ?.agents.find((entry) => entry.threadId === operation.threadId);
        const live =
          agent?.status === "pending" || agent?.status === "running" || agent?.status === "waiting";
        if (!agent || (operation.type === "stopAgent") !== live) {
          return {
            ok: false,
            message:
              operation.type === "stopAgent"
                ? "That agent isn't running."
                : "That agent is still running.",
            issues: [],
            interrupted: false,
          };
        }
        const actions = agentActions.get(operation.runId) ?? { stops: [], retries: [] };
        const at = clock();
        agentActions.set(
          operation.runId,
          operation.type === "stopAgent"
            ? { ...actions, stops: [...actions.stops, [agent.threadId, at]] }
            : {
                ...actions,
                retries: [
                  ...actions.retries,
                  {
                    of: agent.threadId,
                    id: ThreadId.make(`${agent.threadId}-r${actions.retries.length + 1}`),
                    at,
                  },
                ],
              },
        );
      }
      emit();
      return { ok: true, value: undefined };
    },
    compile: async ({ workflow, prompt }) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const base = workflow.nodes.length > 0 || !prompt ? workflow : exampleWorkflow(now, false);
      const models = [OPUS, SOL, HAIKU];
      const known = new Set(workflow.nodes.map((node) => node.id));
      const resolved = withDerivedRoot({
        ...base,
        id: workflow.id,
        name: workflow.name,
        nodes: base.nodes.map((node, index) => {
          if (!isAgent(node) || node.model !== null) return node;
          const text = node.text.toLowerCase();
          const model = text.includes("haiku")
            ? HAIKU
            : text.includes("sol") || text.includes("gpt")
              ? SOL
              : text.includes("opus")
                ? OPUS
                : models[index % 3]!;
          const many = text.includes("many");
          return {
            ...node,
            model,
            label: node.label || (model === OPUS ? "Lead" : model === SOL ? "Worker" : "Agents"),
            count: many ? { kind: "upTo" as const, max: 8 } : node.count,
            instructions: node.instructions || "Do your part of the task and report back.",
          };
        }),
      });
      const fresh = new Set(
        resolved.nodes.filter((node) => !known.has(node.id)).map((node) => node.id),
      );
      const laidOut = fresh.size > 0 ? tidyWorkflow(resolved, fresh) : resolved;
      return {
        ok: true,
        value: {
          workflow: laidOut,
          issues: validateWorkflow(laidOut),
          summary: "Matched each box to a model and turned “many” into up to 8 agents.",
        },
      };
    },
    start: async ({ workflowId, task, chatThreadId }) => {
      const definition = workflows.find((entry) => entry.id === workflowId);
      if (!definition) {
        return { ok: false, message: "Workflow not found.", issues: [], interrupted: false };
      }
      const issues = validateWorkflow(definition);
      if (issues.length > 0) {
        return { ok: false, message: "Fix the issues first.", issues, interrupted: false };
      }
      const created = makeRun(definition, task, clock());
      const run = chatThreadId
        ? { ...created, origin: "chat" as const, leadThreadId: chatThreadId }
        : created;
      runs = [run, ...runs];
      emit();
      return { ok: true, value: { runId: run.id, leadThreadId: run.leadThreadId } };
    },
  };
  Object.assign(window, {
    __workflowsFixture: {
      freeze: (secondsIntoNewestRun: number | null, runId?: string) => {
        const newest = runs.find((run) => run.id === runId) ?? runs[0];
        frozenAt =
          secondsIntoNewestRun === null || !newest
            ? null
            : (runStarts.get(newest.id) ?? t0) + secondsIntoNewestRun * 1000;
        const pinned = frozenAt;
        setWorkflowClock(pinned === null ? null : () => pinned);
        emit();
      },
    },
  });
  return api;
}

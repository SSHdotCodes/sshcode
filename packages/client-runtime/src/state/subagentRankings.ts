import {
  WS_METHODS,
  type EnvironmentId,
  type ModelRankingEntry,
  type NodeId,
  type OrchestrationV2Subagent,
  type SubagentRankingsSnapshot,
} from "@t3tools/contracts";
import { modelRankingLineFamily } from "@t3tools/shared/modelRankings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

/** Only finished app-owned task rows offer feedback. */
export function canRateSubagent(agent: Pick<OrchestrationV2Subagent, "origin" | "status">) {
  return agent.origin === "app_owned" && isTerminalSubagentStatus(agent.status);
}

/** Family rows retain separate model/provider evidence; legacy rows match exact selections. */
export function modelRankingRunEvidence(
  entry: ModelRankingEntry,
  models: SubagentRankingsSnapshot["models"],
) {
  return models.filter((model) =>
    "family" in entry
      ? modelRankingLineFamily(model.family, model.model) === entry.family
      : model.instanceId === entry.selection.instanceId && model.model === entry.selection.model,
  );
}

/** Families the user has run subagents on, so rankings list them even when only routed. */
export function modelRankingUsedFamilies(
  models: SubagentRankingsSnapshot["models"] | undefined,
): ReadonlySet<string> {
  return new Set((models ?? []).map((model) => modelRankingLineFamily(model.family, model.model)));
}

export function modelRankingRunDetails(models: SubagentRankingsSnapshot["models"]) {
  if (models.length === 0) return "";
  const details = models
    .map((model) =>
      [
        `${model.model} · ${model.instanceId}: ${model.yourRuns}`,
        ...model.byKind.map((item) => `  ${item.kind}: ${item.yourRuns}`),
      ].join("\n"),
    )
    .join("\n\n");
  return `${details}\n\nLast 60 days. Your thumbs weigh more than parent grades.`;
}

/** One live snapshot per environment, shared by Settings and visible task controls. */
export function createSubagentRankingsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "subagent rankings",
    tag: WS_METHODS.subagentRankingsSubscribe,
  });
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(subscribe({ environmentId, input: {} }));
      return result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
    }),
  );
  const thumbsByTaskAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(snapshotAtom(environmentId));
      // null keeps retained, unrated tasks distinct from unavailable records.
      return new Map<NodeId, "up" | "down" | null>(
        snapshot?.thumbs.map((item) => [item.taskId, item.thumb ?? null]) ?? [],
      );
    }),
  );
  const taskThumbAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((taskId: NodeId) =>
      Atom.make((get) => get(thumbsByTaskAtom(environmentId)).get(taskId)),
    ),
  );
  const thumbAtom = (environmentId: EnvironmentId, taskId: NodeId) =>
    taskThumbAtoms(environmentId)(taskId);
  const gradesByTaskAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(snapshotAtom(environmentId));
      return new Map<NodeId, number>(
        snapshot?.thumbs.flatMap((item) =>
          item.grade === undefined ? [] : [[item.taskId, item.grade] as const],
        ) ?? [],
      );
    }),
  );
  const taskGradeAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((taskId: NodeId) =>
      Atom.make((get) => get(gradesByTaskAtom(environmentId)).get(taskId)),
    ),
  );
  /** The lead's 1–10 score for a finished subagent, once it graded it. */
  const gradeAtom = (environmentId: EnvironmentId, taskId: NodeId) =>
    taskGradeAtoms(environmentId)(taskId);
  const toggleThumb = createEnvironmentRpcCommand(runtime, {
    label: "rate subagent",
    tag: WS_METHODS.subagentRankingsToggleThumb,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.taskId}`,
    },
  });
  return { subscribe, snapshotAtom, thumbAtom, gradeAtom, toggleThumb };
}

import { type ModelSelection } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";

/** Validate both picker additions and submission against the live selections. */
export function comparisonSelectionError(
  selections: ReadonlyArray<Pick<ModelSelection, "instanceId" | "model">>,
): string | null {
  if (selections.length < 2 || selections.length > 4) return "Choose two to four models.";
  if (
    new Set(selections.map((selection) => JSON.stringify([selection.instanceId, selection.model])))
      .size !== selections.length
  )
    return "Choose different models.";
  return null;
}

/** Collapse a comparison into its first available member, combining attention and activity. */
export function groupComparisonThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (!threads.some((thread) => thread.source.comparison != null)) return threads;
  const byKey = new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]));
  const seen = new Set<string>();
  return threads.flatMap((thread) => {
    const group = thread.source.comparison;
    if (!group || thread.archivedAt !== null || thread.settledAt !== null) return [thread];
    const key = `${thread.environmentId}:${group.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const members = group.threadIds.flatMap((id) => {
      const member = byKey.get(`${thread.environmentId}:${id}`);
      return member &&
        member.archivedAt === null &&
        member.deletedAt === null &&
        member.settledAt === null
        ? [member]
        : [];
    });
    const representative = members[0] ?? thread;
    const working = members.find(
      (member) =>
        member.runtime &&
        ["running", "starting", "preparing", "queued", "waiting"].includes(member.runtime.status),
    );
    const activity =
      working ??
      members.find(
        (member) => member.runtime?.status === "failed" || member.latestRun?.status === "failed",
      );
    return [
      {
        ...representative,
        title: `Compare: ${group.title}`,
        hasPendingApprovals: members.some((member) => member.hasPendingApprovals),
        hasPendingUserInput: members.some((member) => member.hasPendingUserInput),
        hasActionableProposedPlan: members.some((member) => member.hasActionableProposedPlan),
        pendingSubagentRequest:
          members.find((member) => member.pendingSubagentRequest)?.pendingSubagentRequest ?? null,
        ...(activity ? { runtime: activity.runtime, latestRun: activity.latestRun } : {}),
        pendingBackgroundTasks: members.flatMap((member) => member.pendingBackgroundTasks),
      },
    ];
  });
}

/** Send every member once. Report individual failures so retrying never duplicates successful sends. */
export async function sendComparisonFollowUp<T>(
  members: ReadonlyArray<T>,
  send: (member: T) => Promise<void>,
) {
  return Promise.all(
    members.map(async (member) => {
      try {
        await send(member);
        return { member, error: null };
      } catch (error) {
        return {
          member,
          error: error instanceof Error ? error.message : "Could not send the follow-up.",
        };
      }
    }),
  );
}

/** Every member uses the regular bootstrap path, with a required, separate worktree in Git. */
export function comparisonThreadInput(input: {
  readonly turn: import("../operations/commands.ts").StartThreadTurnInput & {
    readonly createdAt: string;
  };
  readonly projectId: import("@t3tools/contracts").ProjectId;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly isGitRepo: boolean;
  readonly baseBranch: string | null;
  readonly startFromOrigin?: boolean;
}): import("../operations/commands.ts").StartThreadTurnInput & { readonly createdAt: string } {
  const { turn } = input;
  if (!turn.modelSelection) throw new Error("Choose a model for each chat.");
  if (input.isGitRepo && !input.baseBranch)
    throw new Error("Choose a base branch for the comparison.");
  return {
    ...turn,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: turn.modelSelection,
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
        branch: input.baseBranch,
        worktreePath: null,
        createdAt: turn.createdAt,
      },
      ...(input.isGitRepo && input.baseBranch
        ? {
            prepareWorktree: {
              projectCwd: input.workspaceRoot,
              baseBranch: input.baseBranch,
              requireWorktree: true,
              ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
            },
          }
        : {}),
      runSetupScript: true,
    },
  };
}

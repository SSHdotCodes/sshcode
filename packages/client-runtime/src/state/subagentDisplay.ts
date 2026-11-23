import type {
  ModelSelection,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { fileBasename } from "@t3tools/shared/path";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

export type SubagentSpeed = "fast" | "ultrafast";

export const SUBAGENT_SPEED_LABELS: Readonly<Record<SubagentSpeed, string>> = {
  fast: "Fast",
  ultrafast: "Ultrafast",
};

/** The faster speed a subagent was started at: Codex's service tier or Claude's fast mode. */
export function subagentSpeed(
  selection: Pick<ModelSelection, "options"> | null | undefined,
): SubagentSpeed | null {
  for (const option of selection?.options ?? []) {
    if (option.id === "fastMode" && option.value === true) return "fast";
    if (option.id !== "serviceTier") continue;
    // Codex calls its Fast tier "priority".
    if (option.value === "priority" || option.value === "fast") return "fast";
    if (option.value === "ultrafast") return "ultrafast";
  }
  return null;
}

/** The Ultrafast mark's two bolts (24×24, the back one faded), shared by the Mac and the phone. */
export const ULTRAFAST_BOLTS = {
  back: "m17 2-10 12h7l-1 8 10-12h-7l1-8Z",
  front: "m11 2-10 12h7l-1 8 10-12h-7l1-8Z",
} as const;

/** Summarizes one adjacent group, without changing its member identities or order. */
export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

/**
 * Counts a group's states in the order a reader scans them: what is still
 * running first, then outcomes, using the agents panel's words.
 */
export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What the app saw a finished subagent do, for its card's meta line: commands, the last check,
 * files and commits. Time is left out because the card already shows it. Null when nothing was seen.
 */
export function subagentSeenLine(agent: Pick<OrchestrationV2Subagent, "seen">): string | null {
  const seen = agent.seen;
  if (seen === undefined) return null;
  // Command counts stay with the lead: failed greps and probes are ordinary work, not news.
  const parts = [
    seen.check?.passed === undefined ? null : seen.check.passed ? "checks passed" : "checks failed",
    seen.files === undefined ? null : plural(seen.files, "file"),
    seen.commits === undefined ? null : plural(seen.commits.length, "commit"),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Formats Codex task paths for display while leaving provider identity untouched. */
export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

/** Match desktop's model resolution and show only changes from the parent's workspace. */
export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? catalogModel.shortName || catalogModel.name
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

/** Live work leads with progress; settled work leads with its result. */
export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const terminal = isTerminalSubagentStatus(input.status);
  const preferred = terminal ? input.result : input.progress;
  const fallback = terminal ? input.progress : input.result;
  const detail = preferred?.trimStart() || fallback?.trimStart() || "";
  if (detail.length <= 280) return detail.trimEnd().replace(/\s+/gu, " ") || null;
  const whitespace = /\s+/uy;
  let compact = "";
  for (let index = 0; index < detail.length; index += 1) {
    whitespace.lastIndex = index;
    const gap = whitespace.exec(detail);
    if (gap) {
      index += gap[0].length;
      if (index === detail.length) break;
      if (compact.length > 0) compact += " ";
    }
    compact += detail[index];
    if (compact.length > 280) return `${compact.slice(0, 280).trimEnd()}…`;
  }
  return compact || null;
}

export function subagentCardDetail(detail: string | null | undefined): string | null {
  if (!detail || /^Child task ended with status\b/i.test(detail)) return null;
  return (
    detail
      .replace(/!?\[([^\]]+)\]\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)/g, "$1")
      .replace(/`/g, "")
      .replace(/^[ \t]*[-*][ \t]+/gm, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** An independent chat's card reads its live shell, including old creation receipts. */
export function createdChatPresentation(
  item: Pick<
    Extract<import("@t3tools/contracts").OrchestrationV2TurnItem, { type: "thread_created" }>,
    "title" | "targetModel" | "targetProviderInstanceId"
  >,
  thread: OrchestrationV2ThreadShell | null | undefined,
) {
  const deleted = thread === null || (thread !== undefined && thread.deletedAt !== null);
  const state = thread?.activityRunStatus ?? thread?.status ?? "starting";
  const needsYou = thread?.pendingRuntimeRequest != null || state === "waiting";
  const status: OrchestrationV2TurnItemStatus = deleted
    ? "cancelled"
    : needsYou
      ? "waiting"
      : state === "completed"
        ? "completed"
        : state === "failed"
          ? "failed"
          : state === "cancelled" || state === "interrupted" || state === "rolled_back"
            ? "cancelled"
            : state === "running"
              ? "running"
              : "pending";
  const statusLabel = deleted
    ? "Chat deleted"
    : needsYou
      ? "Needs you"
      : status === "completed"
        ? "Done"
        : status === "failed"
          ? "Failed"
          : status === "cancelled"
            ? "Stopped"
            : status === "running"
              ? "Working"
              : "Starting";
  const preview =
    thread?.createdChatPreview ??
    (thread?.latestVisibleMessage?.role === "assistant"
      ? thread.latestVisibleMessage.text
      : (thread?.currentStep?.detail ?? null));
  const error = status === "failed" ? thread?.lastError?.split(/\r?\n/u)[0]?.trim() || null : null;
  return {
    title: thread?.title || item.title || "Chat",
    status,
    statusLabel,
    tone:
      status === "completed"
        ? ("completed" as const)
        : status === "failed"
          ? ("failed" as const)
          : status === "cancelled"
            ? ("stopped" as const)
            : ("working" as const),
    detail: error ?? preview,
    preview: error ? preview : null,
    live: !deleted && ["pending", "running", "waiting"].includes(status),
    canOpenThread: !deleted,
    providerInstanceId: thread?.modelSelection.instanceId ?? item.targetProviderInstanceId,
    model: thread?.modelSelection.model ?? item.targetModel,
    startedAt:
      thread?.activityRunStartedAt ??
      thread?.latestRunStartedAt ??
      thread?.latestRunRequestedAt ??
      null,
    completedAt: thread?.latestRunCompletedAt ?? null,
  };
}

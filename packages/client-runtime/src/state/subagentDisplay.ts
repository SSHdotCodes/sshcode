import type {
  ModelSelection,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { fileBasename } from "@t3tools/shared/path";
import { composerModelName, effortChoiceLabel } from "../composerModelDisplay.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

export type SubagentSpeed = "fast" | "ultrafast";

export const SUBAGENT_SPEED_LABELS: Readonly<Record<SubagentSpeed, string>> = {
  fast: "Fast",
  ultrafast: "Ultrafast",
};

/** The faster speed a subagent was started at: Codex's service tier, Claude's fast mode or an ACP Speed. */
export function subagentSpeed(
  selection: Pick<ModelSelection, "options"> | null | undefined,
): SubagentSpeed | null {
  for (const option of selection?.options ?? []) {
    if (option.id === "fastMode" && option.value === true) return "fast";
    // An ACP agent's Speed (Devin's Lightning on SWE models).
    if (option.id === "speed" && option.value === "fast") return "fast";
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

// A trailing effort word in a model's catalog name ("SWE-2.1 Medium").
const TRAILING_EFFORT_WORD = /\s+(?:minimal|low|medium|high|x-?high|extra high|max|ultra)$/iu;

/**
 * A catalog name that ends in an effort the run overrides names the effort it runs at:
 * Devin lists SWE-2.1 as "SWE-2.1 Medium" while a subagent asked for High thinking runs High.
 */
function nameWithChosenEffort(
  name: string,
  catalogModel: Pick<ServerProviderModel, "capabilities"> | undefined,
  options: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined,
): string {
  if (!TRAILING_EFFORT_WORD.test(name) || options === undefined) return name;
  for (const descriptor of catalogModel?.capabilities?.optionDescriptors ?? []) {
    if (descriptor.type !== "select" || descriptor.role !== "reasoning") continue;
    const chosen = options.find((option) => option.id === descriptor.id)?.value;
    const choice = descriptor.options.find((option) => option.id === chosen);
    if (choice !== undefined)
      return name.replace(TRAILING_EFFORT_WORD, ` ${effortChoiceLabel(choice)}`);
  }
  return name;
}

/** Match desktop's model resolution and show only changes from the parent's workspace. */
export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  /** The run's own option choices, so a name with a built-in effort shows the effort it uses. */
  readonly modelOptions?:
    | ReadonlyArray<{ readonly id: string; readonly value: unknown }>
    | undefined;
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
    ? nameWithChosenEffort(
        // The row shows the provider's logo, so the name drops the maker as the composer does.
        composerModelName(catalogModel),
        catalogModel,
        input.modelOptions,
      )
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

/** Built-in provider research subagents: code search (Explore/explorer) and web readers. */
const RESEARCH_NATIVE_TYPES = new Set(["explore", "explorer", "web-fetch"]);

/** A subagent whose job is finding things out: delegated as research, or a provider's research agent. */
export function isResearchSubagent(
  agent: Pick<OrchestrationV2Subagent, "role" | "nativeType">,
): boolean {
  if (agent.role === "research") return true;
  const type = agent.nativeType?.trim().toLowerCase();
  return type !== undefined && (RESEARCH_NATIVE_TYPES.has(type) || type.includes("research"));
}

export interface ResearchSource {
  /** The first link the report gives to this site. */
  readonly url: string;
  /** The site, without "www.". */
  readonly site: string;
}

const REPORT_LINK = /https?:\/\/[^\s<>()[\]"'`]+/giu;

/**
 * The web pages a research report links to: each site once, in the order the report
 * first cites it, and how many distinct pages it linked in all.
 */
export function researchSources(report: string | null | undefined): {
  readonly sites: ReadonlyArray<ResearchSource>;
  readonly pages: number;
} {
  if (!report) return { sites: [], pages: 0 };
  const pages = new Set<string>();
  const sites = new Map<string, ResearchSource>();
  for (const [raw] of report.matchAll(REPORT_LINK)) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[.,;:!?*_]+$/u, ""));
    } catch {
      continue;
    }
    pages.add(url.href);
    const site = url.hostname.replace(/^www\./u, "");
    if (site && !sites.has(site)) sites.set(site, { url: url.href, site });
  }
  return { sites: [...sites.values()], pages: pages.size };
}

/** The opening of a research report as one plain paragraph: no headings, bullets, links or tables. */
export function researchReportPreview(
  report: string | null | undefined,
  maxChars = 280,
): string | null {
  if (!report) return null;
  const words: string[] = [];
  let length = 0;
  for (const rawLine of report.split("\n")) {
    const line = rawLine
      .replace(/!?\[([^\]]+)\]\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/u, "")
      .replace(/[`*_]|^\|.*\|$|^-{3,}$/gu, "")
      .replace(REPORT_LINK, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!line) continue;
    words.push(line);
    length += line.length + 1;
    if (length > maxChars) break;
  }
  const text = words.join(" ");
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
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

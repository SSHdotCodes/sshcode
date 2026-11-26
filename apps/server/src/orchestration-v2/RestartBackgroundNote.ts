import { MessageId, type RunId } from "@t3tools/contracts";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

export const restartContinuationMessageId = (sourceRunId: RunId) =>
  MessageId.make(`message:restart-continuation:${sourceRunId}`);

type Work = OrchestrationV2RestartCancelledBackgroundWork;
type Attempt = Pick<OrchestrationV2RunAttempt, "id" | "runId">;

const MAX_LABEL_LENGTH = 160;

function compactLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

/** Describes a background-capable turn item that restart recovery cancels. */
export function cancelledTurnItemWork(item: OrchestrationV2TurnItem): Work | undefined {
  switch (item.type) {
    case "subagent":
      return {
        kind: "subagent",
        label: compactLabel(item.title) ?? compactLabel(item.prompt) ?? "subagent",
        id: item.id,
      };
    case "command_execution":
      return {
        kind: item.monitor === true ? "monitor" : "shell",
        label: compactLabel(item.input) ?? compactLabel(item.title) ?? "background command",
        id: item.id,
      };
    case "dynamic_tool": {
      const monitor =
        item.input !== null &&
        typeof item.input === "object" &&
        Reflect.get(item.input, "persistent") === true;
      return {
        kind: monitor ? "monitor" : "task",
        label: compactLabel(item.title) ?? compactLabel(item.toolName) ?? "background tool",
        id: item.id,
      };
    }
    default:
      return undefined;
  }
}

function restartWorkKind(task: OrchestrationV2PendingBackgroundTask): Work["kind"] {
  switch (task.kind) {
    case "command":
      return "shell";
    case "subagent":
      return "subagent";
    case "monitor":
      return "monitor";
    case "background_task":
      return "task";
    default:
      task satisfies never;
      return "task";
  }
}

/** Describes a provider-reported background task (the provider-thread roster). */
export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
  const kind = restartWorkKind(task);
  const description = compactLabel(task.description);
  return {
    kind,
    label:
      compactLabel(
        description === undefined ? task.taskId : `${description} (id ${task.taskId})`,
      ) ?? "background task",
    id: task.taskId,
  };
}

const MAX_NOTE_ENTRIES = 10;

/**
 * Provider-facing text for work the model still expects to hear back from.
 * Bounded (entries and label length) so it cannot crowd out the turn's context.
 */
export function restartCancelledBackgroundWorkNote(
  work: ReadonlyArray<Work>,
  accountMove = false,
): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    accountMove
      ? "The account changed and this background work was interrupted before it finished. It will not report back:"
      : "Note: the SSHCode server restarted, and this background work was cancelled before it finished. It will not report back:",
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
    "Durable jobs survive: check monitor_list and logPath before relaunching.",
  ].join("\n");
}

type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "runAttemptId" | "providerThreadId" | "status"
>;

/**
 * A run whose turn had settled before the restart cancelled its background
 * work. Continuing it prompts the provider with the note. A run cut mid-turn
 * instead resumes that turn, which Codex does natively without a prompt.
 */
export function isRestartNoteSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return (
    // A failed or interrupted turn is never continued. Recovery cancels a
    // waiting run it cannot checkpoint, so a cancelled one still qualifies.
    (source.status === "completed" ||
      source.status === "waiting" ||
      source.status === "cancelled") &&
    (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
    !providerTurns.some(
      (turn) => turn.runAttemptId === source.activeAttemptId && turn.status === "cancelled",
    )
  );
}

/**
 * Work an agent ends its turn to wait for: a monitor, a subagent, or a
 * background task. A restart that cancels it wakes the settled turn, because
 * nothing else will. A shell usually does not: most are dev servers that
 * nobody waits on, so their note waits for the next user message. A shell
 * whose exit wakes the agent anyway (`wakesAgent`) is awaited.
 */
export function isAwaitedWork(work: Pick<Work, "kind" | "wakesAgent">): boolean {
  return work.kind !== "shell" || work.wakesAgent === true;
}

/**
 * Drivers whose agent is woken when any of its background commands ends.
 * Claude Code reports every background Bash exit to the agent, so a Claude
 * agent that ended its turn with one running was waiting on it.
 */
const SHELL_EXIT_WAKES_AGENT_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

/** Marks a cancelled shell that its driver would have woken the agent for. */
export function withDriverShellWake(work: Work, driver: string | null | undefined): Work {
  return work.kind === "shell" &&
    driver != null &&
    SHELL_EXIT_WAKES_AGENT_DRIVERS.has(driver) &&
    work.wakesAgent !== true
    ? { ...work, wakesAgent: true }
    : work;
}

/**
 * A run's status as its waiter should read it: a delegating parent,
 * `task_status`, or `t3_thread_wait`. A turn that ended to wait on work the
 * restart then cancelled did not finish, so it is "interrupted", not
 * "completed", and its last message is not a final result.
 */
export function runOutcome(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork">,
): OrchestrationV2Run["status"] {
  return (run.status === "completed" || run.status === "cancelled") &&
    (run.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    ? "interrupted"
    : run.status;
}

/**
 * Whether a restart continuation may prompt from `source`: a turn the restart
 * cut mid-way, or a settled turn that lost awaited work in the restart.
 */
export function isRestartContinuationSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return isRestartNoteSource(source, providerTurns)
    ? (source.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    : source.status === "cancelled";
}

/**
 * The note a restart continuation of `source` carries, and whether the turn it
 * continues had settled (the note is then the whole prompt). A continuation cut
 * before its provider turn completed may not have delivered its own note:
 * adapters can announce a running turn before accepting the prompt. Carry the
 * note forward until a completed turn proves delivery.
 */
export function restartContinuationNote(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): { readonly work: ReadonlyArray<Work>; readonly settled: boolean } {
  const completedAttempts = new Set(
    providerTurns.filter((turn) => turn.status === "completed").map((turn) => turn.runAttemptId),
  );
  const completedRuns = new Set(
    attempts.filter((attempt) => completedAttempts.has(attempt.id)).map((attempt) => attempt.runId),
  );
  let current = source;
  let work = current.restartCancelledBackgroundWork ?? [];
  const visited = new Set([current.id]);
  while (
    current.restartContinuationOfRunId !== undefined &&
    !completedRuns.has(current.id) &&
    !(current.activeAttemptId !== null && completedAttempts.has(current.activeAttemptId))
  ) {
    const previous = runs.find((candidate) => candidate.id === current.restartContinuationOfRunId);
    if (previous === undefined || visited.has(previous.id)) break;
    visited.add(previous.id);
    current = previous;
    work = mergeRestartCancelledBackgroundWork(current.restartCancelledBackgroundWork ?? [], work);
  }
  return { work, settled: isRestartNoteSource(current, providerTurns) };
}

/**
 * A restart continuation prompted with the note rather than a native resume.
 * A turn cut mid-way that lost background work is prompted too, so the note
 * is delivered with it; only a continuation without a note resumes natively.
 */
export function isRestartNoteContinuation(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): boolean {
  const source =
    run.restartContinuationOfRunId === undefined
      ? undefined
      : runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return (
    source !== undefined &&
    restartContinuationNote(source, runs, providerTurns, attempts).work.length > 0
  );
}

/**
 * Work cancelled by a restart that the run's provider thread has not been told
 * about yet. The note belongs to the provider thread that lost the work: turns
 * on another provider (after a switch) neither owe it nor deliver it. A later
 * completed turn on the same provider thread proves delivery, so the pending
 * set is derived rather than cleared. Compactions and
 * resumed turns carry no note, and a rolled-back run left native history, so
 * none of them counts as delivery. A note continuation's own prompt is the note.
 */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "completedAt"
    | "userMessageId"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "activeAttemptId"
  >;
  /** Include earlier attempts: a steer replaces the attempt but not the run. */
  readonly attempts: ReadonlyArray<Attempt>;
}): ReadonlyArray<Work> {
  const isCompaction = (run: typeof input.run) => input.compactionMessageIds.has(run.userMessageId);
  // The current run prepends the note unless it is a compaction or a
  // continuation (whose own prompt is the note, or which resumes natively).
  if (
    input.run.providerThreadId === null ||
    input.run.restartContinuationOfRunId !== undefined ||
    isCompaction(input.run)
  )
    return [];
  const providerThreadId = input.run.providerThreadId;
  const deliveredAttemptIds = new Set(
    input.providerTurns
      .filter((turn) => turn.providerThreadId === providerThreadId && turn.status === "completed")
      .map((turn) => turn.runAttemptId),
  );
  const sameThread = input.runs.filter((run) => run.providerThreadId === providerThreadId);
  const prompted = sameThread.filter(
    (candidate) =>
      candidate.id !== input.run.id &&
      candidate.activeAttemptId !== null &&
      candidate.status !== "rolled_back" &&
      (deliveredAttemptIds.has(candidate.activeAttemptId) ||
        input.attempts.some(
          (attempt) => attempt.runId === candidate.id && deliveredAttemptIds.has(attempt.id),
        )) &&
      !isCompaction(candidate) &&
      (candidate.restartContinuationOfRunId === undefined ||
        isRestartNoteContinuation(candidate, input.runs, input.providerTurns, input.attempts)),
  );
  // A steer restarts this run on a new attempt: an earlier attempt that already
  // reached the provider delivered the note, so the replacement must not repeat it.
  const alreadyDelivered = input.attempts.some(
    (attempt) =>
      attempt.runId === input.run.id &&
      attempt.id !== input.run.activeAttemptId &&
      deliveredAttemptIds.has(attempt.id),
  );
  if (alreadyDelivered) return [];
  return sameThread
    .filter(
      (source) =>
        runRanAfter(input.run, source) &&
        (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
        !prompted.some((later) => runRanAfter(later, source)),
    )
    .reduce<ReadonlyArray<Work>>(
      (work, source) =>
        mergeRestartCancelledBackgroundWork(work, source.restartCancelledBackgroundWork ?? []),
      [],
    );
}

export function mergeRestartCancelledBackgroundWork(
  current: ReadonlyArray<Work>,
  added: ReadonlyArray<Work>,
): ReadonlyArray<Work> {
  // Rows recorded before ids existed fall back to kind + label.
  const identity = (entry: Work) => entry.id ?? `${entry.kind}\u0000${entry.label}`;
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const entry of added) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/** The prompt of a restart continuation that only resumes the cut turn. */
export const RESTART_CONTINUE_PROMPT = "Continue where you left off.";

/**
 * Whether `run` never reached its provider, so a restart starts it over from
 * its message instead of resuming it. Mirrors the provider-retry fence: app-side
 * `startedAt` precedes admission, so only an unset or explicitly unrequested
 * provider start, with no provider turn or earlier attempt, is proof.
 */
export function neverReachedProvider(
  run: Pick<OrchestrationV2Run, "id" | "activeAttemptId" | "startedAt">,
  attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerStartRequested">
  >,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
): boolean {
  const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
  return (
    attempt?.providerStartRequested !== true &&
    (run.startedAt === null || attempt?.providerStartRequested === false) &&
    !attempts.some(
      (candidate) => candidate.runId === run.id && candidate.id !== run.activeAttemptId,
    ) &&
    !providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)
  );
}

/**
 * Whether `run` continues a turn on another provider instance (an account move), through
 * restart continuations that never reached their provider. The source turn was interrupted
 * explicitly, so there is no cut turn for the destination to resume natively.
 */
export function continuesAccountMove(
  run: Pick<
    OrchestrationV2Run,
    "id" | "providerInstanceId" | "restartContinuationOfRunId" | "accountMoveContinuation"
  >,
  runs: ReadonlyArray<OrchestrationV2Run>,
  attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerStartRequested">
  >,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
): boolean {
  const visited = new Set<string>([run.id]);
  let current = run;
  while (current.restartContinuationOfRunId !== undefined) {
    if (current.accountMoveContinuation) return true;
    const source = runs.find((candidate) => candidate.id === current.restartContinuationOfRunId);
    if (source === undefined || visited.has(source.id)) return false;
    if (source.providerInstanceId !== current.providerInstanceId) return true;
    if (!neverReachedProvider(source, attempts, providerTurns)) return false;
    visited.add(source.id);
    current = source;
  }
  return false;
}

/**
 * Whether a restart continuation of `source` starts its work over: no run in
 * its restart chain ever reached the provider, so there is no turn to resume.
 */
export function restartStartsOver(
  source: Pick<
    OrchestrationV2Run,
    "id" | "activeAttemptId" | "startedAt" | "restartContinuationOfRunId"
  >,
  runs: ReadonlyArray<OrchestrationV2Run>,
  attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerStartRequested">
  >,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
): boolean {
  const visited = new Set<string>();
  for (
    let run: typeof source | undefined = source;
    run !== undefined && !visited.has(run.id);
    run = runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
  ) {
    visited.add(run.id);
    if (!neverReachedProvider(run, attempts, providerTurns)) return false;
    if (run.restartContinuationOfRunId === undefined) return true;
  }
  return false;
}

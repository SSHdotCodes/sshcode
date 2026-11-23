import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { readyProviderModelSelection } from "@t3tools/shared/serverSettings";
import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isOverviewThreadId,
  OVERVIEW_THREAD_ID_PREFIX,
  ProviderInstanceId,
  ThreadId,
  type MessageId,
  type ModelSelection,
  type ServerProvider,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Overview has no model picker: it runs on this fast, low-usage model when Claude has it. */
export const OVERVIEW_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
  options: [{ id: "effort", value: "high" }],
};

/**
 * The model a new Overview conversation starts on: Claude Haiku on a ready Claude, else a
 * ready provider's cheap default, else Haiku (the send then explains what is missing).
 */
export function overviewModelSelection(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): ModelSelection {
  const ready = readyProviderModelSelection(providers ?? [], {
    preferred: (model) => model.slug === OVERVIEW_MODEL_SELECTION.model,
    byDriver: DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  });
  if (ready === null) return OVERVIEW_MODEL_SELECTION;
  return ready.model === OVERVIEW_MODEL_SELECTION.model
    ? { ...OVERVIEW_MODEL_SELECTION, instanceId: ready.instanceId }
    : ready;
}

/** Each device keeps its own on/off switch for the prototype; it starts on. */
export const OVERVIEW_ENABLED_STORAGE_KEY = "t3code:overview-enabled";

/** Questions to start from when the conversation is empty. */
export const OVERVIEW_SUGGESTIONS = [
  "What's going on?",
  "Does anything need me?",
  "What finished recently?",
] as const;

export function makeOverviewThreadId(uuid: string): ThreadId {
  return ThreadId.make(`${OVERVIEW_THREAD_ID_PREFIX}${uuid}`);
}

/** The conversation Overview continues: the newest one still around. */
export function currentOverviewThread(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShell | null {
  let current: OrchestrationV2ThreadShell | null = null;
  for (const thread of threads) {
    if (!isOverviewThreadId(thread.id) || thread.deletedAt !== null || thread.archivedAt !== null) {
      continue;
    }
    if (
      current === null ||
      DateTime.toEpochMillis(thread.createdAt) > DateTime.toEpochMillis(current.createdAt)
    ) {
      current = thread;
    }
  }
  return current;
}

export interface OverviewEntry {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
}

/**
 * The user's questions and, for each answer, only Overview's latest words: an
 * aside it writes before reading a chat is replaced by the reply that follows.
 */
export function overviewEntries(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
): ReadonlyArray<OverviewEntry> {
  const entries: Array<OverviewEntry & { readonly runId: string | null }> = [];
  for (const message of projection.messages) {
    if (message.role === "system" || message.text.trim().length === 0) continue;
    const entry = {
      id: message.id,
      role: message.role,
      text: overviewMessageText(message.text.trim(), message.context),
      streaming: message.streaming,
      runId: message.runId,
    };
    const previous = entries.at(-1);
    if (
      entry.role === "assistant" &&
      previous?.role === "assistant" &&
      previous.runId === entry.runId
    ) {
      entries[entries.length - 1] = entry;
    } else {
      entries.push(entry);
    }
  }
  return entries.map(({ runId: _runId, ...entry }) => entry);
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function overviewIsWorking(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): boolean {
  return projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
}

/** Overview feeds use ordinary thread links; the stored prompt retains its structured context. */
export function overviewMessageText(text: string, context?: OrchestrationMessageContext): string {
  return replaceComposerContextReferences(text, (reference) => {
    const record = context?.records.find((entry) => entry.contextId === reference.contextId);
    return record?.kind === "thread" && !("payload" in record)
      ? formatThreadLink(record.threadId, reference.label)
      : reference.source;
  });
}

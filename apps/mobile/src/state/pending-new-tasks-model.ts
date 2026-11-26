import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import type { QueuedThreadCreation, QueuedThreadMessage } from "./thread-outbox-model";
import { isNewTaskDraftKey } from "./new-task-draft-key";
import type { ComposerDraft } from "./use-composer-drafts";

/**
 * Unsent work that will become a thread, shaped for thread-list presentation.
 * A `pending` task sits in the outbox and sends itself when its environment
 * reconnects; a `draft` is new-task composer content, which only sends when
 * the user submits it. Both share the list slot so the user can find
 * everything they have written but not yet started in one place.
 */
export type PendingNewTask = PendingQueuedTask | PendingDraftTask;

export interface PendingQueuedTask {
  readonly kind: "pending";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string | undefined;
  readonly projectCwd: string | undefined;
  readonly branch: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
}

export interface PendingDraftTask {
  readonly kind: "draft";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: undefined;
  readonly projectCwd: undefined;
  readonly branch: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly draftKey: string;
  readonly draft: ComposerDraft;
}

/**
 * Settings-only drafts (a model pick with no text) are not work the user
 * would look for in the list; only text or attachments make a draft visible.
 */
export function composerDraftHasUserContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

/**
 * A draft's row title: what the user wrote. Attached pictures sit in the text as chips whose
 * labels are file names ("IMG_0006.jpg"), which say nothing in a list, so they are counted
 * instead of read out.
 */
function draftTitle(draft: ComposerDraft): string {
  const written = replaceComposerContextReferences(draft.text, (reference) =>
    reference.kind === "image" ? "" : reference.source,
  );
  if (written.trim().length > 0) {
    return deriveThreadTitleFromPrompt(written);
  }
  const count = draft.attachments.length;
  if (count > 0 && draft.attachments.every((attachment) => attachment.type === "image")) {
    return count === 1 ? "1 photo" : `${count} photos`;
  }
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

export function buildPendingNewTasks(input: {
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
}): ReadonlyArray<PendingNewTask> {
  const tasks: PendingNewTask[] = [];
  for (const message of input.queuedMessages) {
    if (!message.creation) {
      continue;
    }
    tasks.push({
      kind: "pending",
      key: `pending-task:${message.messageId}`,
      environmentId: message.environmentId,
      projectId: message.creation.projectId,
      projectTitle: message.creation.projectTitle,
      projectCwd: message.creation.projectCwd,
      branch: message.creation.branch,
      title: deriveThreadTitleFromPrompt(message.text),
      createdAt: message.createdAt,
      message,
      creation: message.creation,
    });
  }
  for (const [draftKey, draft] of Object.entries(input.drafts)) {
    if (!isNewTaskDraftKey(draftKey) || !draft.project || !composerDraftHasUserContent(draft)) {
      continue;
    }
    tasks.push({
      kind: "draft",
      key: `draft-task:${draftKey}`,
      environmentId: draft.project.environmentId,
      projectId: draft.project.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      branch: draft.workspaceSelection?.branch ?? null,
      title: draftTitle(draft),
      createdAt: draft.project.createdAt,
      draftKey,
      draft,
    });
  }
  // Drafts are what the user is writing now, so they lead; within each kind,
  // newest first.
  tasks.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "draft" ? -1 : 1;
    }
    return right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key);
  });
  return tasks;
}

/** Existing-thread typing must not change the input to the home list. */
export function createNewTaskDraftsSelector() {
  let previous: Readonly<Record<string, ComposerDraft>> = {};
  let previousCount = 0;
  return (drafts: Readonly<Record<string, ComposerDraft>>) => {
    const keys = Object.keys(drafts).filter(isNewTaskDraftKey);
    if (keys.length === previousCount && keys.every((key) => drafts[key] === previous[key]))
      return previous;
    previous = Object.fromEntries(keys.map((key) => [key, drafts[key]!]));
    previousCount = keys.length;
    return previous;
  };
}

/** Keep the published list stable when unrelated outbox messages change. */
export function createPendingNewTasksSelector() {
  let previous: ReadonlyArray<PendingNewTask> = [];
  return (input: Parameters<typeof buildPendingNewTasks>[0]) => {
    const tasks = buildPendingNewTasks(input);
    if (
      tasks.length === previous.length &&
      tasks.every((task, index) => {
        const before = previous[index];
        return (
          task.key === before?.key &&
          task.kind === before.kind &&
          (task.kind === "draft" && before.kind === "draft"
            ? task.draft === before.draft
            : task.kind === "pending" &&
              before.kind === "pending" &&
              task.message === before.message)
        );
      })
    )
      return previous;
    previous = tasks;
    return tasks;
  };
}

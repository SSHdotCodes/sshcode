import { Atom } from "effect/reactivity";
import {
  createNewTaskDraftsSelector,
  createPendingNewTasksSelector,
  type PendingNewTask,
} from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { threadOutboxManager } from "./thread-outbox";
import { useAtomValueWhileVisible } from "./home-route-visibility";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

const selectDrafts = createNewTaskDraftsSelector();
const newTaskDraftsAtom = Atom.make((get) => selectDrafts(get(composerDraftsAtom)));
const selectTasks = createPendingNewTasksSelector();
const pendingNewTasksAtom = Atom.make((get) =>
  selectTasks({
    queuedMessages: flattenQueuedThreadMessages(
      get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    ),
    drafts: get(newTaskDraftsAtom),
  }),
);

export function usePendingNewTasks(visible = true): ReadonlyArray<PendingNewTask> {
  return useAtomValueWhileVisible(pendingNewTasksAtom, visible);
}

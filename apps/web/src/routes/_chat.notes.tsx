import { DefaultHarnessMascot } from "../components/DefaultHarnessMascot";
import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { NoteId, type EnvironmentId, type Note, type NoteOperation } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  ListChecksIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { cn, randomUUID } from "../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

function NoteRow({
  item,
  canEdit,
  mutate,
  startChat,
}: {
  readonly item: Note;
  readonly canEdit: boolean;
  readonly mutate: (operation: NoteOperation) => Promise<boolean>;
  readonly startChat: (text: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: item.id,
    disabled: !canEdit || item.done,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition,
      }}
      className={cn(
        "group flex items-start gap-3 rounded-lg border border-border/60 bg-background px-3 py-2",
        isDragging && "relative z-10 opacity-70",
      )}
    >
      {/* Controls sit in first-line-high boxes so they stay level with the
          idea's first line when it wraps. */}
      <span className="flex h-9 shrink-0 items-center">
        {!item.done ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canEdit}
            aria-label={`Reorder ${item.text}`}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-4" />
          </Button>
        ) : (
          <span aria-hidden className="size-8 shrink-0 sm:size-7" />
        )}
      </span>
      <span className="flex h-9 shrink-0 items-center">
        <Checkbox
          checked={item.done}
          disabled={!canEdit}
          aria-label={`Mark ${item.text} ${item.done ? "not done" : "done"}`}
          onCheckedChange={(done) => void mutate({ type: "setDone", id: item.id, done })}
        />
      </span>
      {/* Wraps instead of scrolling sideways, so a long idea reads in full. */}
      <textarea
        aria-label="Idea text"
        rows={1}
        maxLength={10_000}
        readOnly={!canEdit}
        className={cn(
          "field-sizing-content min-w-0 flex-1 resize-none bg-transparent py-2 text-sm wrap-anywhere outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring rounded-sm",
          item.done && "text-muted-foreground line-through",
        )}
        value={text ?? item.text}
        onChange={(event) => setText(event.target.value)}
        onBlur={async (event) => {
          if (cancelBlur.current) {
            cancelBlur.current = false;
            return;
          }
          if (text === null) return;
          const submitted = event.target.value;
          const trimmed = submitted.trim();
          if (!trimmed) {
            setText(null);
            return;
          }
          if (
            trimmed === item.text ||
            (await mutate({ type: "updateText", id: item.id, text: trimmed }))
          ) {
            setText((current) => (current === submitted ? null : current));
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            cancelBlur.current = true;
            setText(null);
            event.currentTarget.blur();
          }
          // Enter saves instead of adding a line break.
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <div className="flex h-9 shrink-0 items-center gap-1 opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canEdit}
          aria-label="Start a chat"
          title="Start a chat"
          onClick={() => startChat(text?.trim() || item.text)}
        >
          <MessageSquarePlusIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canEdit}
          aria-label={`Delete ${item.text}`}
          onClick={() => void mutate({ type: "delete", id: item.id })}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </li>
  );
}

function EnvironmentNotes({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const query = useEnvironmentQuery(serverEnvironment.notesState({ environmentId, input: {} }));
  const permission = useAtomValue(serverEnvironment.mutateNotes.permissionAtom(environmentId));
  const canEdit = permission && connected && query.isSuccess;
  const runMutation = useAtomCommand(serverEnvironment.mutateNotes, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  const newThread = useNewThreadHandler();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const startingChat = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const items = query.data?.items ?? [];
  // The notes subscription stays open, so it never stops "waiting": it has
  // loaded once its first state has arrived.
  const loading = query.data === null && query.error === null;
  const active = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);

  const mutate = async (operation: NoteOperation) => {
    const result = await runMutation({ environmentId, input: operation });
    if (result._tag === "Success") {
      setError(null);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save this idea.");
    }
    return false;
  };
  const startChat = async (idea: string) => {
    if (startingChat.current) return;
    startingChat.current = true;
    try {
      const project = await openScratchProject(environmentId);
      if (!project) return;
      const draft = await newThread(scopeProjectRef(environmentId, project.id));
      if (draft) useComposerDraftStore.getState().setPrompt(draft.draftId, idea);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start a chat.");
    } finally {
      startingChat.current = false;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-6">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const idea = text.trim();
            if (!idea || !canEdit) return;
            setText("");
            inputRef.current?.focus();
            if (!(await mutate({ type: "add", id: NoteId.make(randomUUID()), text: idea }))) {
              // The add field is one line, so a newline would just vanish.
              setText((current) => (current ? `${idea} ${current}` : idea));
            }
          }}
        >
          <Input
            ref={inputRef}
            aria-label="Add an idea"
            placeholder="Add an idea…"
            maxLength={10_000}
            value={text}
            disabled={!canEdit}
            onChange={(event) => setText(event.target.value)}
          />
        </form>
        {error || query.error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error ?? query.error}
          </p>
        ) : null}
        {!connected ? (
          <p className="mt-3 text-sm text-muted-foreground">Reconnect to sync your ideas.</p>
        ) : null}
        {connected && !permission ? (
          <p className="mt-3 text-sm text-muted-foreground">
            This connection has read-only access to notes.
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active: dragged, over }) => {
              if (!over || dragged.id === over.id) return;
              const from = active.findIndex((item) => item.id === dragged.id);
              const to = active.findIndex((item) => item.id === over.id);
              const item = active[from];
              if (!item || to < 0) return;
              const beforeId = from < to ? (active[to + 1]?.id ?? null) : active[to]!.id;
              void mutate({ type: "reorder", id: item.id, beforeId });
            }}
          >
            <SortableContext
              items={active.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2" aria-label="Ideas">
                {active.map((item) => (
                  <NoteRow
                    key={item.id}
                    item={item}
                    canEdit={canEdit}
                    mutate={mutate}
                    startChat={(idea) => void startChat(idea)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {active.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              {!loading ? (
                <DefaultHarnessMascot environmentId={environmentId} state="idea" />
              ) : null}
              <p className="text-sm text-muted-foreground">
                {loading ? "Loading ideas…" : "A little space for your next idea."}
              </p>
            </div>
          ) : null}
          {done.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={doneOpen}
                  aria-controls="notes-done"
                  onClick={() => setDoneOpen((open) => !open)}
                >
                  <ChevronDownIcon className={cn("size-4", !doneOpen && "-rotate-90")} />
                  Done ({done.length})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEdit}
                  onClick={() => void mutate({ type: "clearDone" })}
                >
                  Clear done
                </Button>
              </div>
              {doneOpen ? (
                <ul id="notes-done" className="flex flex-col gap-2">
                  {done.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      canEdit={canEdit}
                      mutate={mutate}
                      startChat={(idea) => void startChat(idea)}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}

function NotesPage() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === (selected ?? primary)) ?? environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <ListChecksIcon className="size-4" />
        <h1 className="text-sm font-medium">Notes</h1>
        {environments.length > 1 ? (
          <select
            aria-label="Notes environment"
            className="ml-auto bg-background text-sm"
            value={environment?.environmentId}
            onChange={(event) => setSelected(event.target.value as EnvironmentId)}
          >
            {environments.map((entry) => (
              <option key={entry.environmentId} value={entry.environmentId}>
                {entry.label}
              </option>
            ))}
          </select>
        ) : null}
      </WorkspacePageHeader>
      {environment ? (
        <EnvironmentNotes
          key={environment.environmentId}
          environmentId={environment.environmentId}
          connected={environment.connection.phase === "connected"}
        />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          Connect to an environment to keep your ideas in sync.
        </p>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/notes")({ component: NotesPage });

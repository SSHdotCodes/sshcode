import type { EnvironmentId, ThreadId, WorkflowDefinition, WorkflowId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { cn } from "../../lib/utils";
import { ComposerBanner } from "../chat/ComposerBanner";
import type { ComposerCommandItem } from "../chat/ComposerCommandMenu";
import { ListState } from "../ui/list-state";
import { toastManager } from "../ui/toast";
import { useWorkflowCommands, useWorkflowsState } from "./useWorkflows";
import { isAgent } from "./workflowGraph";
import { useWorkflowModelCatalog } from "./workflowModels";

/**
 * `/workflow` in a chat composer: pick a workflow, see it as a chip, and the
 * next send starts a run on that task instead of a normal turn. Keys are
 * composer draft target keys.
 */
interface PendingWorkflow {
  readonly workflowId: WorkflowId;
  readonly name: string;
}

const useComposerWorkflowStore = create<{
  readonly pending: Readonly<Record<string, PendingWorkflow>>;
  readonly pickerFor: string | null;
  readonly setPending: (key: string, workflow: PendingWorkflow | null) => void;
  readonly setPickerFor: (key: string | null) => void;
}>((set) => ({
  pending: {},
  pickerFor: null,
  setPending: (key, workflow) =>
    set((state) => {
      const pending = { ...state.pending };
      if (workflow) pending[key] = workflow;
      else delete pending[key];
      return { pending };
    }),
  setPickerFor: (pickerFor) => set({ pickerFor }),
}));

/** `@` suggestions: workflows whose name contains every typed word, newest first. */
export function matchComposerWorkflowItems(
  workflows: ReadonlyArray<WorkflowDefinition>,
  query: string,
): ComposerCommandItem[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  return workflows
    .filter((workflow) => words.every((word) => workflow.name.toLowerCase().includes(word)))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map((workflow) => {
      const agents = workflow.nodes.filter((node) => node.kind === "agent").length;
      return {
        id: `workflow:${workflow.id}`,
        type: "workflow" as const,
        workflowId: workflow.id,
        label: workflow.name,
        description: `Workflow · ${agents} ${agents === 1 ? "agent" : "agents"}`,
      };
    });
}

/** Attach a workflow to a composer, as picking it from `/workflow` or `@` does. */
export function setComposerWorkflow(key: string, workflow: PendingWorkflow) {
  useComposerWorkflowStore.getState().setPending(key, workflow);
}

export function openComposerWorkflowPicker(key: string) {
  useComposerWorkflowStore.getState().setPickerFor(key);
}

export function useComposerWorkflow(key: string) {
  const pending = useComposerWorkflowStore((state) => state.pending[key] ?? null);
  const pickerOpen = useComposerWorkflowStore((state) => state.pickerFor === key);
  return { pending, pickerOpen };
}

export function ComposerWorkflowPicker({
  environmentId,
  targetKey,
  onPicked,
}: {
  readonly environmentId: EnvironmentId;
  readonly targetKey: string;
  readonly onPicked: () => void;
}) {
  const { state, loading } = useWorkflowsState(environmentId);
  const { describe } = useWorkflowModelCatalog(environmentId);
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const workflows = useMemo(
    () => state.workflows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.workflows],
  );
  const close = useCallback(() => useComposerWorkflowStore.getState().setPickerFor(null), []);
  const pick = useCallback(
    (index: number) => {
      const workflow = workflows[index];
      if (!workflow) return;
      const store = useComposerWorkflowStore.getState();
      store.setPending(targetKey, { workflowId: workflow.id, name: workflow.name });
      store.setPickerFor(null);
      onPicked();
    },
    [onPicked, targetKey, workflows],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + workflows.length) % Math.max(1, workflows.length));
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        pick(active);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, close, pick, workflows.length]);

  return (
    <ComposerBanner.Surface className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap)">
      <div
        role="listbox"
        aria-label="Workflows"
        className="flex max-h-72 flex-col overflow-y-auto p-1.5"
      >
        {workflows.length === 0 ? (
          loading ? (
            <ListState loading size="compact" title="Loading workflows…" />
          ) : (
            <p className="px-3.5 pt-2 pb-5 text-xs text-secondary-label">
              No workflows yet.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  close();
                  void navigate({ to: "/workflows" });
                }}
              >
                Draw one
              </button>
            </p>
          )
        ) : (
          workflows.map((workflow, index) => {
            const agents = workflow.nodes.filter(isAgent);
            const lead = agents.find((node) => node.id === workflow.rootNodeId);
            return (
              <button
                key={workflow.id}
                type="button"
                role="option"
                aria-selected={index === active}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm",
                  index === active && "bg-accent",
                )}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
              >
                <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{workflow.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {lead?.model ? `${describe(lead.model)?.name ?? lead.model.model} leads · ` : ""}
                  {agents.length === 1 ? "1 box" : `${agents.length} boxes`}
                </span>
              </button>
            );
          })
        )}
      </div>
    </ComposerBanner.Surface>
  );
}

export function ComposerWorkflowChip({
  targetKey,
  workflow,
}: {
  readonly targetKey: string;
  readonly workflow: PendingWorkflow;
}) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 pr-1 pl-2 text-xs">
      <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">Workflow</span>
      <span className="truncate font-medium">{workflow.name}</span>
      <button
        type="button"
        aria-label={`Don't use ${workflow.name}`}
        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => useComposerWorkflowStore.getState().setPending(targetKey, null)}
      >
        <XIcon className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * Starts the picked workflow with the prompt as its task. In a chat that
 * exists on the server, that chat leads; from a new draft the run opens its
 * own lead chat. Resolves true when the run started.
 */
export function useStartComposerWorkflow(environmentId: EnvironmentId) {
  const commands = useWorkflowCommands(environmentId);
  const navigate = useNavigate();
  return useCallback(
    async (input: { targetKey: string; task: string; chatThreadId: ThreadId | null }) => {
      const pending = useComposerWorkflowStore.getState().pending[input.targetKey];
      if (!pending) return false;
      const result = await commands.start({
        workflowId: pending.workflowId,
        task: input.task,
        ...(input.chatThreadId ? { chatThreadId: input.chatThreadId } : {}),
      });
      if (!result.ok) {
        if (!result.interrupted) {
          toastManager.add({
            type: "error",
            title: `Couldn't start ${pending.name}`,
            description: result.issues[0]?.message ?? result.message,
          });
        }
        return false;
      }
      useComposerWorkflowStore.getState().setPending(input.targetKey, null);
      if (!input.chatThreadId) {
        void navigate({
          to: "/workflows/$environmentId/runs/$runId",
          params: { environmentId, runId: result.value.runId },
        });
      }
      return true;
    },
    [commands, environmentId, navigate],
  );
}

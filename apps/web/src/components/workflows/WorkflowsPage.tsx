import type {
  EnvironmentId,
  WorkflowAgentStatus,
  WorkflowDefinition,
  WorkflowRun,
} from "@t3tools/contracts";
import { WorkflowId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { RelativeTimeLabel } from "~/components/RelativeTimeLabel";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ModelChip, RunStatusBadge, STATUS_DOT, WorkflowMiniPreview } from "./WorkflowStatus";
import { useNow } from "./useNow";
import { useWorkflowRunTitle } from "./useWorkflowRunTitle";
import { useWorkflowCommands, useWorkflowsState } from "./useWorkflows";
import { exampleWorkflow } from "./workflowExamples";
import {
  boxStatus,
  formatElapsed,
  isAgent,
  isRunLive,
  newWorkflowDefinition,
} from "./workflowGraph";
import { useWorkflowModelCatalog } from "./workflowModels";
import styles from "./workflows.module.css";

export function WorkflowsPage() {
  const primary = usePrimaryEnvironmentId();
  const { environments: allEnvironments } = useEnvironments();
  const environments = allEnvironments.filter(
    (entry) => entry.serverConfig?.settings.workflowsBeta === true,
  );
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === (selected ?? primary)) ?? environments[0];
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <WorkflowIcon className="size-4" />
        <h1 className="text-sm font-medium">Workflows</h1>
        <Badge variant="secondary" size="sm">
          Beta
        </Badge>
        {environments.length > 1 ? (
          <select
            aria-label="Workflows environment"
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
        <EnvironmentWorkflows
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          Connect to an environment to draw workflows.
        </p>
      )}
    </>
  );
}

function EnvironmentWorkflows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const view = useWorkflowsState(environmentId);
  const commands = useWorkflowCommands(environmentId);
  const catalog = useWorkflowModelCatalog(environmentId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { workflows, runs } = view.state;
  const lastRunByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun>();
    for (const run of runs) if (!map.has(run.workflowId)) map.set(run.workflowId, run);
    return map;
  }, [runs]);
  const sortedWorkflows = useMemo(
    () => workflows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [workflows],
  );

  const open = (id: string) =>
    void navigate({
      to: "/workflows/$environmentId/$workflowId",
      params: { environmentId, workflowId: id },
    });
  const save = async (workflow: WorkflowDefinition) => {
    const result = await commands.mutate({ type: "save", workflow });
    if (!result.ok && !result.interrupted) {
      toastManager.add({ type: "error", title: "Couldn't save", description: result.message });
    }
    return result.ok;
  };
  const create = async (example: boolean) => {
    const now = new Date().toISOString();
    const workflow = example
      ? exampleWorkflow(now, false)
      : newWorkflowDefinition("Untitled workflow", now);
    if (await save(workflow)) open(workflow.id);
  };
  const duplicate = async (workflow: WorkflowDefinition) => {
    const now = new Date().toISOString();
    await save({
      ...workflow,
      id: WorkflowId.make(`wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`),
      name: `${workflow.name} copy`.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    });
  };
  const remove = async (workflow: WorkflowDefinition) => {
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(`Delete “${workflow.name}”? Its runs stay.`, {
        variant: "destructive",
      })) ?? false;
    if (!confirmed) return;
    const result = await commands.mutate({ type: "delete", id: workflow.id });
    if (!result.ok && !result.interrupted) {
      toastManager.add({ type: "error", title: "Couldn't delete", description: result.message });
    }
  };

  if (view.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <WorkspacePageContainer>
        {view.error ? (
          <p role="alert" className="text-sm text-destructive">
            {view.error}
          </p>
        ) : null}
        {workflows.length === 0 ? (
          <EmptyWorkflows
            canEdit={view.canEdit}
            describe={catalog.describe}
            onCreate={(example) => void create(example)}
          />
        ) : (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Workflows</h2>
              <Button size="sm" disabled={!view.canEdit} onClick={() => void create(false)}>
                <PlusIcon />
                New workflow
              </Button>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
              {sortedWorkflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  lastRun={lastRunByWorkflow.get(workflow.id)}
                  describe={catalog.describe}
                  canEdit={view.canEdit}
                  renaming={renaming === workflow.id}
                  onOpen={() => open(workflow.id)}
                  onRename={() => setRenaming(workflow.id)}
                  onRenamed={(name) => {
                    setRenaming(null);
                    const trimmed = name.trim();
                    if (trimmed && trimmed !== workflow.name) {
                      void save({
                        ...workflow,
                        name: trimmed,
                        updatedAt: new Date().toISOString(),
                      });
                    }
                  }}
                  onDuplicate={() => void duplicate(workflow)}
                  onDelete={() => void remove(workflow)}
                />
              ))}
            </ul>
          </section>
        )}
        {runs.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Runs</h2>
            <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  environmentId={environmentId}
                  run={run}
                  canEdit={view.canEdit}
                  onOpen={() =>
                    void navigate({
                      to: "/workflows/$environmentId/runs/$runId",
                      params: { environmentId, runId: run.id },
                    })
                  }
                  onCancel={() => void commands.mutate({ type: "cancelRun", runId: run.id })}
                  onDelete={() => void commands.mutate({ type: "deleteRun", runId: run.id })}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </WorkspacePageContainer>
    </div>
  );
}

function EmptyWorkflows({
  canEdit,
  describe,
  onCreate,
}: {
  readonly canEdit: boolean;
  readonly describe: ReturnType<typeof useWorkflowModelCatalog>["describe"];
  readonly onCreate: (example: boolean) => void;
}) {
  // The finished example: short labels and models read better than raw sketch text.
  const example = useMemo(() => exampleWorkflow(new Date(0).toISOString(), true), []);
  return (
    <div className="flex flex-col items-center gap-5 py-10 text-center">
      <WorkflowMiniPreview
        workflow={example}
        describe={describe}
        showNotes={false}
        className="h-64 w-full max-w-xl text-foreground"
      />
      <div className="flex flex-col gap-1.5">
        <h2 className={`${styles.hand} text-2xl`}>Draw a team of agents</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Sketch who leads and who helps, on which models. Starting it opens a lead chat that hands
          work down the boxes you drew.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button disabled={!canEdit} onClick={() => onCreate(false)}>
          <PlusIcon />
          New workflow
        </Button>
        <Button variant="outline" disabled={!canEdit} onClick={() => onCreate(true)}>
          Start from an example
        </Button>
      </div>
    </div>
  );
}

function WorkflowCard({
  workflow,
  lastRun,
  describe,
  canEdit,
  renaming,
  onOpen,
  onRename,
  onRenamed,
  onDuplicate,
  onDelete,
}: {
  readonly workflow: WorkflowDefinition;
  readonly lastRun: WorkflowRun | undefined;
  readonly describe: ReturnType<typeof useWorkflowModelCatalog>["describe"];
  readonly canEdit: boolean;
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onRenamed: (name: string) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}) {
  const models = useMemo(() => {
    const seen = new Map<string, NonNullable<ReturnType<typeof describe>>>();
    for (const node of workflow.nodes) {
      if (!isAgent(node) || !node.model) continue;
      const key = `${node.model.instanceId}:${node.model.model}`;
      const description = describe(node.model);
      if (description && !seen.has(key)) seen.set(key, description);
    }
    return [...seen.values()];
  }, [describe, workflow.nodes]);
  // While its latest run is live, the preview tints each box by how it's doing.
  const liveStatuses = useMemo(() => {
    if (!lastRun || !isRunLive(lastRun.status)) return undefined;
    const statuses = new Map<string, WorkflowAgentStatus>();
    for (const node of lastRun.snapshot.nodes) {
      if (!isAgent(node)) continue;
      statuses.set(node.id, boxStatus(lastRun.agents.filter((agent) => agent.nodeId === node.id)));
    }
    return statuses;
  }, [lastRun]);
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-[border-color,box-shadow] duration-200 hover:border-border hover:shadow-md">
      <button
        type="button"
        className="flex flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
      >
        <div
          className={`${styles.canvas} flex h-32 items-center justify-center border-b border-border/50 bg-muted/30 p-3`}
        >
          <WorkflowMiniPreview
            workflow={workflow}
            statuses={liveStatuses}
            describe={describe}
            showNotes={false}
            area={CARD_PREVIEW_AREA}
            className="h-full w-full"
          />
        </div>
      </button>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          {renaming ? (
            <input
              autoFocus
              aria-label="Workflow name"
              defaultValue={workflow.name}
              maxLength={120}
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium outline-none ring-1 ring-ring"
              onBlur={(event) => onRenamed(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") onRenamed(workflow.name);
              }}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm font-medium outline-none"
              onClick={onOpen}
            >
              {workflow.name}
            </button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`More for ${workflow.name}`}
                  disabled={!canEdit}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onRename}>
                <PencilIcon />
                Rename
              </MenuItem>
              <MenuItem onClick={onDuplicate}>
                <CopyIcon />
                Duplicate
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
          {models.length > 0 ? (
            models
              .slice(0, 3)
              .map((model) => (
                <ModelChip key={`${model.instanceName}:${model.name}`} description={model} />
              ))
          ) : (
            <span className="text-xs text-muted-foreground">No models yet</span>
          )}
          {models.length > 3 ? (
            <span className="text-xs text-muted-foreground">+{models.length - 3}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {lastRun ? (
            <>
              <RunStatusBadge status={lastRun.status} />
              <span>
                <RelativeTimeLabel at={lastRun.createdAt} />
              </span>
            </>
          ) : (
            <span>Never run</span>
          )}
        </div>
      </div>
    </li>
  );
}

/** A card's drawing area in pixels (h-32 less padding, at the usual card width). */
const CARD_PREVIEW_AREA = { width: 230, height: 104 };

function RunRow({
  environmentId,
  run,
  canEdit,
  onOpen,
  onCancel,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
  readonly canEdit: boolean;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  const title = useWorkflowRunTitle(environmentId, run);
  const live = isRunLive(run.status);
  const now = useNow(live);
  const end = run.completedAt
    ? Date.parse(run.completedAt)
    : live
      ? now
      : Date.parse(run.updatedAt);
  const boxes = useMemo(() => {
    const out: Array<{ id: string; status: WorkflowAgentStatus }> = [];
    for (const node of run.snapshot.nodes) {
      if (!isAgent(node)) continue;
      out.push({
        id: node.id,
        status: boxStatus(run.agents.filter((agent) => agent.nodeId === node.id)),
      });
    }
    return out;
  }, [run.agents, run.snapshot.nodes]);
  return (
    <li className="group flex items-center gap-3 bg-card px-3 py-2.5 hover:bg-accent/40">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
      >
        <RunStatusBadge status={run.status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {run.snapshot.name} · <RelativeTimeLabel at={run.createdAt} /> ·{" "}
            {run.agents.length === 1 ? "1 agent" : `${run.agents.length} agents`}
          </span>
        </span>
        <span className="hidden items-center gap-1 sm:flex" aria-hidden>
          {boxes.map((box) => (
            <span
              key={box.id}
              className={cn(
                "size-2 rounded-full transition-colors duration-300",
                STATUS_DOT[box.status],
              )}
            />
          ))}
        </span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatElapsed(end - Date.parse(run.createdAt))}
        </span>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label="Run actions" disabled={!canEdit} />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {live ? (
            <MenuItem onClick={onCancel}>
              <SquareIcon />
              Cancel run
            </MenuItem>
          ) : (
            <MenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              Remove from list
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </li>
  );
}

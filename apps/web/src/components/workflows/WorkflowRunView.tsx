import "@xyflow/react/dist/base.css";

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  currentWorkflowAgents,
  selectedWorkflowAgent,
  workflowAgentsNeedingYou,
  workflowNeedsLabel,
} from "@t3tools/client-runtime/workflow-run";
import type {
  EnvironmentId,
  ThreadId,
  WorkflowAgentStatus,
  WorkflowNodeId,
  WorkflowRun,
  WorkflowRunAgent,
  WorkflowRunId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  Maximize2Icon,
  MessageSquareIcon,
  PencilIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { PanelLoading } from "../ui/panel-loading";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CanvasContext,
  EDGE_TYPES,
  FLOW_CLASS_HOOKS,
  NODE_TYPES,
  type CanvasContextValue,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "./WorkflowCanvasParts";
import { WorkflowRunAgentPanel } from "./WorkflowRunAgentPanel";
import { WorkflowStartDialog } from "./WorkflowStartDialog";
import { RunStatusBadge, STATUS_DOT } from "./WorkflowStatus";
import { useNow } from "./useNow";
import { useWorkflowCommands, useWorkflowsState } from "./useWorkflows";
import {
  AGENT_STATUS_LABEL,
  agentChatTarget,
  countCapacity,
  formatElapsed,
  isAgent,
  isRunLive,
  tidyWorkflow,
  runBoxes,
} from "./workflowGraph";
import { useWorkflowModelCatalog } from "./workflowModels";
import styles from "./workflows.module.css";
import { useWorkflowRunTitle } from "./useWorkflowRunTitle";

const RUN_BOX = { width: 260, height: 132, fanHeight: 172 } as const;

export function WorkflowRunPage({
  environmentId,
  runId,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: WorkflowRunId;
}) {
  const view = useWorkflowsState(environmentId);
  const run = view.state.runs.find((entry) => entry.id === runId) ?? null;
  const navigate = useNavigate();
  if (!run) {
    return (
      <div className="flex h-full flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="All workflows"
            onClick={() => void navigate({ to: "/workflows" })}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="text-sm font-medium">Run</h1>
        </WorkspacePageHeader>
        {view.loading ? (
          <PanelLoading label="Loading run…" toolbar={false} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {view.error ?? "This run is gone."}
          </div>
        )}
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <WorkflowRunView environmentId={environmentId} run={run} canEdit={view.canEdit} />
    </ReactFlowProvider>
  );
}

function RunElapsed({ run }: { readonly run: WorkflowRun }) {
  const live = isRunLive(run.status);
  const now = useNow(live);
  const end = run.completedAt
    ? Date.parse(run.completedAt)
    : live
      ? now
      : Date.parse(run.updatedAt);
  return <span className="tabular-nums">{formatElapsed(end - Date.parse(run.createdAt))}</span>;
}

/** Counts of agents by state, for the header. */
function StatusSummary({ agents }: { readonly agents: ReadonlyArray<WorkflowRunAgent> }) {
  const order: WorkflowAgentStatus[] = [
    "running",
    "waiting",
    "pending",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ];
  const counts = new Map<WorkflowAgentStatus, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const parts = order.filter((status) => counts.has(status));
  if (parts.length === 0) return null;
  return (
    <span className="flex items-center gap-2.5 text-xs text-muted-foreground">
      {parts.map((status) => (
        <span key={status} className="inline-flex items-center gap-1" data-status={status}>
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
          {counts.get(status)} {AGENT_STATUS_LABEL[status].toLowerCase()}
        </span>
      ))}
    </span>
  );
}

function WorkflowRunView({
  environmentId,
  run,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
  readonly canEdit: boolean;
}) {
  const navigate = useNavigate();
  const flow = useReactFlow();
  const runTitle = useWorkflowRunTitle(environmentId, run);
  const commands = useWorkflowCommands(environmentId);
  const catalog = useWorkflowModelCatalog(environmentId);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [againOpen, setAgainOpen] = useState(false);
  // The box whose panel is open, and the agent picked in it (a box can hold several).
  const [selection, setSelection] = useState<{
    readonly nodeId: WorkflowNodeId;
    readonly threadId: ThreadId | null;
  } | null>(null);
  useEffect(() => observeVisibleAnimation(canvasRef.current), []);

  // Lay the snapshot out as a tree with the lead on top; boxes that hold
  // several agents get room for their fan up front so nothing jumps later.
  const layout = useMemo(() => {
    const sized = {
      ...run.snapshot,
      nodes: run.snapshot.nodes.map((node) =>
        isAgent(node)
          ? {
              ...node,
              width: RUN_BOX.width,
              height: countCapacity(node.count) > 1 ? RUN_BOX.fanHeight : RUN_BOX.height,
            }
          : node,
      ),
    };
    return tidyWorkflow(sized);
  }, [run.snapshot]);
  const boxes = useMemo(() => runBoxes({ ...run, snapshot: layout }), [layout, run]);
  const live = isRunLive(run.status);
  const selectedBox = selection ? boxes.get(selection.nodeId) : undefined;
  const selectedAgent = selection ? selectedWorkflowAgent(run.agents, selection) : null;
  const selectedNodeId = selectedBox ? selectedBox.node.id : null;
  const needing = useMemo(() => workflowAgentsNeedingYou(run.agents), [run.agents]);

  const nodes = useMemo(
    (): WorkflowFlowNode[] =>
      layout.nodes.map((node) => {
        const base = {
          id: node.id,
          position: { x: node.x, y: node.y },
          width: node.width,
          height: node.height,
          draggable: false,
          selectable: false,
          selected: node.id === selectedNodeId,
          zIndex: node.kind === "note" ? 0 : 1,
        };
        return node.kind === "agent"
          ? { ...base, type: "agent", data: { node, box: boxes.get(node.id) } }
          : { ...base, type: "note", data: { node } };
      }),
    [boxes, layout.nodes, selectedNodeId],
  );
  const edges = useMemo((): WorkflowFlowEdge[] => {
    const out: WorkflowFlowEdge[] = layout.edges.map((edge) => {
      const child = boxes.get(edge.to);
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: "a",
        targetHandle: "drop",
        type: "workflow",
        selectable: false,
        data: {
          kind: edge.kind,
          flowing: child?.status === "running" || child?.status === "pending",
          dim: child?.status === "planned",
        },
      };
    });
    for (const node of layout.nodes) {
      if (node.kind !== "note" || node.attachedTo === null) continue;
      out.push({
        id: `attach:${node.id}`,
        source: node.id,
        target: node.attachedTo,
        sourceHandle: "a",
        targetHandle: "drop",
        type: "workflow",
        selectable: false,
        data: { kind: "attach" },
      });
    }
    return out;
  }, [boxes, layout.edges, layout.nodes]);

  const connectedIds = useConnectedEnvironmentIds();
  const openThread = useCallback(
    (threadId: string) =>
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } }),
    [environmentId, navigate],
  );
  const chatTarget = useCallback(
    (agent: WorkflowRunAgent) =>
      agentChatTarget(agent, environmentId, (id) => connectedIds.includes(id as EnvironmentId)),
    [connectedIds, environmentId],
  );
  const openAgent = useCallback(
    (agent: WorkflowRunAgent) => {
      const target = chatTarget(agent);
      if (target.kind === "web") {
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      });
    },
    [chatTarget, navigate],
  );
  const pickAgent = useCallback(
    (agent: WorkflowRunAgent) => setSelection({ nodeId: agent.nodeId, threadId: agent.threadId }),
    [],
  );
  const selectedThreadId = selectedAgent?.threadId ?? null;

  const canvasContext = useMemo<CanvasContextValue>(
    () => ({
      mode: "run",
      tool: "hand",
      describe: catalog.describe,
      editingId: null,
      onEditText: () => {},
      onCommitText: () => {},
      onResizeStart: () => {},
      onResizeEnd: () => {},
      onPickAgent: pickAgent,
      selectedThreadId,
    }),
    [catalog.describe, pickAgent, selectedThreadId],
  );

  // Esc closes the panel unless a dialog has it.
  const panelOpen = selection !== null;
  useEffect(() => {
    if (!panelOpen || againOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [againOpen, panelOpen]);

  const runAgain = async (task: string) => {
    const result = await commands.start({ workflowId: run.workflowId, task });
    if (!result.ok) {
      return result.issues.length > 0
        ? `Fix the drawing first: ${result.issues[0]!.message}`
        : result.message;
    }
    setAgainOpen(false);
    void navigate({
      to: "/workflows/$environmentId/runs/$runId",
      params: { environmentId, runId: result.value.runId },
    });
    return null;
  };

  const cancel = async () => {
    setCancelling(true);
    const result = await commands.mutate({ type: "cancelRun", runId: run.id });
    setCancelling(false);
    if (!result.ok && !result.interrupted) {
      toastManager.add({
        type: "error",
        title: "Couldn't cancel the run",
        description: result.message,
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All workflows"
          onClick={() => void navigate({ to: "/workflows" })}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="truncate text-sm font-medium">{run.snapshot.name}</h1>
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          <RunElapsed run={run} />
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {run.origin === "workflows" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/workflows/$environmentId/$workflowId",
                  params: { environmentId, workflowId: run.workflowId },
                })
              }
            >
              <PencilIcon />
              Edit workflow
            </Button>
          ) : null}
          {!live && run.origin === "workflows" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!canEdit}
              onClick={() => setAgainOpen(true)}
            >
              <RotateCcwIcon />
              Run again
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => openThread(run.leadThreadId)}>
            <MessageSquareIcon />
            Open lead chat
          </Button>
          {live ? (
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!canEdit || cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? <Spinner /> : <SquareIcon />}
              Cancel run
            </Button>
          ) : null}
        </div>
      </WorkspacePageHeader>
      {needing.length > 0 ? (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border/60 px-(--workspace-gutter-start) py-1.5">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Needs you</span>
          {needing.map((agent) => (
            <Button
              key={agent.threadId}
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => openAgent(agent)}
            >
              <span className="size-1.5 rounded-full bg-warning" />
              {workflowNeedsLabel(agent)}
            </Button>
          ))}
        </div>
      ) : null}
      {againOpen ? (
        <WorkflowStartDialog
          open
          onOpenChange={setAgainOpen}
          workflowName={run.snapshot.name}
          issues={[]}
          onShowIssues={() => {}}
          onStart={runAgain}
          initialTask={run.task}
        />
      ) : null}
      {run.diagnostics?.length ? (
        <details className="border-b border-border/60 px-(--workspace-gutter-start) py-2 text-xs text-muted-foreground">
          <summary>
            {run.diagnostics.length} execution difference{run.diagnostics.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 list-disc pl-4">
            {run.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.nodeId}:${diagnostic.kind}:${diagnostic.threadId ?? "box"}`}>
                {diagnostic.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex items-center gap-3 border-b border-border/60 px-(--workspace-gutter-start) py-2">
        <Tooltip>
          <TooltipTrigger
            render={<p className="min-w-0 flex-1 truncate text-sm text-foreground/90" />}
          >
            {runTitle}
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-xl whitespace-pre-wrap">
            {run.task}
          </TooltipPopup>
        </Tooltip>
        <StatusSummary agents={currentWorkflowAgents(run.agents)} />
      </div>
      <div ref={canvasRef} className={`${styles.canvas} min-h-0 flex-1`} data-mode="run">
        <CanvasContext value={canvasContext}>
          <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
            {...FLOW_CLASS_HOOKS}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            onNodeClick={(_, node) => {
              if (node.type !== "agent") return;
              const nodeId = node.data.node.id;
              // Reselecting the open box keeps the agent picked in it.
              setSelection((current) =>
                current?.nodeId === nodeId ? current : { nodeId, threadId: null },
              );
            }}
            onPaneClick={() => setSelection(null)}
            panOnDrag
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            minZoom={0.2}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1.3}
              color="var(--wf-grid)"
            />
          </ReactFlow>
        </CanvasContext>
        <div className="absolute bottom-3 left-3 z-10 rounded-xl border border-border/70 bg-popover p-1 shadow-md">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fit to screen"
            onClick={() => void flow.fitView({ padding: 0.2, duration: 240 })}
          >
            <Maximize2Icon />
          </Button>
        </div>
        {selectedBox ? (
          <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-10 flex w-76 flex-col">
            <WorkflowRunAgentPanel
              environmentId={environmentId}
              runId={run.id}
              box={selectedBox}
              agent={selectedAgent}
              canEdit={canEdit}
              catalog={catalog}
              chatTarget={chatTarget}
              onPick={(threadId) => setSelection({ nodeId: selectedBox.node.id, threadId })}
              onOpenAgent={openAgent}
              onClose={() => setSelection(null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

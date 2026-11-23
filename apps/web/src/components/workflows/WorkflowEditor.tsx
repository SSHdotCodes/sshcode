import "@xyflow/react/dist/base.css";

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
} from "@xyflow/react";
import type {
  EnvironmentId,
  ModelSelection,
  WorkflowDefinition,
  WorkflowId,
  WorkflowIssue,
  WorkflowMark,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowRunAgent,
} from "@t3tools/contracts";
import { WORKFLOW_MAX_MARKS } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { validateWorkflow } from "@t3tools/shared/workflows";
import {
  MARK_TEXT_SIZES,
  MARK_WEIGHTS,
  markStrokePath,
  markStrokeSize,
} from "@t3tools/shared/workflowSketch";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CircleAlertIcon,
  EraserIcon,
  HandIcon,
  LockIcon,
  LockOpenIcon,
  Maximize2Icon,
  MinusIcon,
  MousePointer2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SparklesIcon,
  SquareIcon,
  StickyNoteIcon,
  TypeIcon,
  Undo2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { formatShortcutLabel } from "../../keybindings";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CanvasContext,
  EDGE_TYPES,
  FLOW_CLASS_HOOKS,
  MARK_COLORS,
  NODE_TYPES,
  type AgentFlowNode,
  type CanvasContextValue,
  type Highlight,
  type NoteFlowNode,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "./WorkflowCanvasParts";
import { WorkflowInspector } from "./WorkflowInspector";
import { WorkflowStartDialog } from "./WorkflowStartDialog";
import { useWorkflowCommands, useWorkflowsState } from "./useWorkflows";
import {
  diffWorkflows,
  issueKey,
  START_ONLY_ISSUES,
  tidyWorkflow,
  newAgentNode,
  newEdge,
  newNoteNode,
  newTextMark,
  copyMark,
  duplicateNodes,
  strokeMarkFromPoints,
  withDerivedRoot,
  AGENT_BOX,
  DEFAULT_MARK_STYLE,
  NOTE_BOX,
  type MarkStyle,
} from "./workflowGraph";
import { useWorkflowModelCatalog } from "./workflowModels";
import styles from "./workflows.module.css";

type Tool = CanvasContextValue["tool"];

/**
 * React Flow re-renders a node whenever its object changes, so unchanged boxes
 * keep their flow node. Keyed by the immutable workflow node, so edits miss.
 */
const FLOW_NODE_CACHE = new WeakMap<WorkflowNode, AgentFlowNode | NoteFlowNode>();
const MARK_NODE_CACHE = new WeakMap<WorkflowMark, WorkflowFlowNode>();

/** The doc with new marks; a doc that never had marks stays without the key. */
function withMarks(
  doc: WorkflowDefinition,
  marks: ReadonlyArray<WorkflowMark>,
): WorkflowDefinition {
  if (marks === doc.marks || (!doc.marks && marks.length === 0)) return doc;
  return { ...doc, marks };
}

/** A mark with the style patch applied where it fits; the same object when nothing changes. */
function styledMark(mark: WorkflowMark, patch: Partial<MarkStyle>): WorkflowMark {
  const color = patch.color ?? mark.color;
  if (mark.kind === "text") {
    const size = patch.size ?? mark.size;
    return color === mark.color && size === mark.size ? mark : { ...mark, color, size };
  }
  const weight = patch.weight ?? mark.weight;
  return color === mark.color && weight === mark.weight ? mark : { ...mark, color, weight };
}

function applySelection(
  current: ReadonlySet<string>,
  changes: ReadonlyArray<{ readonly id: string; readonly selected: boolean }>,
): ReadonlySet<string> {
  const next = new Set(current);
  for (const change of changes) {
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return next;
}

/** Excalidraw's layout: hand, then numbered tools, each with a letter too. */
const TOOLS: ReadonlyArray<{
  id: Tool;
  label: string;
  key: string;
  digit?: string;
  icon: ReactNode;
}> = [
  { id: "hand", label: "Pan", key: "H", icon: <HandIcon /> },
  { id: "select", label: "Select", key: "V", digit: "1", icon: <MousePointer2Icon /> },
  { id: "box", label: "Agent box", key: "R", digit: "2", icon: <SquareIcon /> },
  { id: "arrow", label: "Arrow", key: "A", digit: "3", icon: <ArrowUpRightIcon /> },
  { id: "pen", label: "Marker", key: "P", digit: "4", icon: <PencilIcon /> },
  { id: "text", label: "Text", key: "T", digit: "5", icon: <TypeIcon /> },
  { id: "note", label: "Note", key: "N", digit: "6", icon: <StickyNoteIcon /> },
  { id: "eraser", label: "Eraser", key: "E", digit: "7", icon: <EraserIcon /> },
];
const MARK_COLOR_LABELS: Readonly<Record<MarkStyle["color"], string>> = {
  ink: "Ink",
  red: "Red",
  green: "Green",
  blue: "Blue",
  orange: "Orange",
};

const DRAFT_ISSUE = (issue: WorkflowIssue) => !START_ONLY_ISSUES.has(issue.message);

/** A shortcut label for this platform: ⌘Z on a Mac, Ctrl+Z elsewhere. */
function keyLabel(key: string, options: { mod?: boolean; shift?: boolean } = {}) {
  return formatShortcutLabel({
    key,
    modKey: options.mod === true,
    shiftKey: options.shift === true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  });
}

interface Proposal {
  readonly base: WorkflowDefinition;
  readonly workflow: WorkflowDefinition;
  readonly summary: string;
  readonly issues: ReadonlyArray<WorkflowIssue>;
}

export function WorkflowEditorPage({
  environmentId,
  workflowId,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflowId: WorkflowId;
}) {
  const view = useWorkflowsState(environmentId);
  const remote = view.state.workflows.find((workflow) => workflow.id === workflowId) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {remote ? (
        <ReactFlowProvider>
          <WorkflowEditor
            key={remote.id}
            environmentId={environmentId}
            remote={remote}
            canEdit={view.canEdit}
          />
        </ReactFlowProvider>
      ) : (
        <>
          <EditorHeader title="Workflow" />
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {view.loading ? <Spinner /> : (view.error ?? "This workflow is gone.")}
          </div>
        </>
      )}
    </div>
  );
}

function EditorHeader({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="All workflows"
        onClick={() => void navigate({ to: "/workflows" })}
      >
        <ArrowLeftIcon />
      </Button>
      {title}
      {children}
    </WorkspacePageHeader>
  );
}

function WorkflowEditor({
  environmentId,
  remote,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly remote: WorkflowDefinition;
  readonly canEdit: boolean;
}) {
  const navigate = useNavigate();
  const flow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();
  const commands = useWorkflowCommands(environmentId);
  const catalog = useWorkflowModelCatalog(environmentId);
  const [doc, setDocState] = useState(remote);
  // Edits read and write the latest doc synchronously; every setDocState goes through it.
  const docRef = useRef(doc);
  const history = useRef<{ past: WorkflowDefinition[]; future: WorkflowDefinition[] }>({
    past: [],
    future: [],
  });
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  const syncHistory = useCallback(
    () =>
      setHistoryDepth({
        past: history.current.past.length,
        future: history.current.future.length,
      }),
    [],
  );
  const [tool, setTool] = useState<Tool>("select");
  // Lock keeps a placing tool active after each use (Excalidraw's Q).
  const [locked, setLocked] = useState(false);
  const [markStyle, setMarkStyle] = useState<MarkStyle>(DEFAULT_MARK_STYLE);
  const doneWithTool = useCallback(() => {
    if (!locked) setTool("select");
  }, [locked]);
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyArray<WorkflowIssue>>([]);
  const [aiOpen, setAiOpen] = useState(remote.nodes.length === 0);
  const [prompt, setPrompt] = useState("");
  const [compileModel, setCompileModel] = useState<ModelSelection | null>(null);
  const [compiling, setCompiling] = useState<"prompt" | "drawing" | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  // A newer copy from another device that arrived while this one had unsaved edits.
  const [conflict, setConflict] = useState<WorkflowDefinition | null>(null);
  const conflictRef = useRef<WorkflowDefinition | null>(null);
  // The stamp of this editor's own last save, so its echo isn't taken for another device.
  const ownSavedAt = useRef(remote.updatedAt);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const savedRef = useRef(remote);
  const canvasRef = useRef<HTMLDivElement>(null);
  // A text mark being typed for the first time, and the doc before it, so
  // placing and typing it is one undo step and an empty one leaves none.
  const pendingText = useRef<{ id: string; before: WorkflowDefinition } | null>(null);
  const gesture = useRef<{
    kind: "pen" | "eraser";
    pointerId: number;
    points: Array<{ x: number; y: number }>;
    screen: number[];
    last: { x: number; y: number };
    erase: Map<string, Element>;
  } | null>(null);
  const draftRef = useRef<SVGPathElement>(null);

  useEffect(() => observeVisibleAnimation(canvasRef.current), []);

  // Another device saved a newer copy: take it when nothing here is unsaved,
  // otherwise ask before either side overwrites the other.
  useEffect(() => {
    if (remote.updatedAt <= savedRef.current.updatedAt || remote.updatedAt <= ownSavedAt.current)
      return;
    if (docRef.current === savedRef.current) {
      savedRef.current = remote;
      docRef.current = remote;
      setDocState(remote);
      return;
    }
    conflictRef.current = remote;
    setConflict(remote);
  }, [remote]);

  /** `record` pushes an undo step; drags and resizes record once, at their start. */
  const setDoc = useCallback(
    (update: (current: WorkflowDefinition) => WorkflowDefinition, record = true) => {
      const current = docRef.current;
      const next = withDerivedRoot(update(current));
      if (next === current) return;
      if (record) {
        history.current.past = [...history.current.past.slice(-99), current];
        history.current.future = [];
        syncHistory();
      }
      docRef.current = next;
      setDocState(next);
      setServerIssues([]);
    },
    [syncHistory],
  );
  const recordStep = useCallback(() => {
    history.current.past = [...history.current.past.slice(-99), docRef.current];
    history.current.future = [];
    syncHistory();
  }, [syncHistory]);
  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(docRef.current);
    docRef.current = previous;
    setDocState(previous);
    syncHistory();
  }, [syncHistory]);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(docRef.current);
    docRef.current = next;
    setDocState(next);
    syncHistory();
  }, [syncHistory]);

  const save = useCallback(async (): Promise<boolean> => {
    // One save at a time, so an older copy can never land after a newer one.
    while (savingRef.current) await savingRef.current;
    const current = docRef.current;
    if (conflictRef.current) return false;
    if (current === savedRef.current || !canEdit) return true;
    const run = (async () => {
      setSaveState("saving");
      const workflow = { ...current, updatedAt: new Date().toISOString() };
      // The server's echo of this save can arrive before the reply: mark it as ours first.
      const previousOwn = ownSavedAt.current;
      ownSavedAt.current = workflow.updatedAt;
      const result = await commands.mutate({ type: "save", workflow });
      if (!result.ok) {
        ownSavedAt.current = previousOwn;
        setSaveState("error");
        if (!result.interrupted) {
          toastManager.add({
            type: "error",
            title: "Workflow not saved",
            description: result.message,
          });
        }
        return false;
      }
      savedRef.current = current;
      // Edits made meanwhile already scheduled the next save.
      setSaveState(docRef.current === current ? "saved" : "saving");
      return true;
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  }, [canEdit, commands]);

  const resolveConflict = useCallback(
    (keep: "theirs" | "mine") => {
      const theirs = conflictRef.current;
      if (!theirs) return;
      conflictRef.current = null;
      setConflict(null);
      if (keep === "mine") {
        // Their copy has been seen; this one saves over it.
        ownSavedAt.current = theirs.updatedAt;
        void save();
        return;
      }
      // Loading theirs is one undo step, so this device's edits aren't lost for good.
      history.current.past = [...history.current.past.slice(-99), docRef.current];
      history.current.future = [];
      syncHistory();
      savedRef.current = theirs;
      docRef.current = theirs;
      setDocState(theirs);
      setSaveState("saved");
    },
    [save, syncHistory],
  );

  // Autosave shortly after edits settle.
  useEffect(() => {
    if (doc === savedRef.current || conflict) return;
    setSaveState("saving");
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [conflict, doc, save]);
  useEffect(() => () => void save(), [save]);

  const issues = useMemo(() => {
    const local = validateWorkflow(doc);
    return serverIssues.length > 0 ? serverIssues : local;
  }, [doc, serverIssues]);
  const visibleIssues = useMemo(
    () => (showAllIssues || serverIssues.length > 0 ? issues : issues.filter(DRAFT_ISSUE)),
    [issues, serverIssues.length, showAllIssues],
  );

  const shown = proposal?.workflow ?? doc;
  const highlights = useMemo(() => {
    if (!proposal) return null;
    const diff = diffWorkflows(proposal.base, proposal.workflow);
    const map = new Map<string, Highlight>();
    for (const id of diff.added) map.set(id, "added");
    for (const id of diff.changed) map.set(id, "changed");
    return map;
  }, [proposal]);

  const nodes = useMemo(() => {
    const issueByNode = new Map<string, string>();
    const issueList = proposal ? proposal.issues : visibleIssues;
    for (const issue of issueList) {
      if (issue.nodeId && !issueByNode.has(issue.nodeId))
        issueByNode.set(issue.nodeId, issue.message);
    }
    const out = shown.nodes.map((node): WorkflowFlowNode => {
      const selected = !proposal && selectedNodes.has(node.id);
      const highlight = highlights?.get(node.id);
      const issue = issueByNode.get(node.id);
      const cached = FLOW_NODE_CACHE.get(node);
      if (
        cached &&
        cached.selected === selected &&
        cached.data.highlight === highlight &&
        (cached.type === "note" || cached.data.issue === issue) &&
        cached.draggable === (tool === "select" && !proposal && canEdit)
      ) {
        return cached;
      }
      const base = {
        id: node.id,
        position: { x: node.x, y: node.y },
        width: node.width,
        height: node.height,
        selected,
        draggable: tool === "select" && !proposal && canEdit,
        zIndex: node.kind === "note" ? 0 : 1,
      };
      const flowNode: AgentFlowNode | NoteFlowNode =
        node.kind === "agent"
          ? { ...base, type: "agent", data: { node, issue, highlight } }
          : { ...base, type: "note", data: { node, highlight } };
      FLOW_NODE_CACHE.set(node, flowNode);
      return flowNode;
    });
    const draggable = tool === "select" && !proposal && canEdit;
    for (const mark of shown.marks ?? []) {
      const selected = !proposal && selectedNodes.has(mark.id);
      const cached = MARK_NODE_CACHE.get(mark);
      if (cached && cached.selected === selected && cached.draggable === draggable) {
        out.push(cached);
        continue;
      }
      const base = {
        id: mark.id,
        position: { x: mark.x, y: mark.y },
        selected,
        draggable,
        connectable: false,
        zIndex: 2,
      };
      const flowNode: WorkflowFlowNode =
        mark.kind === "text"
          ? { ...base, type: "textMark", data: { mark } }
          : {
              ...base,
              type: "strokeMark",
              data: { mark },
              ...markStrokeSize(mark),
              // Only the drawn line takes the pointer, never its whole box.
              style: { pointerEvents: "none" },
            };
      MARK_NODE_CACHE.set(mark, flowNode);
      out.push(flowNode);
    }
    return out;
  }, [canEdit, highlights, proposal, selectedNodes, shown.marks, shown.nodes, tool, visibleIssues]);

  const edges = useMemo(() => {
    const issueByEdge = new Map<string, string>();
    for (const issue of proposal ? proposal.issues : visibleIssues) {
      if (issue.edgeId && !issueByEdge.has(issue.edgeId))
        issueByEdge.set(issue.edgeId, issue.message);
    }
    const out: WorkflowFlowEdge[] = shown.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: "a",
      targetHandle: "drop",
      type: "workflow",
      selected: !proposal && selectedEdges.has(edge.id),
      data: {
        kind: edge.kind,
        issue: issueByEdge.get(edge.id),
        highlight: highlights?.get(edge.id),
      },
    }));
    for (const node of shown.nodes) {
      if (node.kind !== "note" || node.attachedTo === null) continue;
      const id = `attach:${node.id}`;
      out.push({
        id,
        source: node.id,
        target: node.attachedTo,
        sourceHandle: "a",
        targetHandle: "drop",
        type: "workflow",
        selected: !proposal && selectedEdges.has(id),
        data: { kind: "attach" },
      });
    }
    return out;
  }, [highlights, proposal, selectedEdges, shown.edges, shown.nodes, visibleIssues]);

  const updateNode = useCallback(
    (id: string, patch: (node: WorkflowNode) => WorkflowNode, record = true) =>
      setDoc((current) => {
        const target = current.nodes.find((node) => node.id === id);
        const next = target && patch(target);
        // An unchanged node leaves the doc alone, so no undo step or save.
        if (!target || !next || next === target) return current;
        return { ...current, nodes: current.nodes.map((node) => (node === target ? next : node)) };
      }, record),
    [setDoc],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const selects = changes.filter((change) => change.type === "select");
      const moves = new Map<string, Partial<WorkflowNode>>();
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moves.set(change.id, {
            ...moves.get(change.id),
            x: Math.round(change.position.x),
            y: Math.round(change.position.y),
          });
        } else if (change.type === "dimensions" && change.resizing && change.dimensions) {
          moves.set(change.id, {
            ...moves.get(change.id),
            width: Math.round(change.dimensions.width),
            height: Math.round(change.dimensions.height),
          });
        }
      }
      if (selects.length > 0) setSelectedNodes((current) => applySelection(current, selects));
      if (moves.size > 0 && !proposal) {
        setDoc((current) => {
          const marks = current.marks?.map((mark) => {
            const move = moves.get(mark.id);
            return move?.x === undefined || move.y === undefined
              ? mark
              : { ...mark, x: move.x, y: move.y };
          });
          return withMarks(
            {
              ...current,
              nodes: current.nodes.map((node) => {
                const move = moves.get(node.id);
                return move ? ({ ...node, ...move } as WorkflowNode) : node;
              }),
            },
            marks ?? [],
          );
        }, false);
      }
    },
    [proposal, setDoc],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowFlowEdge>[]) => {
    const selects = changes.filter((change) => change.type === "select");
    if (selects.length > 0) setSelectedEdges((current) => applySelection(current, selects));
  }, []);

  const connect = useCallback(
    (from: string, to: string) => {
      setDoc((current) => {
        const byId = new Map(current.nodes.map((node) => [node.id, node]));
        const source = byId.get(from as WorkflowNodeId);
        const target = byId.get(to as WorkflowNodeId);
        if (!source || !target || from === to) return current;
        if (source.kind === "note" || target.kind === "note") {
          const note = source.kind === "note" ? source : target;
          const agent = source.kind === "note" ? target : source;
          if (note.kind !== "note" || agent.kind !== "agent") return current;
          return {
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === note.id ? { ...note, attachedTo: agent.id } : node,
            ),
          };
        }
        if (current.edges.some((edge) => edge.from === from && edge.to === to)) return current;
        // Two boxes started by the same parent most likely run one after the other.
        const parentOf = (id: string) =>
          current.edges.find((edge) => edge.kind === "delegates" && edge.to === id)?.from;
        const siblings = parentOf(from) !== undefined && parentOf(from) === parentOf(to);
        return {
          ...current,
          edges: [...current.edges, newEdge(source.id, target.id, siblings ? "then" : "delegates")],
        };
      });
    },
    [setDoc],
  );

  const addNode = useCallback(
    (kind: "agent" | "note", center: { x: number; y: number }, edit = true) => {
      const size = kind === "agent" ? AGENT_BOX : NOTE_BOX;
      const position = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
      const node = kind === "agent" ? newAgentNode(position) : newNoteNode(position);
      setDoc((current) => ({ ...current, nodes: [...current.nodes, node] }));
      setSelectedNodes(new Set([node.id]));
      setSelectedEdges(new Set());
      if (edit) setEditingId(node.id);
      return node;
    },
    [setDoc],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode || !canEdit) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      // Dropping an arrow on empty canvas draws the box it points at.
      const center = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const from = state.fromNode.id;
      const fromKind = docRef.current.nodes.find((node) => node.id === from)?.kind;
      if (fromKind !== "agent") return;
      const node = addNode("agent", { x: center.x, y: center.y + AGENT_BOX.height / 2 });
      connect(from, node.id);
    },
    [addNode, canEdit, connect, flow],
  );

  /** Removes boxes, notes, marks (by node id) and arrows (by edge id) in one undo step. */
  const removeIds = useCallback(
    (gone: ReadonlySet<string>, goneEdges: ReadonlySet<string>) => {
      if (gone.size === 0 && goneEdges.size === 0) return;
      setDoc((current) =>
        withMarks(
          {
            ...current,
            nodes: current.nodes
              .filter((node) => !gone.has(node.id))
              .map((node) =>
                node.kind === "note" &&
                node.attachedTo !== null &&
                (gone.has(node.attachedTo) || goneEdges.has(`attach:${node.id}`))
                  ? { ...node, attachedTo: null }
                  : node,
              ),
            edges: current.edges.filter(
              (edge) => !goneEdges.has(edge.id) && !gone.has(edge.from) && !gone.has(edge.to),
            ),
          },
          current.marks?.filter((mark) => !gone.has(mark.id)) ?? [],
        ),
      );
    },
    [setDoc],
  );
  const removeSelection = useCallback(() => {
    removeIds(selectedNodes, selectedEdges);
    setSelectedNodes(new Set());
    setSelectedEdges(new Set());
  }, [removeIds, selectedEdges, selectedNodes]);

  const duplicateSelection = useCallback(() => {
    if (selectedNodes.size === 0) return;
    const { nodes: copies, edges: edgeCopies } = duplicateNodes(
      docRef.current,
      selectedNodes,
      32,
      32,
    );
    const markCopies = (docRef.current.marks ?? [])
      .filter((mark) => selectedNodes.has(mark.id))
      .map((mark) => copyMark(mark, 32, 32))
      .slice(0, WORKFLOW_MAX_MARKS - (docRef.current.marks?.length ?? 0));
    setDoc((current) =>
      withMarks(
        {
          ...current,
          nodes: [...current.nodes, ...copies],
          edges: [...current.edges, ...edgeCopies],
        },
        [...(current.marks ?? []), ...markCopies],
      ),
    );
    setSelectedNodes(new Set([...copies, ...markCopies].map((item) => item.id)));
  }, [selectedNodes, setDoc]);

  const marksFull = useCallback(() => {
    if ((docRef.current.marks?.length ?? 0) < WORKFLOW_MAX_MARKS) return false;
    toastManager.add({
      type: "error",
      title: "Canvas is full",
      description: `A workflow keeps up to ${WORKFLOW_MAX_MARKS} drawings and texts. Erase some first.`,
    });
    return true;
  }, []);

  const placeText = useCallback(
    (point: { x: number; y: number }) => {
      if (marksFull()) return;
      const mark = newTextMark(
        { x: point.x - 4, y: point.y - MARK_TEXT_SIZES[markStyle.size] * 0.7 },
        markStyle,
      );
      pendingText.current = { id: mark.id, before: docRef.current };
      setDoc((current) => withMarks(current, [...(current.marks ?? []), mark]), false);
      setSelectedNodes(new Set([mark.id]));
      setSelectedEdges(new Set());
      setEditingId(mark.id);
      doneWithTool();
    },
    [doneWithTool, markStyle, marksFull, setDoc],
  );

  const commitMarkText = useCallback(
    (id: string, text: string) => {
      const pending = pendingText.current?.id === id ? pendingText.current : null;
      if (pending) pendingText.current = null;
      const mark = docRef.current.marks?.find((entry) => entry.id === id);
      if (!mark || mark.kind !== "text") return;
      if (!text.trim()) {
        // Cleared text goes away; a fresh empty one leaves no undo step.
        setDoc(
          (current) => withMarks(current, current.marks?.filter((entry) => entry.id !== id) ?? []),
          !pending,
        );
        setSelectedNodes((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        return;
      }
      if (mark.text === text) return;
      if (pending) {
        history.current.past = [...history.current.past.slice(-99), pending.before];
        history.current.future = [];
        syncHistory();
      }
      setDoc(
        (current) =>
          withMarks(
            current,
            current.marks?.map((entry) =>
              entry.id === id && entry.kind === "text" ? { ...entry, text } : entry,
            ) ?? [],
          ),
        !pending,
      );
    },
    [setDoc, syncHistory],
  );

  const selectedMarks = useMemo(
    () => (doc.marks ?? []).filter((mark) => selectedNodes.has(mark.id)),
    [doc.marks, selectedNodes],
  );
  /** Sets the style for new marks and restyles the selected ones, like Excalidraw. */
  const applyMarkStyle = useCallback(
    (patch: Partial<MarkStyle>) => {
      setMarkStyle((current) => ({ ...current, ...patch }));
      if (selectedMarks.length === 0) return;
      const ids = new Set(selectedMarks.map((mark) => mark.id));
      setDoc((current) => {
        let changed = false;
        const marks =
          current.marks?.map((mark) => {
            if (!ids.has(mark.id)) return mark;
            const next = styledMark(mark, patch);
            if (next !== mark) changed = true;
            return next;
          }) ?? [];
        return changed ? withMarks(current, marks) : current;
      });
    },
    [selectedMarks, setDoc],
  );

  // Marker and eraser gestures: the canvas takes the pointer before React Flow does.
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const eraseAt = (clientX: number, clientY: number, erase: Map<string, Element>) => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      if (element.closest(".react-flow__panel")) return;
      const item = element.closest(".react-flow__node, .react-flow__edge");
      const id = item?.getAttribute("data-id");
      if (!item || !id) continue;
      if (!erase.has(id)) {
        erase.set(id, item);
        item.setAttribute("data-erasing", "true");
      }
      return;
    }
  };
  const startGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (proposal || !canEdit || event.button !== 0) return;
    if (tool !== "pen" && tool !== "eraser") return;
    const target = event.target as Element;
    if (!target.closest(".react-flow") || target.closest(".react-flow__panel")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const local = localPoint(event);
    gesture.current = {
      kind: tool,
      pointerId: event.pointerId,
      points: [flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })],
      screen: [local.x, local.y],
      last: { x: event.clientX, y: event.clientY },
      erase: new Map(),
    };
    if (tool === "eraser") {
      eraseAt(event.clientX, event.clientY, gesture.current.erase);
      return;
    }
    const path = draftRef.current;
    if (path) {
      path.setAttribute("stroke", MARK_COLORS[markStyle.color]);
      path.setAttribute("stroke-width", String(MARK_WEIGHTS[markStyle.weight] * flow.getZoom()));
      path.setAttribute("d", markStrokePath(gesture.current.screen));
    }
  };
  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
      if (current.kind === "eraser") {
        // Fill fast sweeps so nothing between two samples is skipped.
        const dx = sample.clientX - current.last.x;
        const dy = sample.clientY - current.last.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 6));
        for (let i = 1; i <= steps; i++) {
          eraseAt(
            current.last.x + (dx * i) / steps,
            current.last.y + (dy * i) / steps,
            current.erase,
          );
        }
      } else {
        current.points.push(flow.screenToFlowPosition({ x: sample.clientX, y: sample.clientY }));
        const local = localPoint(sample);
        current.screen.push(local.x, local.y);
      }
      current.last = { x: sample.clientX, y: sample.clientY };
    }
    if (current.kind === "pen") {
      const path = draftRef.current;
      path?.setAttribute("d", markStrokePath(current.screen));
      // A pinch mid-stroke changes the zoom; the preview keeps the saved width.
      path?.setAttribute("stroke-width", String(MARK_WEIGHTS[markStyle.weight] * flow.getZoom()));
    }
  };
  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    draftRef.current?.setAttribute("d", "");
    if (current.kind === "eraser") {
      for (const element of current.erase.values()) element.removeAttribute("data-erasing");
      if (cancelled) return;
      const ids = new Set(current.erase.keys());
      const edgeIds = new Set(
        [...ids].filter((id) => current.erase.get(id)?.classList.contains("react-flow__edge")),
      );
      removeIds(new Set([...ids].filter((id) => !edgeIds.has(id))), edgeIds);
      setSelectedNodes((selected) => new Set([...selected].filter((id) => !ids.has(id))));
      setSelectedEdges((selected) => new Set([...selected].filter((id) => !ids.has(id))));
      return;
    }
    if (cancelled || marksFull()) return;
    const mark = strokeMarkFromPoints(current.points, markStyle, 1.2 / flow.getZoom());
    if (mark) setDoc((doc) => withMarks(doc, [...(doc.marks ?? []), mark]));
  };

  const tidy = useCallback(() => {
    setDoc((current) => tidyWorkflow(current));
    requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 320 }));
  }, [flow, setDoc]);

  const compile = useCallback(
    async (kind: "prompt" | "drawing") => {
      if (!(await save())) return;
      setCompiling(kind);
      const base = docRef.current;
      const result = await commands.compile({
        workflow: base,
        ...(kind === "prompt" && prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(compileModel ? { model: compileModel } : {}),
      });
      setCompiling(null);
      if (!result.ok) {
        if (!result.interrupted) {
          toastManager.add({
            type: "error",
            title: "Couldn't make it",
            description: result.message,
          });
        }
        return;
      }
      setProposal({ base, ...result.value });
      setSelectedNodes(new Set());
      setSelectedEdges(new Set());
      requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 320 }));
    },
    [commands, compileModel, flow, prompt, save],
  );

  const applyProposal = useCallback(() => {
    if (!proposal) return;
    const { workflow } = proposal;
    setDoc((current) => ({ ...workflow, id: current.id, createdAt: current.createdAt }));
    setProposal(null);
    setPrompt("");
    setAiOpen(false);
  }, [proposal, setDoc]);

  const start = useCallback(
    async (task: string) => {
      if (!(await save())) return "Save the workflow first.";
      const result = await commands.start({ workflowId: docRef.current.id, task });
      if (!result.ok) {
        if (result.issues.length > 0) {
          setServerIssues(result.issues);
          setShowAllIssues(true);
          setStartOpen(false);
          return null;
        }
        return result.message;
      }
      setStartOpen(false);
      void navigate({
        to: "/workflows/$environmentId/runs/$runId",
        params: { environmentId, runId: result.value.runId },
      });
      return null;
    },
    [commands, environmentId, navigate, save],
  );

  // Excalidraw-style shortcuts, ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (document.querySelector("[role=dialog]")) return;
      // Keys typed into an open menu or list (the model picker) aren't canvas shortcuts.
      if (target?.closest("[role=menu],[role=listbox],[role=menuitem],[role=option]")) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        if (proposal) return;
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && key === "a") {
        event.preventDefault();
        setSelectedNodes(
          new Set([
            ...docRef.current.nodes.map((node) => node.id),
            ...(docRef.current.marks ?? []).map((mark) => mark.id),
          ]),
        );
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        if (!proposal) duplicateSelection();
        return;
      }
      if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        void flow.zoomIn({ duration: 160 });
        return;
      }
      if (mod && key === "-") {
        event.preventDefault();
        void flow.zoomOut({ duration: 160 });
        return;
      }
      if (mod && key === "0") {
        event.preventDefault();
        void flow.zoomTo(1, { duration: 160 });
        return;
      }
      if (mod || event.altKey) return;
      if (event.shiftKey && (key === "!" || event.code === "Digit1")) {
        event.preventDefault();
        void flow.fitView({ padding: 0.2, duration: 240 });
        return;
      }
      if (key === "escape") {
        if (proposal) setProposal(null);
        else if (tool !== "select") setTool("select");
        else {
          setSelectedNodes(new Set());
          setSelectedEdges(new Set());
        }
        return;
      }
      if (proposal || !canEdit) return;
      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        removeSelection();
        return;
      }
      if (key === "enter" && selectedNodes.size === 1) {
        const id = [...selectedNodes][0]!;
        const stroke = docRef.current.marks?.some(
          (mark) => mark.id === id && mark.kind === "stroke",
        );
        if (stroke) return;
        event.preventDefault();
        setEditingId(id);
        return;
      }
      if (key === "q") {
        setLocked((value) => !value);
        return;
      }
      const picked = TOOLS.find((entry) => entry.key.toLowerCase() === key || entry.digit === key);
      if (picked) setTool(picked.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    canEdit,
    duplicateSelection,
    flow,
    proposal,
    redo,
    removeSelection,
    selectedNodes,
    tool,
    undo,
  ]);

  const canvasContext = useMemo<CanvasContextValue>(
    () => ({
      mode: proposal ? "proposal" : "edit",
      tool,
      describe: catalog.describe,
      editingId,
      onEditText: setEditingId,
      onCommitText: (id, text) => {
        if (docRef.current.marks?.some((mark) => mark.id === id)) {
          commitMarkText(id, text);
          return;
        }
        updateNode(id, (node) => (node.text === text ? node : ({ ...node, text } as WorkflowNode)));
      },
      onResizeStart: recordStep,
      onResizeEnd: () => {},
      onPickAgent: (_agent: WorkflowRunAgent) => {},
    }),
    [catalog.describe, commitMarkText, editingId, proposal, recordStep, tool, updateNode],
  );

  const selectedNode =
    selectedNodes.size === 1 ? doc.nodes.find((node) => selectedNodes.has(node.id)) : undefined;
  const selectedEdgeId =
    selectedEdges.size === 1 && selectedNodes.size === 0 ? [...selectedEdges][0] : undefined;
  const issueCount = issues.length;
  const defaultCompileModel = useMemo(() => {
    for (const entry of catalog.instanceEntries) {
      const terra = entry.models.find((model) => /terra/iu.test(model.slug));
      if (terra) return createModelSelection(entry.instanceId, terra.slug);
    }
    return null;
  }, [catalog.instanceEntries]);
  const pickerSelection = compileModel ?? defaultCompileModel;

  return (
    <>
      <EditorHeader
        title={
          <WorkflowNameInput
            name={doc.name}
            readOnly={!canEdit}
            onCommit={(name) => setDoc((current) => ({ ...current, name }), false)}
          />
        }
      >
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {!canEdit
            ? "Read only"
            : conflict
              ? "Changed on another device"
              : saveState === "saving"
                ? "Saving…"
                : saveState === "error"
                  ? "Not saved"
                  : "Saved"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {issueCount > 0 && !proposal ? (
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() => {
                setShowAllIssues(true);
                const first = issues.find((issue) => issue.nodeId);
                if (first?.nodeId) {
                  setSelectedNodes(new Set([first.nodeId]));
                  void flow.fitView({ nodes: [{ id: first.nodeId }], padding: 1.2, duration: 280 });
                }
              }}
            >
              <CircleAlertIcon className={cn(showAllIssues && "text-destructive")} />
              {issueCount === 1 ? "1 to fix" : `${issueCount} to fix`}
            </Button>
          ) : null}
          <Button
            variant={aiOpen ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={aiOpen}
            onClick={() => setAiOpen((open) => !open)}
          >
            <SparklesIcon />
            Make with AI
          </Button>
          <Button
            size="sm"
            disabled={!canEdit || proposal !== null}
            onClick={() => {
              setShowAllIssues(true);
              setStartOpen(true);
            }}
          >
            <PlayIcon />
            Start
          </Button>
        </div>
      </EditorHeader>
      <div className="flex min-h-0 flex-1">
        <div
          ref={canvasRef}
          className={`${styles.canvas} min-w-0 flex-1`}
          data-tool={proposal ? "select" : tool}
          onPointerDownCapture={startGesture}
          onPointerMove={moveGesture}
          onPointerUp={(event) => endGesture(event)}
          onPointerCancel={(event) => endGesture(event, true)}
          onClickCapture={(event) => {
            // A marker or eraser stroke never also selects what it crossed.
            if (tool !== "pen" && tool !== "eraser") return;
            const target = event.target as Element;
            if (target.closest(".react-flow") && !target.closest(".react-flow__panel")) {
              event.stopPropagation();
            }
          }}
          onDoubleClick={(event) => {
            if (proposal || !canEdit || tool !== "select") return;
            if (!(event.target as Element).closest(".react-flow__pane")) return;
            addNode("agent", flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
          }}
        >
          <CanvasContext value={canvasContext}>
            <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
              {...FLOW_CLASS_HOOKS}
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStart={recordStep}
              onSelectionDragStart={recordStep}
              onConnect={(connection: Connection) => {
                connect(connection.source, connection.target);
                doneWithTool();
              }}
              onConnectEnd={onConnectEnd}
              isValidConnection={(connection) => connection.source !== connection.target}
              onPaneClick={(event) => {
                if (proposal || !canEdit) return;
                const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                if (tool === "box" || tool === "note") {
                  addNode(tool === "box" ? "agent" : "note", point);
                  doneWithTool();
                } else if (tool === "text") {
                  placeText(point);
                }
              }}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={36}
              nodesConnectable={!proposal && canEdit}
              elementsSelectable={!proposal}
              nodesFocusable={!proposal}
              selectionOnDrag={tool === "select" && !proposal}
              selectionMode={SelectionMode.Partial}
              panOnDrag={tool === "hand" || proposal !== null ? true : [1, 2]}
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              minZoom={0.2}
              maxZoom={2.5}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1.3}
                color="var(--wf-grid)"
              />
              <MiniMap
                pannable
                zoomable
                style={{ width: 168, height: 112 }}
                position="bottom-right"
                nodeBorderRadius={6}
                nodeColor={(node) =>
                  node.type === "note"
                    ? "color-mix(in srgb, #f5c542 45%, transparent)"
                    : node.type === "agent"
                      ? "color-mix(in srgb, var(--contrast-foreground) 35%, transparent)"
                      : "color-mix(in srgb, var(--contrast-foreground) 14%, transparent)"
                }
                maskColor="color-mix(in srgb, var(--background) 70%, transparent)"
              />
            </ReactFlow>
          </CanvasContext>
          <svg
            className="pointer-events-none absolute inset-0 z-[5] size-full overflow-visible"
            aria-hidden
          >
            <path ref={draftRef} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {!proposal ? (
            <EditorToolbar
              tool={tool}
              onTool={setTool}
              locked={locked}
              onLock={() => setLocked((value) => !value)}
              canUndo={historyDepth.past > 0}
              canRedo={historyDepth.future > 0}
              onUndo={undo}
              onRedo={redo}
              onTidy={tidy}
              disabled={!canEdit}
            />
          ) : null}
          {!proposal &&
          canEdit &&
          (tool === "pen" || tool === "text" || selectedMarks.length > 0) ? (
            <MarkStylePanel
              style={markStyle}
              showWeight={tool === "pen" || selectedMarks.some((mark) => mark.kind === "stroke")}
              showSize={tool === "text" || selectedMarks.some((mark) => mark.kind === "text")}
              selection={selectedMarks}
              onChange={applyMarkStyle}
            />
          ) : null}
          <ZoomControls />
          {doc.nodes.length === 0 && !doc.marks?.length && !proposal ? <EmptyCanvasHint /> : null}
          {doc.nodes.length > 0 && !proposal && selectedNodes.size + selectedEdges.size === 0 ? (
            <CanvasHint />
          ) : null}
          <div className="pointer-events-none absolute top-16 right-3 bottom-36 z-10 flex w-76 flex-col gap-2">
            {aiOpen && !proposal ? (
              <div
                className={`${styles.panel} pointer-events-auto flex shrink-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-popover p-3 shadow-lg`}
              >
                <div className="flex items-center gap-2">
                  <WandSparklesIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Make with AI</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label="Close"
                    onClick={() => setAiOpen(false)}
                  >
                    <XIcon />
                  </Button>
                </div>
                <Textarea
                  size="sm"
                  aria-label="Describe the workflow"
                  placeholder="Opus leads, two Sol workers, each with many Haiku"
                  value={prompt}
                  maxLength={8_000}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (prompt.trim()) void compile("prompt");
                    }
                  }}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    disabled={!canEdit || !prompt.trim() || compiling !== null}
                    onClick={() => void compile("prompt")}
                  >
                    {compiling === "prompt" ? <Spinner /> : <SparklesIcon />}
                    Make it
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canEdit || doc.nodes.length === 0 || compiling !== null}
                    onClick={() => void compile("drawing")}
                  >
                    {compiling === "drawing" ? <Spinner /> : <WandSparklesIcon />}
                    Resolve drawing
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="shrink-0">Using</span>
                  {pickerSelection ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={pickerSelection.instanceId}
                      model={pickerSelection.model}
                      lockedProvider={null}
                      instanceEntries={catalog.instanceEntries}
                      modelOptionsByInstance={catalog.modelOptionsByInstance}
                      compact
                      popupAlign="end"
                      onInstanceModelChange={(instanceId, model) =>
                        setCompileModel(createModelSelection(instanceId, model))
                      }
                    />
                  ) : (
                    <span>the default model</span>
                  )}
                </div>
              </div>
            ) : null}
            {!proposal ? (
              <WorkflowInspector
                environmentId={environmentId}
                doc={doc}
                canEdit={canEdit}
                catalog={catalog}
                selectedNode={selectedNode}
                selectedEdgeId={selectedEdgeId}
                selectionCount={selectedNodes.size + selectedEdges.size}
                issues={visibleIssues}
                onUpdateNode={updateNode}
                onUpdateDoc={setDoc}
                onDelete={removeSelection}
              />
            ) : null}
          </div>
          {conflict && !proposal ? (
            <div
              role="alert"
              className="absolute top-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border/70 bg-popover py-1.5 pr-1.5 pl-3 shadow-lg"
            >
              <CircleAlertIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm">This workflow changed on another device.</span>
              <Button size="sm" variant="ghost" onClick={() => resolveConflict("mine")}>
                Keep mine
              </Button>
              <Button size="sm" onClick={() => resolveConflict("theirs")}>
                Load theirs
              </Button>
            </div>
          ) : null}
          {proposal ? (
            <ProposalBar
              proposal={proposal}
              onApply={applyProposal}
              onDiscard={() => setProposal(null)}
            />
          ) : null}
        </div>
      </div>
      <WorkflowStartDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        workflowName={doc.name}
        issues={issues}
        onShowIssues={() => setShowAllIssues(true)}
        onStart={start}
      />
    </>
  );
}

/** The name field: free to clear while typing; an empty name keeps the old one. */
function WorkflowNameInput({
  name,
  readOnly,
  onCommit,
}: {
  readonly name: string;
  readonly readOnly: boolean;
  readonly onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() && draft !== name) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <input
      aria-label="Workflow name"
      className="min-w-0 max-w-80 flex-1 truncate rounded-md bg-transparent px-1.5 py-0.5 text-sm font-medium outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      value={draft ?? name}
      maxLength={120}
      readOnly={readOnly}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ToolButton({
  label,
  shortcut,
  digit,
  active,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly digit?: string | undefined;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            onClick={onClick}
            className="relative"
          />
        }
      >
        {children}
        {digit ? (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0.5 bottom-0 text-4xs leading-none font-medium text-muted-foreground/80"
          >
            {digit}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          {digit ? <Kbd>{digit}</Kbd> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function EditorToolbar({
  tool,
  onTool,
  locked,
  onLock,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onTidy,
  disabled,
}: {
  readonly tool: Tool;
  readonly onTool: (tool: Tool) => void;
  readonly locked: boolean;
  readonly onLock: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onTidy: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-border/70 bg-popover p-1 shadow-md">
      <ToolButton
        label={locked ? "Tool stays on after use" : "Keep tool on after use"}
        shortcut="Q"
        active={locked}
        disabled={disabled}
        onClick={onLock}
      >
        {locked ? <LockIcon /> : <LockOpenIcon />}
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {TOOLS.map((entry) => (
        <ToolButton
          key={entry.id}
          label={entry.label}
          shortcut={entry.key}
          digit={entry.digit}
          active={tool === entry.id}
          disabled={disabled && entry.id !== "select" && entry.id !== "hand"}
          onClick={() => onTool(entry.id)}
        >
          {entry.icon}
        </ToolButton>
      ))}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton
        label="Undo"
        shortcut={keyLabel("z", { mod: true })}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2Icon />
      </ToolButton>
      <ToolButton
        label="Redo"
        shortcut={keyLabel("z", { mod: true, shift: true })}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2Icon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onTidy}>
        Tidy up
      </Button>
    </div>
  );
}

function MarkStylePanel({
  style,
  showWeight,
  showSize,
  selection,
  onChange,
}: {
  readonly style: MarkStyle;
  readonly showWeight: boolean;
  readonly showSize: boolean;
  readonly selection: ReadonlyArray<WorkflowMark>;
  readonly onChange: (patch: Partial<MarkStyle>) => void;
}) {
  // A selection shows its own style when it agrees (none lit when mixed); else the next mark's.
  const pick = <T,>(values: ReadonlyArray<T>, fallback: T): T | null =>
    values.length === 0 ? fallback : new Set(values).size === 1 ? values[0]! : null;
  const color = pick(
    selection.map((mark) => mark.color),
    style.color,
  );
  const weight = pick(
    selection.flatMap((mark) => (mark.kind === "stroke" ? [mark.weight] : [])),
    style.weight,
  );
  const size = pick(
    selection.flatMap((mark) => (mark.kind === "text" ? [mark.size] : [])),
    style.size,
  );
  const option = "flex h-7 items-center justify-center rounded-md border text-xs transition-colors";
  const optionState = (active: boolean) =>
    active
      ? "border-primary/60 bg-accent text-foreground"
      : "border-transparent text-muted-foreground hover:bg-accent/60";
  return (
    <div
      className={`${styles.panel} absolute top-16 left-3 z-10 flex w-44 flex-col gap-2.5 rounded-xl border border-border/70 bg-popover p-2.5 shadow-md`}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs font-medium text-muted-foreground">Color</span>
        <div className="flex gap-1">
          {(Object.keys(MARK_COLORS) as Array<MarkStyle["color"]>).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-label={MARK_COLOR_LABELS[entry]}
              aria-pressed={color === entry}
              className={cn(
                "size-7 rounded-md border-2 p-1 transition-colors",
                color === entry ? "border-primary/70" : "border-transparent hover:border-border",
              )}
              onClick={() => onChange({ color: entry })}
            >
              <span
                className="block size-full rounded-sm"
                style={{ background: MARK_COLORS[entry] }}
              />
            </button>
          ))}
        </div>
      </div>
      {showWeight ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium text-muted-foreground">Stroke width</span>
          <div className="grid grid-cols-3 gap-1">
            {(["thin", "bold", "extra"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-label={entry === "thin" ? "Thin" : entry === "bold" ? "Bold" : "Extra bold"}
                aria-pressed={weight === entry}
                className={cn(option, optionState(weight === entry))}
                onClick={() => onChange({ weight: entry })}
              >
                <svg width="22" height="12" aria-hidden>
                  <path
                    d="M3 6h16"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth={MARK_WEIGHTS[entry] * 0.7}
                  />
                </svg>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {showSize ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium text-muted-foreground">Font size</span>
          <div className="grid grid-cols-4 gap-1">
            {(["s", "m", "l", "xl"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-label={
                  entry === "s"
                    ? "Small"
                    : entry === "m"
                      ? "Medium"
                      : entry === "l"
                        ? "Large"
                        : "Extra large"
                }
                aria-pressed={size === entry}
                className={cn(option, "font-medium uppercase", optionState(size === entry))}
                onClick={() => onChange({ size: entry })}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ZoomControls() {
  const flow = useReactFlow();
  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-xl border border-border/70 bg-popover p-1 shadow-md">
      <ToolButton
        label="Zoom out"
        shortcut={keyLabel("-", { mod: true })}
        onClick={() => void flow.zoomOut({ duration: 160 })}
      >
        <MinusIcon />
      </ToolButton>
      <ToolButton
        label="Zoom in"
        shortcut={keyLabel("=", { mod: true })}
        onClick={() => void flow.zoomIn({ duration: 160 })}
      >
        <PlusIcon />
      </ToolButton>
      <ToolButton
        label="Fit to screen"
        shortcut={keyLabel("1", { shift: true })}
        onClick={() => void flow.fitView({ padding: 0.2, duration: 240 })}
      >
        <Maximize2Icon />
      </ToolButton>
    </div>
  );
}

// Below this pane width the centered hint runs into the zoom controls or the minimap.
const CANVAS_HINT_MIN_WIDTH = 860;

function CanvasHint() {
  const wide = useStore((state) => state.width >= CANVAS_HINT_MIN_WIDTH);
  if (!wide) return null;
  return (
    <p className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 text-xs text-muted-foreground">
      Double-click for a box · drag a box’s dot to connect · P to draw, T to write
    </p>
  );
}

function EmptyCanvasHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <p className={`${styles.hand} text-2xl text-muted-foreground`}>Draw your team</p>
        <p className="text-sm text-muted-foreground">
          Double-click to add a box and type a model, like “opus” or “many haiku agents”. Drag from
          a box’s edge to start an agent under it.
        </p>
      </div>
    </div>
  );
}

function ProposalBar({
  proposal,
  onApply,
  onDiscard,
}: {
  readonly proposal: Proposal;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}) {
  const diff = diffWorkflows(proposal.base, proposal.workflow);
  const changes = [
    diff.added.size > 0 ? `${diff.added.size} new` : null,
    diff.changed.size > 0 ? `${diff.changed.size} changed` : null,
    diff.removed.size > 0 ? `${diff.removed.size} removed` : null,
  ].filter(Boolean);
  return (
    <div className="absolute bottom-4 left-1/2 z-10 flex w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2 rounded-xl border border-border/70 bg-popover p-3 shadow-lg">
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm">{proposal.summary || "Here’s a proposal."}</p>
          <p className="text-xs text-muted-foreground">
            {changes.length > 0 ? changes.join(" · ") : "No changes"}
            {proposal.issues.length > 0 ? ` · ${proposal.issues.length} still to fix` : ""}
          </p>
          {proposal.issues.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {proposal.issues.slice(0, 3).map((issue) => (
                <li
                  key={issueKey(issue)}
                  className="flex items-start gap-1.5 text-xs text-destructive"
                >
                  <CircleAlertIcon className="mt-px size-3 shrink-0" />
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

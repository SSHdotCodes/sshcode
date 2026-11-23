import {
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  Position,
  useConnection,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type {
  ModelSelection,
  WorkflowAgentNode,
  WorkflowAgentStatus,
  WorkflowMarkColor,
  WorkflowNoteNode,
  WorkflowRunAgent,
  WorkflowStrokeMark,
  WorkflowTextMark,
} from "@t3tools/contracts";
import {
  BanIcon,
  CheckIcon,
  CircleAlertIcon,
  GitBranchIcon,
  PauseIcon,
  UsersIcon,
} from "lucide-react";
import { createContext, memo, use, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  boxEdgePoint,
  MARK_TEXT_SIZES,
  MARK_WEIGHTS,
  markStrokePath,
  markStrokeSize,
  roughArrow,
  roughCard,
  seedFrom,
} from "@t3tools/shared/workflowSketch";
import {
  AGENT_STATUS_LABEL,
  agentTitle,
  countCapacity,
  countLabel,
  elapsedBetween,
  firstLine,
  formatElapsed,
  type RunBox,
} from "./workflowGraph";
import type { ModelDescription } from "./workflowModels";
import { useNow } from "./useNow";
import { ModelChip } from "./WorkflowStatus";
import styles from "./workflows.module.css";

export type Highlight = "added" | "changed";

export interface CanvasContextValue {
  readonly mode: "edit" | "proposal" | "run";
  readonly tool: "select" | "hand" | "box" | "arrow" | "pen" | "text" | "note" | "eraser";
  readonly describe: (selection: ModelSelection | null) => ModelDescription | null;
  readonly editingId: string | null;
  readonly onEditText: (id: string | null) => void;
  readonly onCommitText: (id: string, text: string) => void;
  readonly onResizeStart: () => void;
  readonly onResizeEnd: () => void;
  /** Run view: a fan card picks its agent for the panel. */
  readonly onPickAgent: (agent: WorkflowRunAgent) => void;
  readonly selectedThreadId?: string | null;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

function useCanvas() {
  const value = use(CanvasContext);
  if (!value) throw new Error("Canvas parts need a CanvasContext.");
  return value;
}

export type AgentFlowNode = Node<
  {
    readonly node: WorkflowAgentNode;
    readonly issue?: string | undefined;
    readonly highlight?: Highlight | undefined;
    readonly box?: RunBox | undefined;
  },
  "agent"
>;
export type NoteFlowNode = Node<
  { readonly node: WorkflowNoteNode; readonly highlight?: Highlight | undefined },
  "note"
>;
export type WorkflowFlowNode = AgentFlowNode | NoteFlowNode | TextMarkFlowNode | StrokeMarkFlowNode;

export type WorkflowFlowEdge = Edge<
  {
    readonly kind: "delegates" | "then" | "attach";
    readonly issue?: string | undefined;
    readonly highlight?: Highlight | undefined;
    /** Run view: the child box is working, so its arrow carries a flow. */
    readonly flowing?: boolean | undefined;
    readonly dim?: boolean | undefined;
  },
  "workflow"
>;

function RoughOutline({ width, height, seed }: { width: number; height: number; seed: number }) {
  const paths = roughCard(width, height, seed);
  return (
    <svg className={styles.outline} width={width} height={height} aria-hidden>
      {paths.map((path) => (
        <path key={path.d} d={path.d} strokeWidth={path.strokeWidth} />
      ))}
    </svg>
  );
}

function Badge({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-current/15 bg-current/5 px-1.5 text-2xs font-medium text-muted-foreground" />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
}

export function AgentBadges({ node }: { readonly node: WorkflowAgentNode }) {
  const count = countLabel(node.count);
  return (
    <>
      {count ? (
        <Badge title={node.count.kind === "upTo" ? "The parent picks how many" : "Agents"}>
          <UsersIcon className="size-3" />
          {count}
        </Badge>
      ) : null}
      {node.isolation === "worktree" ? (
        <Badge title="Each agent gets its own worktree">
          <GitBranchIcon className="size-3" />
          Worktree
        </Badge>
      ) : null}
    </>
  );
}

/** Classes that stop React Flow dragging, panning or zooming from inside a node. */
export const FLOW_CLASS_HOOKS = {
  noDragClassName: styles.noDrag ?? "nodrag",
  noPanClassName: styles.noPan ?? "nopan",
  noWheelClassName: styles.noWheel ?? "nowheel",
} as const;

/** Accent tokens a box can carry; the canvas maps them onto theme colors. */
export const BOX_COLORS: ReadonlyArray<{ readonly id: string; readonly css: string }> = [
  { id: "blue", css: "oklch(0.62 0.15 250)" },
  { id: "violet", css: "oklch(0.6 0.17 295)" },
  { id: "green", css: "oklch(0.64 0.14 150)" },
  { id: "amber", css: "oklch(0.72 0.14 75)" },
  { id: "rose", css: "oklch(0.63 0.18 15)" },
];

function accentStyle(color: string | undefined) {
  const css = BOX_COLORS.find((entry) => entry.id === color)?.css;
  return css ? ({ "--wf-accent": css } as React.CSSProperties) : undefined;
}

function InlineTextEditor({
  id,
  text,
  placeholder,
}: {
  readonly id: string;
  readonly text: string;
  readonly placeholder: string;
}) {
  const canvas = useCanvas();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(text);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.select();
  }, []);
  const commit = () => {
    canvas.onCommitText(id, value);
    canvas.onEditText(null);
  };
  return (
    <textarea
      ref={ref}
      aria-label="Box text"
      className={`${styles.editor} ${styles.hand} ${styles.noDrag} ${styles.noWheel} ${styles.noPan}`}
      value={value}
      placeholder={placeholder}
      maxLength={2_000}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Dots to drag arrows from, and a whole-box target so a drop anywhere on it connects. */
function ConnectionHandles({ id }: { readonly id: string }) {
  const canvas = useCanvas();
  const connecting = useConnection((connection) => connection.inProgress);
  const editing = canvas.mode === "edit";
  return (
    <>
      {/* Stable anchors every arrow attaches to; the arrow itself finds the box edge. */}
      <Handle
        id="a"
        type="source"
        position={Position.Bottom}
        className={styles.handleCover}
        style={{ pointerEvents: "none" }}
        isConnectable={false}
      />
      <Handle
        id="drop"
        type="target"
        position={Position.Top}
        className={styles.handleCover}
        style={{ pointerEvents: editing && connecting ? "all" : "none" }}
        isConnectable={editing}
        isConnectableStart={false}
      />
      {editing && canvas.tool === "arrow" && !connecting ? (
        <Handle
          id="cover"
          type="source"
          position={Position.Bottom}
          className={styles.handleCover}
        />
      ) : null}
      {editing && canvas.tool === "select" && !connecting
        ? ([Position.Top, Position.Right, Position.Bottom, Position.Left] as const).map(
            (position) => (
              <Handle
                key={position}
                id={`${id}-${position}`}
                type="source"
                position={position}
                className={styles.handle}
              />
            ),
          )
        : null}
    </>
  );
}

function StatusLine({ status }: { readonly status: WorkflowAgentStatus }) {
  return (
    <span className={styles.status}>
      {status === "completed" ? (
        <CheckIcon className={`${styles.check} size-3.5`} strokeWidth={3} />
      ) : status === "failed" ? (
        <CircleAlertIcon className="size-3.5" />
      ) : status === "waiting" ? (
        <PauseIcon className="size-3.5" />
      ) : status === "cancelled" || status === "interrupted" ? (
        <BanIcon className="size-3.5" />
      ) : (
        <span className={styles.statusDot} />
      )}
      {AGENT_STATUS_LABEL[status]}
    </span>
  );
}

function Elapsed({ agents }: { readonly agents: ReadonlyArray<WorkflowRunAgent> }) {
  const live = agents.some((agent) => agent.startedAt !== null && agent.completedAt === null);
  const now = useNow(live);
  const starts = agents.flatMap((agent) => (agent.startedAt ? [Date.parse(agent.startedAt)] : []));
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  const ends = agents.map((agent) => (agent.completedAt ? Date.parse(agent.completedAt) : now));
  const elapsed = live ? now - first : Math.max(...ends) - first;
  return (
    <span className="text-xs tabular-nums text-muted-foreground">{formatElapsed(elapsed)}</span>
  );
}

function fanSummary(agents: ReadonlyArray<WorkflowRunAgent>): string {
  const done = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  return [
    agents.length === 1 ? "1 agent" : `${agents.length} agents`,
    done > 0 ? `${done} done` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Fanned cards, one per agent in a box that holds several. Ghosts mark open slots. */
function AgentFan({ box }: { readonly box: RunBox }) {
  const canvas = useCanvas();
  const now = useNow(box.agents.some((agent) => agent.completedAt === null));
  const capacity = countCapacity(box.node.count);
  const shown = Math.max(box.agents.length, box.node.count.kind === "exact" ? capacity : 3);
  const visible = Math.min(shown, 8);
  const spread = Math.min(30, (box.node.width - 70) / Math.max(1, visible - 1));
  const centered = (index: number) => index - (visible - 1) / 2;
  const offset = (index: number) => centered(index) * spread;
  return (
    <div className={styles.fan}>
      {Array.from({ length: visible }, (_, index) => {
        const agent = box.agents[index];
        // A hand of cards: spread out, tilted, and dipping at the edges.
        const style = {
          "--wf-fan-x": `${offset(index)}px`,
          "--wf-fan-y": `${centered(index) ** 2 * 1.4}px`,
          "--wf-fan-r": `${centered(index) * 5}deg`,
          zIndex: index,
        } as React.CSSProperties;
        if (!agent) {
          return (
            <span
              key={`ghost-${index}`}
              className={styles.fanCard}
              data-ghost="true"
              style={style}
            />
          );
        }
        const elapsed = elapsedBetween(agent.startedAt, agent.completedAt, now);
        return (
          <Tooltip key={agent.threadId}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={`${styles.fanCard} ${styles.noDrag}`}
                  data-status={agent.status}
                  data-selected={agent.threadId === canvas.selectedThreadId ? "true" : undefined}
                  style={style}
                  aria-label={`${agent.title}: ${AGENT_STATUS_LABEL[agent.status]}`}
                  aria-pressed={agent.threadId === canvas.selectedThreadId}
                  onClick={(event) => {
                    event.stopPropagation();
                    canvas.onPickAgent(agent);
                  }}
                />
              }
            >
              {agent.status === "completed" ? (
                <CheckIcon className={`${styles.check} size-3.5`} strokeWidth={3} />
              ) : agent.status === "failed" ? (
                <CircleAlertIcon className="size-3.5" />
              ) : (
                agent.slot + 1
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-64">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{agent.title}</span>
                <span className="text-muted-foreground">
                  {AGENT_STATUS_LABEL[agent.status]}
                  {elapsed !== null ? ` · ${formatElapsed(elapsed)}` : ""}
                </span>
                {agent.progress ? <span>{agent.progress}</span> : null}
              </div>
            </TooltipPopup>
          </Tooltip>
        );
      })}
      {shown > visible ? (
        <span
          className="absolute bottom-2 text-2xs font-medium text-muted-foreground"
          style={{ left: `calc(50% + ${offset(visible - 1) + 24}px)` }}
        >
          +{shown - visible}
        </span>
      ) : null}
    </div>
  );
}

export const AgentNodeView = memo(function AgentNodeView({
  data,
  selected,
  width,
  height,
}: NodeProps<AgentFlowNode>) {
  const canvas = useCanvas();
  const { node, issue, highlight, box } = data;
  const w = width ?? node.width;
  const h = height ?? node.height;
  const description = canvas.describe(node.model);
  const editing = canvas.editingId === node.id;
  const status = box?.status;
  const many = box !== undefined && countCapacity(node.count) > 1;
  const reason =
    status === "failed" ? box?.agents.find((a) => a.status === "failed")?.progress : undefined;
  const latest = box?.agents
    .filter((agent) => agent.progress)
    .toSorted((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0]?.progress;
  const resolved = description !== null;
  const title = agentTitle(node);

  const card = (
    <div
      className={styles.node}
      data-selected={selected ? "true" : "false"}
      data-issue={issue ? "true" : "false"}
      data-highlight={highlight}
      data-status={status}
      data-clickable={box ? "true" : undefined}
      style={accentStyle(node.color)}
      onDoubleClick={(event) => {
        if (canvas.mode !== "edit") return;
        event.stopPropagation();
        canvas.onEditText(node.id);
      }}
    >
      {canvas.mode === "edit" ? (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={180}
          minHeight={96}
          onResizeStart={canvas.onResizeStart}
          onResizeEnd={canvas.onResizeEnd}
        />
      ) : null}
      {many && box.agents.length > 1 ? (
        <>
          <div
            className={styles.stack}
            style={{ transform: "translate(8px, 8px)", opacity: 0.5 }}
          />
          <div
            className={styles.stack}
            style={{ transform: "translate(4px, 4px)", opacity: 0.8 }}
          />
        </>
      ) : null}
      <div className={styles.halo} />
      <div className={styles.fill} />
      <RoughOutline width={w} height={h} seed={seedFrom(node.id)} />
      {highlight ? (
        <span className={styles.tag}>{highlight === "added" ? "New" : "Changed"}</span>
      ) : null}
      <ConnectionHandles id={node.id} />
      {editing ? (
        <InlineTextEditor
          id={node.id}
          text={node.text}
          placeholder="gpt 6.1 sol, many haiku agents…"
        />
      ) : (
        <div className={styles.body}>
          <div className="flex min-h-5 items-center gap-1.5">
            {description ? (
              <ModelChip description={description} className="min-w-0 flex-1" />
            ) : (
              <span className="flex-1 truncate text-2xs font-medium text-muted-foreground">
                {node.text.trim() ? "No model yet" : ""}
              </span>
            )}
            <AgentBadges node={node} />
          </div>
          {resolved || node.label.trim() ? (
            <div className={`${styles.title} ${styles.hand}`}>{title}</div>
          ) : (
            <div className={`${styles.typed} ${styles.hand}`}>
              <span className={cn(!node.text.trim() && "text-muted-foreground/60")}>
                {node.text.trim() || "Double-click to write"}
              </span>
            </div>
          )}
          {box ? (
            <>
              <div className="flex items-center gap-2">
                <StatusLine status={box.status} />
                <Elapsed agents={box.agents} />
              </div>
              {many ? (
                <>
                  {box.agents.length > 0 ? (
                    <div className={styles.brief}>{fanSummary(box.agents)}</div>
                  ) : null}
                  <AgentFan box={box} />
                </>
              ) : latest ? (
                <div className={styles.brief}>{latest}</div>
              ) : null}
            </>
          ) : node.instructions.trim() ? (
            <div className={styles.brief}>{firstLine(node.instructions)}</div>
          ) : null}
          {issue && canvas.mode !== "run" ? (
            <div className="mt-auto flex items-start gap-1 text-xs leading-tight text-destructive">
              <CircleAlertIcon className="mt-px size-3 shrink-0" />
              <span className="line-clamp-2">{issue}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
  if (!reason) return card;
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="size-full" />}>{card}</TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-72">
        {reason}
      </TooltipPopup>
    </Tooltip>
  );
});

export const NoteNodeView = memo(function NoteNodeView({
  data,
  selected,
  width,
  height,
}: NodeProps<NoteFlowNode>) {
  const canvas = useCanvas();
  const { node, highlight } = data;
  const editing = canvas.editingId === node.id;
  return (
    <div
      className={`${styles.node} ${styles.note}`}
      data-selected={selected ? "true" : "false"}
      data-highlight={highlight}
      onDoubleClick={(event) => {
        if (canvas.mode !== "edit") return;
        event.stopPropagation();
        canvas.onEditText(node.id);
      }}
    >
      {canvas.mode === "edit" ? (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={120}
          minHeight={56}
          onResizeStart={canvas.onResizeStart}
          onResizeEnd={canvas.onResizeEnd}
        />
      ) : null}
      <div className={styles.fill} />
      <RoughOutline
        width={width ?? node.width}
        height={height ?? node.height}
        seed={seedFrom(node.id)}
      />
      {highlight ? (
        <span className={styles.tag}>{highlight === "added" ? "New" : "Changed"}</span>
      ) : null}
      <ConnectionHandles id={node.id} />
      {editing ? (
        <InlineTextEditor id={node.id} text={node.text} placeholder="A note for the run…" />
      ) : (
        <div className={`${styles.body} ${styles.hand} whitespace-pre-wrap`}>
          {node.text || <span className="text-muted-foreground">Double-click to write</span>}
        </div>
      )}
    </div>
  );
});

/** A hand-drawn arrow that leaves and enters boxes at their edges. */
export const WorkflowEdgeView = memo(function WorkflowEdgeView({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<WorkflowFlowEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const box = (node: typeof from) => ({
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  });
  const a = box(from);
  const b = box(to);
  const center = (rect: typeof a) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const start = boxEdgePoint(a, center(b));
  const end = boxEdgePoint(b, center(a), data.kind === "attach" ? 4 : 8);
  const { line, head, smooth } = roughArrow(start, end, seedFrom(id), {
    head: data.kind !== "attach",
  });
  const labelAt = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const label = data.issue ?? (data.kind === "then" ? "then" : null);
  return (
    <>
      <g
        className={styles.edge}
        data-kind={data.kind}
        data-selected={selected ? "true" : "false"}
        data-issue={data.issue ? "true" : "false"}
        data-highlight={data.highlight}
        data-dim={data.dim ? "true" : "false"}
      >
        <path className={styles.edgeHit} d={smooth} />
        <path className={styles.edgeLine} d={line} />
        {head ? <path d={head} /> : null}
        {data.flowing ? <path className={styles.edgeFlow} d={smooth} /> : null}
      </g>
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={`${styles.edgeLabel} ${styles.hand} ${styles.noDrag} ${styles.noPan}`}
            data-issue={data.issue ? "true" : "false"}
            style={{ transform: `translate(-50%, -50%) translate(${labelAt.x}px, ${labelAt.y}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export type TextMarkFlowNode = Node<{ readonly mark: WorkflowTextMark }, "textMark">;
export type StrokeMarkFlowNode = Node<{ readonly mark: WorkflowStrokeMark }, "strokeMark">;

/** Marker and text colors, Excalidraw's first row; ink follows the theme. */
export const MARK_COLORS: Readonly<Record<WorkflowMarkColor, string>> = {
  ink: "var(--contrast-foreground)",
  red: "oklch(0.62 0.21 25)",
  green: "oklch(0.62 0.15 150)",
  blue: "oklch(0.58 0.17 255)",
  orange: "oklch(0.72 0.16 60)",
};

export const StrokeMarkView = memo(function StrokeMarkView({
  data,
  selected,
}: NodeProps<StrokeMarkFlowNode>) {
  const { mark } = data;
  const size = markStrokeSize(mark);
  const d = markStrokePath(mark.points);
  return (
    <svg
      className={styles.strokeMark}
      data-selected={selected ? "true" : "false"}
      width={size.width}
      height={size.height}
      aria-hidden
    >
      {/* The wide clear path is the hit area; only the line itself is grabbable. */}
      <path d={d} className={styles.markHit} strokeWidth={MARK_WEIGHTS[mark.weight] + 12} />
      <path
        d={d}
        fill="none"
        stroke={MARK_COLORS[mark.color]}
        strokeWidth={MARK_WEIGHTS[mark.weight]}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

export const TextMarkView = memo(function TextMarkView({
  data,
  selected,
}: NodeProps<TextMarkFlowNode>) {
  const canvas = useCanvas();
  const { mark } = data;
  const editing = canvas.editingId === mark.id;
  const style = { color: MARK_COLORS[mark.color], fontSize: MARK_TEXT_SIZES[mark.size] };
  return (
    <div
      className={`${styles.textMark} ${styles.hand}`}
      data-selected={selected ? "true" : "false"}
      style={style}
      onClick={(event) => {
        if (canvas.mode !== "edit" || canvas.tool !== "text") return;
        event.stopPropagation();
        canvas.onEditText(mark.id);
      }}
      onDoubleClick={(event) => {
        if (canvas.mode !== "edit") return;
        event.stopPropagation();
        canvas.onEditText(mark.id);
      }}
    >
      {editing ? <TextMarkEditor id={mark.id} text={mark.text} /> : mark.text || "\u00a0"}
    </div>
  );
});

function TextMarkEditor({ id, text }: { readonly id: string; readonly text: string }) {
  const canvas = useCanvas();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(text);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    canvas.onCommitText(id, value);
    canvas.onEditText(null);
  };
  return (
    <textarea
      ref={ref}
      aria-label="Text"
      className={`${styles.textMarkEditor} ${styles.hand} ${styles.noDrag} ${styles.noWheel} ${styles.noPan}`}
      value={value}
      placeholder="Text"
      maxLength={2_000}
      rows={1}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

export const NODE_TYPES = {
  agent: AgentNodeView,
  note: NoteNodeView,
  textMark: TextMarkView,
  strokeMark: StrokeMarkView,
};
export const EDGE_TYPES = { workflow: WorkflowEdgeView };

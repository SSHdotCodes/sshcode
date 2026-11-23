import type {
  ModelSelection,
  WorkflowAgentStatus,
  WorkflowDefinition,
  WorkflowMarkColor,
  WorkflowNode,
  WorkflowRunStatus,
} from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import {
  boxEdgePoint,
  roughArrow,
  roughCard,
  seedFrom,
  MARK_TEXT_SIZES,
  MARK_WEIGHTS,
  markStrokePath,
  sketchPreview,
  SKETCH_MIN_TITLE_PX,
  SKETCH_SMALL_SCALE,
  wrapPreviewText,
} from "@t3tools/shared/workflowSketch";
import { agentTitle, countCapacity, firstLine, RUN_STATUS_LABEL } from "./workflowGraph";
import type { ModelDescription } from "./workflowModels";
import styles from "./workflows.module.css";

export { wrapPreviewText };

const RUN_BADGE: Record<WorkflowRunStatus, "info" | "warning" | "success" | "error" | "secondary"> =
  {
    starting: "info",
    running: "info",
    waiting: "warning",
    completed: "success",
    failed: "error",
    cancelled: "secondary",
  };

export function RunStatusBadge({ status }: { readonly status: WorkflowRunStatus }) {
  return (
    <Badge variant={RUN_BADGE[status]} size="sm">
      {RUN_STATUS_LABEL[status]}
    </Badge>
  );
}

export const STATUS_DOT: Record<WorkflowAgentStatus, string> = {
  planned: "bg-muted-foreground/40",
  pending: "bg-info/60",
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  interrupted: "bg-muted-foreground",
};

const STATUS_FILL: Record<WorkflowAgentStatus, string> = {
  planned: "var(--contrast-muted-foreground)",
  pending: "var(--info)",
  running: "var(--info)",
  waiting: "var(--warning)",
  completed: "var(--success)",
  failed: "var(--destructive)",
  cancelled: "var(--contrast-muted-foreground)",
  interrupted: "var(--contrast-muted-foreground)",
};

/** Marker and text colors, Excalidraw's first row; ink follows the theme. */
export const MARK_COLORS: Readonly<Record<WorkflowMarkColor, string>> = {
  ink: "var(--contrast-foreground)",
  red: "oklch(0.62 0.21 25)",
  green: "oklch(0.62 0.15 150)",
  blue: "oklch(0.58 0.17 255)",
  orange: "oklch(0.72 0.16 60)",
};

/** Rough average glyph widths, in font units, for wrapping without measuring text. */
const HAND_GLYPH = 0.48;
const SANS_GLYPH = 0.56;
const TITLE_SIZE = 34;
const MODEL_SIZE = 21;

/** Brand tint for the model dot; the rest stay neutral. */
const MODEL_DOT: Partial<Record<string, string>> = {
  claudeAgent: "#d97757",
  codex: "#10a37f",
  grok: "var(--contrast-foreground)",
  antigravity: "#4285f4",
};

function countTag(node: WorkflowNode): string | null {
  if (node.kind !== "agent" || countCapacity(node.count) <= 1) return null;
  return node.count.kind === "upTo" ? `up to ${node.count.max}` : `×${node.count.n}`;
}

/**
 * A small static drawing of a workflow for cards and the empty page: rough
 * outlines, wrapped titles, the model under each box and stacked cards for
 * "many" boxes, tinted by status while a run is live. Plain SVG with cached
 * paths, so a page of cards stays cheap.
 */
export const WorkflowMiniPreview = memo(function WorkflowMiniPreview({
  workflow,
  statuses,
  describe,
  showNotes = true,
  area,
  className,
}: {
  readonly workflow: WorkflowDefinition;
  readonly statuses?: ReadonlyMap<string, WorkflowAgentStatus> | undefined;
  readonly describe?: ((selection: ModelSelection | null) => ModelDescription | null) | undefined;
  readonly showNotes?: boolean;
  /** The pixel area a card gives the drawing: small fits get a compact, crisp thumbnail. */
  readonly area?: { readonly width: number; readonly height: number };
  readonly className?: string;
}) {
  const agents = workflow.nodes.filter((node) => node.kind === "agent");
  // Notes are dropped only when boxes remain to show.
  const shown = showNotes || agents.length === 0 ? workflow.nodes : agents;
  const { nodes, marks, scale, viewBox } = sketchPreview(
    shown,
    workflow.edges,
    workflow.marks ?? [],
    area,
  );
  // Tiny sketchy outlines blur into fuzz and labels vanish: draw clean outlines,
  // keep titles readable and drop the model line instead.
  const small = scale < SKETCH_SMALL_SCALE;
  if (nodes.length === 0 && marks.length === 0) {
    return (
      <div className={cn("flex items-center justify-center", className)}>
        <span className={`${styles.hand} text-lg text-muted-foreground/70`}>Empty canvas</span>
      </div>
    );
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const center = (node: WorkflowNode) => ({
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  });
  return (
    <svg
      className={className}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {workflow.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const start = boxEdgePoint(from, center(to), 10);
        const end = boxEdgePoint(to, center(from), 14);
        const arrow = roughArrow(start, end, seedFrom(edge.id));
        return (
          <g
            key={edge.id}
            fill="none"
            stroke="var(--contrast-muted-foreground)"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={edge.kind === "then" ? "6 5" : undefined}
          >
            <path d={arrow.line} vectorEffect="non-scaling-stroke" />
            {arrow.head ? <path d={arrow.head} vectorEffect="non-scaling-stroke" /> : null}
          </g>
        );
      })}
      {nodes.map((node) => {
        const status = statuses?.get(node.id);
        const tag = countTag(node);
        const isNote = node.kind === "note";
        const tone = isNote
          ? "color-mix(in srgb, #c58a00 70%, var(--contrast-foreground))"
          : status
            ? STATUS_FILL[status]
            : "var(--contrast-foreground)";
        const fill = isNote
          ? "color-mix(in srgb, #f5c542 22%, var(--card))"
          : status && status !== "planned"
            ? `color-mix(in srgb, ${STATUS_FILL[status]} 16%, var(--card))`
            : "var(--card)";
        const outline = small
          ? []
          : roughCard(node.width, node.height, seedFrom(node.id), { radius: 18 });
        const model = node.kind === "agent" && describe && !small ? describe(node.model) : null;
        const title = node.kind === "agent" ? agentTitle(node) : firstLine(node.text);
        const fits = (size: number) =>
          Math.max(4, Math.floor((node.width - 28) / (size * HAND_GLYPH)));
        // A title that would be cut on one line shrinks a step before it wraps or clips.
        const titleSize = Math.max(
          SKETCH_MIN_TITLE_PX / scale,
          isNote ? 26 : model && title.length > fits(TITLE_SIZE) ? TITLE_SIZE - 6 : TITLE_SIZE,
        );
        const titleLines = wrapPreviewText(title, fits(titleSize), model ? 1 : isNote ? 3 : 2);
        const lineHeight = titleSize * 1.15;
        const blockHeight = titleLines.length * lineHeight + (model ? MODEL_SIZE * 1.6 : 0);
        const top = (node.height - blockHeight) / 2 + lineHeight / 2;
        const modelName = model
          ? wrapPreviewText(
              // The dot already shows the maker, so "Claude Haiku 5.5" reads as "Haiku 5.5".
              model.name.replace(/^Claude\s+/u, ""),
              Math.floor((node.width - 52) / (MODEL_SIZE * SANS_GLYPH)),
              1,
            )[0]
          : null;
        const modelWidth = modelName ? modelName.length * MODEL_SIZE * SANS_GLYPH : 0;
        const modelY = top + titleLines.length * lineHeight - lineHeight / 2 + MODEL_SIZE * 1.15;
        const tagWidth = tag ? tag.length * 20 * SANS_GLYPH + 22 : 0;
        return (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
            {tag
              ? [20, 10].map((offset) => (
                  <rect
                    key={offset}
                    x={offset}
                    y={offset}
                    width={node.width}
                    height={node.height}
                    rx={18}
                    fill="var(--card)"
                    stroke={tone}
                    strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                    opacity={offset === 20 ? 0.35 : 0.6}
                  />
                ))
              : null}
            <rect x={2} y={2} width={node.width - 4} height={node.height - 4} rx={17} fill={fill} />
            <g
              fill="none"
              stroke={tone}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray={status === "planned" ? "5 5" : undefined}
            >
              {small ? (
                <rect
                  x={2}
                  y={2}
                  width={node.width - 4}
                  height={node.height - 4}
                  rx={17}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                outline.map((path) => (
                  <path key={path.d} d={path.d} vectorEffect="non-scaling-stroke" />
                ))
              )}
            </g>
            {titleLines.map((line, index) => (
              <text
                key={index}
                x={node.width / 2}
                y={top + index * lineHeight}
                textAnchor="middle"
                dominantBaseline="central"
                className={styles.hand}
                fontSize={titleSize}
                fill="var(--contrast-foreground)"
                opacity={isNote ? 0.75 : 0.92}
              >
                {line}
              </text>
            ))}
            {modelName ? (
              <g transform={`translate(${(node.width - modelWidth - 18) / 2} ${modelY})`}>
                <circle
                  cx={6}
                  cy={0}
                  r={6}
                  fill={MODEL_DOT[model!.driverKind] ?? "var(--contrast-muted-foreground)"}
                />
                <text
                  x={18}
                  y={0}
                  dominantBaseline="central"
                  fontSize={MODEL_SIZE}
                  fontFamily="var(--font-sans, system-ui)"
                  fill="var(--contrast-muted-foreground)"
                >
                  {modelName}
                </text>
              </g>
            ) : null}
            {tag ? (
              <g transform={`translate(${node.width - tagWidth - 14} -15)`}>
                <rect
                  width={tagWidth}
                  height={30}
                  rx={15}
                  fill="var(--card)"
                  stroke={tone}
                  strokeWidth={1.2}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={tagWidth / 2}
                  y={15}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={20}
                  fontFamily="var(--font-sans, system-ui)"
                  fill="var(--contrast-foreground)"
                >
                  {tag}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
      {marks.map((mark) => {
        const color = MARK_COLORS[mark.color];
        if (mark.kind === "stroke") {
          return (
            <path
              key={mark.id}
              d={markStrokePath(mark.points)}
              transform={`translate(${mark.x} ${mark.y})`}
              fill="none"
              stroke={color}
              // At least a pixel on screen, so a thin line doesn't fade out.
              strokeWidth={Math.max(MARK_WEIGHTS[mark.weight], 1 / scale)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
        const size = MARK_TEXT_SIZES[mark.size];
        return mark.text.split("\n").map((line, index) => (
          <text
            key={`${mark.id}:${index}`}
            x={mark.x + 4}
            y={mark.y + 2 + size * (0.95 + 1.2 * index)}
            className={styles.hand}
            fontSize={size}
            fill={color}
          >
            {line}
          </text>
        ));
      })}
    </svg>
  );
});

export function ModelChip({
  description,
  className,
}: {
  readonly description: ModelDescription;
  readonly className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ProviderInstanceIcon
        driverKind={description.driverKind}
        displayName={description.instanceName}
        className="size-4"
        iconClassName="size-4"
        showBadge={false}
      />
      <span className="truncate text-xs font-medium">{description.name}</span>
    </span>
  );
}

import type {
  ModelSelection,
  WorkflowAgentStatus,
  WorkflowDefinition,
  WorkflowNode,
} from "@t3tools/contracts";
import {
  boxEdgePoint,
  roughArrow,
  roughCard,
  seedFrom,
  SKETCH_HAND_GLYPH,
  SKETCH_MODEL_DOT,
  SKETCH_MODEL_SIZE,
  SKETCH_SANS_GLYPH,
  SKETCH_MIN_TITLE_PX,
  SKETCH_SMALL_SCALE,
  SKETCH_TITLE_SIZE,
  sketchCountTag,
  sketchPreview,
  sketchTitle,
  wrapPreviewText,
} from "@t3tools/shared/workflowSketch";
import { useFonts } from "expo-font";
import { memo } from "react";
import { useWindowDimensions, View } from "react-native";
import Svg, { Circle, G, Path, Rect, Text as SvgText } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { STATUS_COLORS } from "./WorkflowCanvas";
import { WorkflowMarks } from "./WorkflowMarks";

export interface SketchModel {
  readonly name: string;
  readonly driverKind: string;
}

const HAND = "Excalifont";
const NOTE_TONE = "#b07a00";
const NOTE_FILL = "#f5c542";

/** The Mac's hand font, loaded once per app run; text falls back to the app font until then. */
export function useSketchFont(): string | undefined {
  const [loaded] = useFonts({ [HAND]: require("../../../assets/fonts/Excalifont-Latin.ttf") });
  return loaded ? HAND : undefined;
}

/**
 * The same drawing as the Mac's workflow cards and empty page: rough outlines,
 * hand-written titles, the model under each box and stacked cards for boxes
 * that run several agents, tinted by status while a run is live.
 */
export const WorkflowSketch = memo(function WorkflowSketch({
  workflow,
  statuses,
  describe,
  showNotes = true,
  height,
  compact = false,
}: {
  readonly workflow: WorkflowDefinition;
  readonly statuses?: ReadonlyMap<string, WorkflowAgentStatus> | undefined;
  readonly describe?: ((selection: ModelSelection | null) => SketchModel | null) | undefined;
  readonly showNotes?: boolean;
  readonly height: number;
  /** Cards: a drawing that would shrink to fuzz is redrawn compact and crisp. */
  readonly compact?: boolean;
}) {
  const theme = useUniwindTheme();
  const hand = useSketchFont();
  const foreground = theme["--color-foreground"];
  const muted = theme["--color-foreground-muted"];
  const card = theme["--color-card"];
  const { width: windowWidth } = useWindowDimensions();
  const agents = workflow.nodes.filter((node) => node.kind === "agent");
  const shown = showNotes || agents.length === 0 ? workflow.nodes : agents;
  // Cards span the screen less their margins.
  const area = { width: windowWidth - 64, height };
  const { nodes, marks, scale, viewBox } = sketchPreview(
    shown,
    workflow.edges,
    workflow.marks ?? [],
    compact ? area : undefined,
  );
  const small = scale < SKETCH_SMALL_SCALE;
  if (nodes.length === 0 && marks.length === 0)
    return (
      <View style={{ height }} className="items-center justify-center">
        <Text className="text-lg text-foreground-muted" style={hand ? { fontFamily: hand } : null}>
          Empty canvas
        </Text>
      </View>
    );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const center = (node: WorkflowNode) => ({
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  });
  return (
    <Svg
      width="100%"
      height={height}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid meet"
      accessibilityLabel={`${workflow.name} drawing`}
    >
      {workflow.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const arrow = roughArrow(
          boxEdgePoint(from, center(to), 10),
          boxEdgePoint(to, center(from), 14),
          seedFrom(edge.id),
        );
        return (
          <G
            key={edge.id}
            fill="none"
            stroke={muted}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={edge.kind === "then" ? "6 5" : undefined}
          >
            <Path d={arrow.line} vectorEffect="non-scaling-stroke" />
            {arrow.head ? <Path d={arrow.head} vectorEffect="non-scaling-stroke" /> : null}
          </G>
        );
      })}
      {nodes.map((node) => {
        const status = statuses?.get(node.id);
        const tag = sketchCountTag(node);
        const isNote = node.kind === "note";
        const tone = isNote ? NOTE_TONE : status ? STATUS_COLORS[status] : foreground;
        const model = node.kind === "agent" && describe && !small ? describe(node.model) : null;
        const title = sketchTitle(node);
        const fits = (size: number) =>
          Math.max(4, Math.floor((node.width - 28) / (size * SKETCH_HAND_GLYPH)));
        // A title that would be cut on one line shrinks a step before it wraps or clips.
        const titleSize = Math.max(
          SKETCH_MIN_TITLE_PX / scale,
          isNote
            ? 26
            : model && title.length > fits(SKETCH_TITLE_SIZE)
              ? SKETCH_TITLE_SIZE - 6
              : SKETCH_TITLE_SIZE,
        );
        const titleLines = wrapPreviewText(title, fits(titleSize), model ? 1 : isNote ? 3 : 2);
        const lineHeight = titleSize * 1.15;
        const blockHeight = titleLines.length * lineHeight + (model ? SKETCH_MODEL_SIZE * 1.6 : 0);
        const top = (node.height - blockHeight) / 2 + lineHeight / 2;
        const modelName = model
          ? wrapPreviewText(
              // The dot already shows the maker, so "Claude Haiku 5.5" reads as "Haiku 5.5".
              model.name.replace(/^Claude\s+/u, ""),
              Math.floor((node.width - 52) / (SKETCH_MODEL_SIZE * SKETCH_SANS_GLYPH)),
              1,
            )[0]
          : null;
        const modelWidth = modelName ? modelName.length * SKETCH_MODEL_SIZE * SKETCH_SANS_GLYPH : 0;
        const modelY =
          top + titleLines.length * lineHeight - lineHeight / 2 + SKETCH_MODEL_SIZE * 1.15;
        const tagWidth = tag ? tag.length * 20 * SKETCH_SANS_GLYPH + 22 : 0;
        return (
          <G key={node.id} transform={`translate(${node.x} ${node.y})`}>
            {tag
              ? [20, 10].map((offset) => (
                  <Rect
                    key={offset}
                    x={offset}
                    y={offset}
                    width={node.width}
                    height={node.height}
                    rx={18}
                    fill={card}
                    stroke={tone}
                    strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                    opacity={offset === 20 ? 0.35 : 0.6}
                  />
                ))
              : null}
            <Rect x={2} y={2} width={node.width - 4} height={node.height - 4} rx={17} fill={card} />
            {isNote || (status && status !== "planned") ? (
              <Rect
                x={2}
                y={2}
                width={node.width - 4}
                height={node.height - 4}
                rx={17}
                fill={isNote ? NOTE_FILL : STATUS_COLORS[status!]}
                opacity={isNote ? 0.22 : 0.16}
              />
            ) : null}
            <G
              fill="none"
              stroke={tone}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray={status === "planned" ? "5 5" : undefined}
            >
              {small ? (
                <Rect
                  x={2}
                  y={2}
                  width={node.width - 4}
                  height={node.height - 4}
                  rx={17}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                roughCard(node.width, node.height, seedFrom(node.id), { radius: 18 }).map(
                  (path) => <Path key={path.d} d={path.d} vectorEffect="non-scaling-stroke" />,
                )
              )}
            </G>
            {titleLines.map((line, index) => (
              <SvgText
                key={index}
                x={node.width / 2}
                y={top + index * lineHeight}
                textAnchor="middle"
                alignmentBaseline="central"
                fontFamily={hand}
                fontSize={titleSize}
                fill={foreground}
                opacity={isNote ? 0.75 : 0.92}
              >
                {line}
              </SvgText>
            ))}
            {modelName ? (
              <G transform={`translate(${(node.width - modelWidth - 18) / 2} ${modelY})`}>
                <Circle cx={6} cy={0} r={6} fill={SKETCH_MODEL_DOT[model!.driverKind] ?? muted} />
                <SvgText
                  x={18}
                  y={0}
                  alignmentBaseline="central"
                  fontSize={SKETCH_MODEL_SIZE}
                  fill={muted}
                >
                  {modelName}
                </SvgText>
              </G>
            ) : null}
            {tag ? (
              <G transform={`translate(${node.width - tagWidth - 14} -15)`}>
                <Rect
                  width={tagWidth}
                  height={30}
                  rx={15}
                  fill={card}
                  stroke={tone}
                  strokeWidth={1.2}
                  vectorEffect="non-scaling-stroke"
                />
                <SvgText
                  x={tagWidth / 2}
                  y={15}
                  textAnchor="middle"
                  alignmentBaseline="central"
                  fontSize={20}
                  fill={foreground}
                >
                  {tag}
                </SvgText>
              </G>
            ) : null}
          </G>
        );
      })}
      <WorkflowMarks marks={marks} />
    </Svg>
  );
});

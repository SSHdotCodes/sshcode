import type {
  EnvironmentId,
  WorkflowAgentStatus,
  WorkflowDefinition,
  WorkflowIssue,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowRun,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { markBox } from "@t3tools/shared/workflowSketch";
import { getExplicitModelEffortLabel } from "@t3tools/shared/model";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useEnvironmentServerConfig } from "../../state/entities";
import { AppText as Text } from "../../components/AppText";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  countLabel,
  fitWorkflow,
  resizeWorkflow,
  runTree,
  workflowTreeEdges,
  workflowElapsed,
  zoomAt,
  pinchWorkflow,
} from "./viewModel";
import { WorkflowMarks } from "./WorkflowMarks";

const EMPTY_ISSUES: readonly WorkflowIssue[] = [];
const EMPTY_CHANGED: readonly WorkflowNodeId[] = [];

const makePanGesture = Gesture.Pan;
const makePinchGesture = Gesture.Pinch;
const simultaneousGestures = Gesture.Simultaneous;

const ACCENTS: Record<string, string> = {
  violet: "#8378ef",
  blue: "#4595c5",
  green: "#369f80",
  amber: "#d39335",
  rose: "#df626f",
};

const AnimatedPath = Animated.createAnimatedComponent(Path);
export const STATUS_COLORS: Record<WorkflowAgentStatus, string> = {
  planned: "#89919e",
  pending: "#89919e",
  running: "#8378ef",
  waiting: "#d39335",
  completed: "#369f80",
  failed: "#df626f",
  cancelled: "#89919e",
  interrupted: "#d39335",
};

function LiveEdge({ d, status }: { d: string; status: WorkflowAgentStatus }) {
  const offset = useSharedValue(32);
  const reduced = useReducedMotion();
  useEffect(() => {
    cancelAnimation(offset);
    offset.set(32);
    // A short flow on state changes avoids keeping the GPU awake for an idle run.
    if (!reduced && status === "running") offset.set(withTiming(0, { duration: 650 }));
    return () => cancelAnimation(offset);
  }, [offset, reduced, status]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));
  return (
    <AnimatedPath
      d={d}
      fill="none"
      stroke={STATUS_COLORS[status]}
      strokeWidth={2}
      strokeDasharray={status === "running" ? "8 8" : undefined}
      animatedProps={props}
      opacity={status === "planned" ? 0.4 : 0.8}
    />
  );
}

function AgentCard({
  node,
  status,
  progress,
  elapsed,
  slot,
  slots,
  issue,
  changed,
  onPress,
  onLongPress,
  onAdd,
  providerDriver,
  modelLabel,
}: {
  providerDriver?: string;
  modelLabel?: string;
  node: WorkflowNode;
  status: WorkflowAgentStatus;
  progress: string;
  elapsed?: string;
  slot?: number;
  slots?: number;
  issue?: string;
  changed?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onAdd?: () => void;
}) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  const scale = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(opacity);
    opacity.set(1);
    scale.set(1);
    if (!reduced) {
      if (status === "running" || status === "waiting")
        opacity.set(
          withRepeat(withTiming(0.66, { duration: status === "waiting" ? 1200 : 850 }), 4, true),
        );
      if (status === "completed") {
        scale.set(0.97);
        scale.set(withSpring(1, { damping: 16, stiffness: 220 }));
      }
    }
    return () => {
      cancelAnimation(opacity);
      cancelAnimation(scale);
    };
  }, [opacity, reduced, scale, status]);
  const animated = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View
      className="bg-sheet-solid"
      style={[
        {
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          borderRadius: 18,
          borderWidth: changed ? 3 : 1.5,
          borderStyle: status === "planned" ? "dashed" : "solid",
          borderColor: issue
            ? STATUS_COLORS.failed
            : changed
              ? STATUS_COLORS.running
              : status === "pending" && node.kind === "agent" && node.color
                ? (ACCENTS[node.color] ?? STATUS_COLORS[status])
                : STATUS_COLORS[status],
          overflow: "hidden",
        },
        animated,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.kind === "agent" ? node.label || "Agent" : "Note"}, ${status}${issue ? `, ${issue}` : ""}`}
        accessibilityHint={
          onAdd ? "Tap to edit. Long press to delete this branch." : "Shows this agent's actions"
        }
        onPress={onPress}
        onLongPress={onLongPress}
        className="flex-1 gap-1 p-3"
      >
        <View className="flex-row items-center justify-between gap-2">
          <Text numberOfLines={1} className="flex-1 font-t3-semibold">
            {node.kind === "agent" ? node.label || node.text || "Agent" : "Note"}
          </Text>
          <Text style={{ color: STATUS_COLORS[status] }} className="text-xs">
            {status === "completed" ? "✓" : "●"}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          {node.kind === "agent" ? (
            <ProviderIcon provider={providerDriver ?? "unknown"} size={14} />
          ) : null}
          <Text numberOfLines={1} className="flex-1 text-xs text-foreground-muted">
            {node.kind === "agent"
              ? (modelLabel ?? node.model?.model ?? "Choose a model")
              : "Run guidance"}
          </Text>
        </View>
        {node.kind === "agent" ? (
          <Text className="text-xs text-foreground-muted">
            {countLabel(node)}
            {node.isolation === "worktree" ? " · worktree" : ""}
          </Text>
        ) : null}
        <Text
          numberOfLines={2}
          className={issue ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"}
        >
          {issue ||
            progress ||
            (node.kind === "agent"
              ? node.instructions || node.text || "Tap to add a brief"
              : node.text)}
        </Text>
        <View className="mt-auto flex-row items-center gap-2">
          <Text className="flex-1 text-xs text-foreground-muted">
            {elapsed ? `${status} · ${elapsed}` : node.kind === "agent" ? "Draft" : "Note"}
          </Text>
          {slots && slots > 1 ? (
            <Text className="text-xs text-foreground-muted">
              {(slot ?? 0) + 1}/{slots}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {onAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add child to ${node.kind === "agent" ? node.label : "note"}`}
          onPress={onAdd}
          className="absolute bottom-1 right-1 h-11 w-11 items-center justify-center rounded-full bg-secondary"
        >
          <Text className="text-xl text-primary">+</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

export function WorkflowCanvas({
  environmentId,
  workflow,
  run,
  now = 0,
  issues = EMPTY_ISSUES,
  changedIds = EMPTY_CHANGED,
  onNodePress,
  onNodeDelete,
  onAddChild,
  onThreadPress,
  selectedThreadId = null,
  preview = false,
}: {
  environmentId: EnvironmentId;
  workflow: WorkflowDefinition;
  run?: WorkflowRun;
  now?: number;
  issues?: readonly WorkflowIssue[];
  changedIds?: readonly WorkflowNodeId[];
  onNodePress?: (node: WorkflowNode) => void;
  onNodeDelete?: (id: WorkflowNodeId) => void;
  onAddChild?: (id: WorkflowNodeId) => void;
  onThreadPress?: (threadId: string, threadLink: string | null) => void;
  /** Run view: the agent whose sheet is open gets a ring. */
  selectedThreadId?: string | null;
  preview?: boolean;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const cards = useMemo(
    () =>
      run
        ? runTree(run)
        : workflow.nodes.map((node) => ({
            key: node.id,
            node,
            slot: 0,
            x: node.x,
            y: node.y,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            threadId: null,
            threadLink: null,
            parentThreadId: null,
            status: "pending" as const,
            progress: "",
            startedAt: null,
            completedAt: null,
          })),
    [run, workflow.nodes],
  );
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const pinchX = useSharedValue(0),
    pinchY = useSharedValue(0);
  const focalX = useSharedValue(0),
    focalY = useSharedValue(0);
  const fit = () => {
    const value = fitWorkflow(cards, viewport.width, viewport.height);
    scale.set(value.scale);
    x.set(value.x);
    y.set(value.y);
  };
  const identity = run?.id ?? workflow.id;
  const resetViewport = useEffectEvent((_identity: string, width: number, height: number) => {
    const value = fitWorkflow(cards, width, height);
    scale.set(value.scale);
    x.set(value.x);
    y.set(value.y);
  });
  const fitted = useRef<{ identity: string; width: number; height: number } | null>(null);
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  useEffect(() => {
    if (viewportWidth <= 0 || viewportHeight <= 0) return;
    const previous = fitted.current;
    fitted.current = { identity, width: viewportWidth, height: viewportHeight };
    // Fit a new drawing once; a resize only re-centers, keeping the user's pan and zoom.
    if (previous === null || previous.identity !== identity) {
      resetViewport(identity, viewportWidth, viewportHeight);
      return;
    }
    if (previous.width === viewportWidth && previous.height === viewportHeight) return;
    const value = resizeWorkflow({ scale: scale.value, x: x.value, y: y.value }, previous, {
      width: viewportWidth,
      height: viewportHeight,
    });
    scale.set(value.scale);
    x.set(value.x);
    y.set(value.y);
  }, [identity, viewportWidth, viewportHeight, scale, x, y]);
  const pan = makePanGesture()
    .enabled(!preview)
    .minDistance(8)
    .maxPointers(1)
    .averageTouches(true)
    .onStart(() => {
      startX.set(x.value);
      startY.set(y.value);
    })
    .onUpdate((event) => {
      x.set(startX.value + event.translationX);
      y.set(startY.value + event.translationY);
    });
  const pinch = makePinchGesture()
    .enabled(!preview)
    .onStart((event) => {
      startScale.set(scale.value);
      pinchX.set(x.value);
      pinchY.set(y.value);
      focalX.set(event.focalX);
      focalY.set(event.focalY);
    })
    .onUpdate((event) => {
      const value = pinchWorkflow(
        { scale: startScale.value, x: pinchX.value, y: pinchY.value },
        { x: focalX.value, y: focalY.value },
        { x: event.focalX, y: event.focalY },
        event.scale,
      );
      scale.set(value.scale);
      x.set(value.x);
      y.set(value.y);
    });
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  // Run trees are laid out fresh, so the drawing's marks only show while editing.
  const marks = run ? [] : (workflow.marks ?? []);
  const markBoxes = marks.map(markBox);
  const bounds = {
    left: Math.min(0, ...cards.map((card) => card.x), ...markBoxes.map((box) => box.x)) - 20,
    top: Math.min(0, ...cards.map((card) => card.y), ...markBoxes.map((box) => box.y)) - 20,
    right:
      Math.max(
        0,
        ...cards.map((card) => card.x + CARD_WIDTH),
        ...markBoxes.map((box) => box.x + box.width),
      ) + 20,
    bottom:
      Math.max(
        0,
        ...cards.map((card) => card.y + CARD_HEIGHT),
        ...markBoxes.map((box) => box.y + box.height),
      ) + 20,
  };
  const edges = useMemo(() => workflowTreeEdges(workflow, cards), [workflow, cards]);
  const slotsByNode = useMemo(() => {
    const slots = new Map<string, number>();
    for (const card of cards) slots.set(card.node.id, (slots.get(card.node.id) ?? 0) + 1);
    return slots;
  }, [cards]);
  return (
    <View
      className="flex-1 overflow-hidden bg-screen"
      onLayout={(event) => setViewport(event.nativeEvent.layout)}
    >
      <GestureDetector gesture={simultaneousGestures(pan, pinch)}>
        <Animated.View style={{ flex: 1 }}>
          <Animated.View
            pointerEvents={preview ? "none" : "auto"}
            style={[
              { position: "absolute", width: 1, height: 1, transformOrigin: [0, 0, 0] },
              style,
            ]}
          >
            <Svg
              pointerEvents="none"
              style={{ position: "absolute", left: bounds.left, top: bounds.top }}
              width={bounds.right - bounds.left}
              height={bounds.bottom - bounds.top}
              viewBox={`${bounds.left} ${bounds.top} ${bounds.right - bounds.left} ${bounds.bottom - bounds.top}`}
            >
              <WorkflowMarks marks={marks} />
              {edges.map((edge) => (
                <LiveEdge
                  key={edge.key}
                  d={edge.d}
                  status={
                    issues.some((issue) => issue.edgeId === edge.edgeId) ? "failed" : edge.status
                  }
                />
              ))}
              {workflow.edges
                .filter((edge) => edge.kind === "then")
                .map((edge) => {
                  const from = cards.find((card) => card.node.id === edge.from),
                    to = cards.find((card) => card.node.id === edge.to);
                  return from && to ? (
                    <Path
                      key={edge.id}
                      d={`M ${from.x + CARD_WIDTH} ${from.y + 30} L ${to.x} ${to.y + 30}`}
                      stroke="#d39335"
                      strokeDasharray="5 5"
                      strokeWidth={2}
                    />
                  ) : null;
                })}
            </Svg>
            {cards.map((card) => {
              const selection = card.node.kind === "agent" ? card.node.model : null;
              const provider = config?.providers.find(
                (entry) => entry.instanceId === selection?.instanceId,
              );
              const model = provider?.models.find((model) => model.slug === selection?.model);
              return (
                <View key={card.key} style={{ position: "absolute", left: card.x, top: card.y }}>
                  {selectedThreadId !== null && card.threadId === selectedThreadId ? (
                    <View
                      pointerEvents="none"
                      className="absolute border-2 border-primary"
                      style={{ left: -6, top: -6, right: -6, bottom: -6, borderRadius: 24 }}
                    />
                  ) : null}
                  <AgentCard
                    node={card.node}
                    modelLabel={
                      [
                        model?.name ?? selection?.model,
                        getExplicitModelEffortLabel(selection, model?.capabilities),
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                    providerDriver={provider?.driver}
                    status={card.status}
                    progress={card.progress}
                    elapsed={
                      run ? workflowElapsed(card.startedAt, card.completedAt, now) : undefined
                    }
                    slot={card.slot}
                    slots={slotsByNode.get(card.node.id) ?? 1}
                    issue={issues.find((issue) => issue.nodeId === card.node.id)?.message}
                    changed={changedIds.includes(card.node.id)}
                    onPress={() => {
                      if (card.threadId) onThreadPress?.(card.threadId, card.threadLink);
                      else onNodePress?.(card.node);
                    }}
                    onLongPress={onNodeDelete ? () => onNodeDelete(card.node.id) : undefined}
                    onAdd={
                      onAddChild && card.node.kind === "agent"
                        ? () => onAddChild(card.node.id)
                        : undefined
                    }
                  />
                </View>
              );
            })}
          </Animated.View>
        </Animated.View>
      </GestureDetector>
      {!preview ? (
        <View className="absolute bottom-4 right-4 flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            onPress={() => {
              const value = zoomAt({ scale: scale.value, x: x.value, y: y.value }, 0.8, {
                x: viewport.width / 2,
                y: viewport.height / 2,
              });
              scale.set(value.scale);
              x.set(value.x);
              y.set(value.y);
            }}
            className="h-11 w-11 items-center justify-center rounded-full bg-secondary"
          >
            <Text>−</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            onPress={() => {
              const value = zoomAt({ scale: scale.value, x: x.value, y: y.value }, 1.25, {
                x: viewport.width / 2,
                y: viewport.height / 2,
              });
              scale.set(value.scale);
              x.set(value.x);
              y.set(value.y);
            }}
            className="h-11 w-11 items-center justify-center rounded-full bg-secondary"
          >
            <Text>+</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fit workflow"
            onPress={fit}
            className="min-h-11 justify-center rounded-full bg-secondary px-4"
          >
            <Text className="text-sm">Fit</Text>
          </Pressable>
        </View>
      ) : null}
      {cards.length === 0 ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center p-8">
          <Text className="text-center text-foreground-muted">
            Add a lead box, or describe your team with Make with AI.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

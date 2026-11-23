import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ModelOption } from "../../lib/modelOptions";
import { useModelPicks } from "../usage/useModelPicks";
import {
  autoModelCanEvaluate,
  autoModelCandidates,
  autoModelEvidenceKey,
  autoModelSuggestionText,
} from "./autoModel.logic";
import { updateAutoModelDraft, useAutoModelDraft } from "./autoModelDraftState";
import { useAutoModelEvaluation } from "./useAutoModelEvaluation";
import { AUTO_MODEL_FADE_MS, useAutoModelPill } from "./useAutoModelPill";

const CAPSULE_HEIGHT = 28;
const GAP_ABOVE_MODEL_BUTTON = 6;
// The toolbar's own inset from the composer edge; a clamped capsule keeps it.
const EDGE_INSET = 6;

type AutoModelSuggestionProps = {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly attachmentCount: number;
  readonly currentSelection: ModelSelection;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Off, a model picked by hand, or not a new chat's first prompt. */
  readonly eligible: boolean;
  readonly busy: boolean;
  readonly pickerOpen: boolean;
  /** Left edge of the composer's model button within the row this sits in. */
  readonly anchorX: number;
  readonly onApply: (selection: ModelSelection) => void;
};

const selectionKeyOf = (selection: ModelSelection) =>
  JSON.stringify([selection.instanceId, selection.model, selection.options ?? []]);

/**
 * A model suggestion for a new chat's first prompt, sitting just above the model
 * button. It takes its own row while shown so it never covers the prompt.
 */
export const AutoModelSuggestion = memo(
  function AutoModelSuggestion(props: AutoModelSuggestionProps) {
    const [now] = useState(Date.now);
    const environments = useMemo(() => new Set([props.environmentId]), [props.environmentId]);
    const { picks, table } = useModelPicks(environments, now);
    const state = useAutoModelDraft(props.draftKey);
    const candidates = useMemo(
      () =>
        picks
          ? autoModelCandidates({
              providers: props.providers,
              options: props.modelOptions,
              picks,
              table,
              now,
            })
          : [],
      [picks, props.modelOptions, props.providers, table, now],
    );
    const canEvaluate = autoModelCanEvaluate({
      enabled: props.eligible,
      manualSelection: false,
      busy: props.busy,
      state,
    });
    useAutoModelEvaluation({
      draftKey: props.draftKey,
      enabled: canEvaluate,
      text: props.text,
      attachmentCount: props.attachmentCount,
      selectionKey: selectionKeyOf(props.currentSelection),
      evidenceKey: autoModelEvidenceKey(candidates, picks),
      latest: {
        environmentId: props.environmentId,
        currentSelection: props.currentSelection,
        candidates,
        picks,
      },
    });

    const pill = useAutoModelPill(
      state.recommendation,
      canEvaluate,
      props.text.trim().length >= 12 || props.attachmentCount > 0,
    );
    const settled = pill.acknowledged || pill.withdrawn;
    const recommendation = pill.displayed;
    const visible = recommendation !== null && !props.pickerOpen;
    const showing = visible && !settled && !pill.exiting;
    const { draftKey } = props;
    useEffect(() => {
      if (showing && state.recommendation && !state.shown) {
        updateAutoModelDraft(draftKey, (previous) =>
          previous.shown ? previous : { ...previous, shown: true },
        );
      }
    }, [showing, state.recommendation, state.shown, draftKey]);

    const [widths, setWidths] = useState({ row: 0, capsule: 0 });
    const onRowLayout = useCallback((event: LayoutChangeEvent) => {
      const row = event.nativeEvent.layout.width;
      setWidths((current) => (current.row === row ? current : { ...current, row }));
    }, []);
    const onCapsuleLayout = useCallback((event: LayoutChangeEvent) => {
      const capsule = event.nativeEvent.layout.width;
      setWidths((current) => (current.capsule === capsule ? current : { ...current, capsule }));
    }, []);

    const reduceMotion = useReducedMotion();
    const progress = useSharedValue(0);
    const entered = visible && !pill.exiting;
    useEffect(() => {
      progress.set(withTiming(entered ? 1 : 0, { duration: AUTO_MODEL_FADE_MS }));
    }, [entered, progress]);
    const animatedStyle = useAnimatedStyle(() => ({
      opacity: progress.get(),
      transform: [{ translateY: reduceMotion ? 0 : (1 - progress.get()) * 2 }],
    }));

    if (!visible || !recommendation) return null;
    const left =
      widths.row > 0 && widths.capsule > 0
        ? Math.max(EDGE_INSET, Math.min(props.anchorX, widths.row - widths.capsule - EDGE_INSET))
        : props.anchorX;
    const apply = () => {
      if (settled || pill.exiting) return;
      void Haptics.selectionAsync().catch(() => undefined);
      updateAutoModelDraft(draftKey, (previous) => ({ ...previous, accepted: true }));
      pill.acknowledge();
      props.onApply({
        ...recommendation.selection,
        instanceId: ProviderInstanceId.make(recommendation.selection.instanceId),
      });
    };
    const dismiss = () =>
      updateAutoModelDraft(draftKey, (previous) => ({ ...previous, dismissed: true }));
    const currentLabel =
      props.modelOptions.find(
        (option) =>
          option.selection.instanceId === props.currentSelection.instanceId &&
          option.selection.model === props.currentSelection.model,
      )?.label ?? props.currentSelection.model;
    const text = pill.acknowledged
      ? "Selected"
      : pill.withdrawn
        ? `Staying on ${currentLabel}`
        : autoModelSuggestionText(recommendation);

    return (
      <View
        onLayout={onRowLayout}
        style={{ height: CAPSULE_HEIGHT + GAP_ABOVE_MODEL_BUTTON, paddingBottom: 0 }}
      >
        <Animated.View
          onLayout={onCapsuleLayout}
          className="absolute top-0 flex-row items-center rounded-full border-border bg-card"
          style={[
            {
              left,
              height: CAPSULE_HEIGHT,
              maxWidth: widths.row > 0 ? widths.row - EDGE_INSET * 2 : undefined,
              borderWidth: StyleSheet.hairlineWidth,
            },
            animatedStyle,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text}
            accessibilityHint={settled ? undefined : "Uses this model for this chat"}
            className="h-full min-w-0 shrink flex-row items-center gap-1.5 pl-2.5"
            style={{ paddingRight: settled ? 10 : 2 }}
            disabled={settled || pill.exiting}
            onPress={apply}
          >
            <SymbolView
              name={settled ? "checkmark" : "sparkles"}
              size={12}
              tintColorClassName={pill.withdrawn ? "accent-icon-muted" : "accent-icon"}
              type="monochrome"
            />
            <Text
              className={`shrink text-[13px] ${pill.withdrawn ? "text-foreground-muted" : "text-foreground"}`}
              numberOfLines={1}
            >
              {text}
            </Text>
          </Pressable>
          {!settled && !pill.exiting ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss model suggestion"
              className="items-center justify-center"
              style={{ width: CAPSULE_HEIGHT, height: CAPSULE_HEIGHT }}
              onPress={dismiss}
            >
              <SymbolView
                name="xmark"
                size={10}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    );
  },
  // The composer rebuilds its selection object on every keystroke; compare it by value.
  (previous, next) => {
    for (const key of Object.keys(next) as Array<keyof AutoModelSuggestionProps>) {
      if (key === "currentSelection") {
        if (selectionKeyOf(previous.currentSelection) !== selectionKeyOf(next.currentSelection))
          return false;
      } else if (previous[key] !== next[key]) return false;
    }
    return true;
  },
);

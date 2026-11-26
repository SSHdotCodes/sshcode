import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { composerModelName } from "@t3tools/client-runtime/composer-model-display";
import { acpSpeedChoices, acpSpeedIcon } from "@t3tools/shared/acpComposer";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import {
  applyProviderOptionSelection,
  composerModelTraits,
  resolveProviderOptionDescriptors,
} from "../lib/providerOptions";
import { ComposerInlineControl } from "./ComposerToolbar";
import { EffortGauge } from "./EffortGauge";
import { FastModeBolt } from "./FastModeBolt";
import { ControlPillMenu } from "./ControlPillMenu";

export function ComposerModelControl({
  capabilities,
  selection,
  reportedSelection,
  shortName,
  instanceLabel,
  prompt,
  onAcpSpeedChange,
  ...props
}: Omit<
  ComponentProps<typeof ComposerInlineControl>,
  "accessibilityLabel" | "trailingAccessory"
> & {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly shortName?: string | undefined;
  readonly instanceLabel?: string | null | undefined;
  readonly prompt?: string | undefined;
  readonly onAcpSpeedChange?: (options: ReadonlyArray<ProviderOptionSelection>) => void;
}) {
  const traits = composerModelTraits({ capabilities, selection, reportedSelection, prompt });
  const name = composerModelName({ name: props.label, shortName });
  const effort = traits.effort;
  const hasEffortGauge = effort !== null && effort.barCount > 0;
  const nameWithInstance = instanceLabel ? `${instanceLabel} · ${name}` : name;
  const descriptors = onAcpSpeedChange
    ? resolveProviderOptionDescriptors({ capabilities, selections: selection?.options })
    : [];
  const speed = descriptors.find((descriptor) => acpSpeedChoices(descriptor));
  const speedChoices = speed && acpSpeedChoices(speed);
  const separateSpeed = speed?.type === "select" && speedChoices;
  const inlineSpeed = separateSpeed ? null : traits.speed;
  const modelControl = (
    <ComposerInlineControl
      {...props}
      label={effort?.barCount === 0 ? `${nameWithInstance} · ${effort.label}` : nameWithInstance}
      accessibilityLabel={[
        nameWithInstance,
        effort ? `Effort: ${effort.label}` : null,
        inlineSpeed ? `${inlineSpeed} mode on` : null,
        "Model and reasoning settings",
      ]
        .filter(Boolean)
        .join(", ")}
      trailingAccessory={
        hasEffortGauge || inlineSpeed ? (
          <View className="shrink-0 flex-row items-center gap-1">
            {hasEffortGauge ? <EffortGauge effort={effort} /> : null}
            {inlineSpeed ? <FastModeBolt /> : null}
          </View>
        ) : null
      }
    />
  );
  if (!separateSpeed || !speed || speed.type !== "select" || !onAcpSpeedChange) return modelControl;
  const current =
    speed.options.find((choice) => choice.id === getProviderOptionCurrentValue(speed)) ??
    speedChoices.off;
  const icon = acpSpeedIcon(current);
  const pickSpeed = (value: string) => {
    const options = applyProviderOptionSelection(descriptors, { id: speed.id, value });
    if (options) onAcpSpeedChange(options);
  };
  const bolt = <FastModeBolt lit={icon !== null} ultrafast={icon === "ultrafast"} />;
  const label = speed.options.length === 2 ? speedChoices.on.label : speed.label;
  const controlClass = "min-h-11 min-w-9 shrink-0 items-center justify-center";
  return (
    <View className="min-w-0 shrink flex-row items-center">
      <View className="min-w-0 shrink">{modelControl}</View>
      {speed.options.length === 2 ? (
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="togglebutton"
          accessibilityState={{ checked: icon !== null, disabled: props.disabled }}
          className={controlClass}
          disabled={props.disabled}
          onPress={() => pickSpeed(icon === null ? speedChoices.on.id : speedChoices.off.id)}
        >
          {bolt}
        </Pressable>
      ) : props.disabled ? (
        <View className={controlClass}>{bolt}</View>
      ) : (
        <ControlPillMenu
          accessibilityLabel={`${label}, ${current.label}`}
          accessibilityRole="button"
          actions={speed.options.map((choice) => ({
            id: choice.id,
            title: choice.label,
            state: choice.id === current.id ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => pickSpeed(nativeEvent.event)}
        >
          <View className={controlClass}>{bolt}</View>
        </ControlPillMenu>
      )}
    </View>
  );
}

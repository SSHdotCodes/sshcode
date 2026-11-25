import type { ComponentProps } from "react";
import { View } from "react-native";
import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { composerModelName } from "@t3tools/client-runtime/composer-model-display";
import { composerModelTraits } from "../lib/providerOptions";
import { ComposerInlineControl } from "./ComposerToolbar";
import { EffortGauge } from "./EffortGauge";
import { FastModeBolt } from "./FastModeBolt";

export function ComposerModelControl({
  capabilities,
  selection,
  reportedSelection,
  shortName,
  instanceLabel,
  prompt,
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
}) {
  const traits = composerModelTraits({ capabilities, selection, reportedSelection, prompt });
  const name = composerModelName({ name: props.label, shortName });
  const effort = traits.effort;
  const hasEffortGauge = effort !== null && effort.barCount > 0;
  const nameWithInstance = instanceLabel ? `${instanceLabel} · ${name}` : name;
  return (
    <ComposerInlineControl
      {...props}
      label={effort?.barCount === 0 ? `${nameWithInstance} · ${effort.label}` : nameWithInstance}
      accessibilityLabel={[
        nameWithInstance,
        effort ? `Effort: ${effort.label}` : null,
        traits.speed ? `${traits.speed} mode on` : null,
        "Model and reasoning settings",
      ]
        .filter(Boolean)
        .join(", ")}
      trailingAccessory={
        hasEffortGauge || traits.speed ? (
          <View className="shrink-0 flex-row items-center gap-1">
            {hasEffortGauge ? <EffortGauge effort={effort} /> : null}
            {traits.speed ? <FastModeBolt /> : null}
          </View>
        ) : null
      }
    />
  );
}

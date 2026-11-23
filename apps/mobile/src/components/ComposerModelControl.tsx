import type { ComponentProps } from "react";
import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { modelTraits } from "../lib/providerOptions";
import { ComposerInlineControl } from "./ComposerToolbar";
import { FastModeBolt } from "./FastModeBolt";

export function ComposerModelControl({
  capabilities,
  selection,
  reportedSelection,
  ...props
}: Omit<
  ComponentProps<typeof ComposerInlineControl>,
  "accessibilityLabel" | "trailingAccessory"
> & {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
}) {
  const traits = modelTraits({ capabilities, selection, reportedSelection });
  const label = [props.label, traits.effort].filter(Boolean).join(" · ");
  return (
    <ComposerInlineControl
      {...props}
      label={label}
      accessibilityLabel={[
        label,
        traits.speed ? `${traits.speed} mode on` : null,
        "Model and reasoning settings",
      ]
        .filter(Boolean)
        .join(", ")}
      trailingAccessory={traits.speed ? <FastModeBolt /> : null}
    />
  );
}

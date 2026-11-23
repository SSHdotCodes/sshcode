import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { isReasoningSelectDescriptor } from "@t3tools/shared/model";
import { CheckIcon } from "lucide-react";
import { createContext, use, type KeyboardEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type TraitsMenuContentProps,
  type TraitsPersistence,
  useTraitsSelection,
} from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** Set by the picker when Runs in sits above the levels, which then drop the model name. */
export const ModelPickerStackedColumnContext = createContext(false);

const ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";

export function LevelRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-reasoning-level": true,
    // The selected level holds the column's one tab stop; Up and Down move between levels.
    tabIndex: props.selected ? 0 : -1,
    className: ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? <span className="sr-only">Default</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">Default</span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

export function moveBetweenLevels(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "[data-reasoning-level]:not(:disabled)",
    ),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next =
    rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

/** A side column's title row. The first one matches the search row, so one rule runs across. */
export function ModelPickerColumnHeader(props: {
  readonly label: string;
  readonly detail?: string | null;
}) {
  return (
    <div className="shrink-0 px-3 pt-2">
      <div className="flex h-8 items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
        <span className="text-muted-foreground">{props.label}</span>
        {props.detail ? (
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {props.detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The model picker's Reasoning column: the selected model's effort levels, next to the model
 * list, so the model and its effort are picked in one place. Other options (Fast, context
 * window, agent) stay in the composer's traits control.
 */
export function ModelPickerReasoningColumn(
  props: Omit<TraitsMenuContentProps, "triggerClassName" | "isComposerOwned" | "omitReasoning"> &
    TraitsPersistence & {
      /** The model the levels belong to, shown in the header. */
      readonly modelLabel: string;
      /** Called after a level is picked, to close the picker. */
      readonly onPicked?: () => void;
    },
) {
  const { modelLabel, onPicked, ...traitsInput } = props;
  const traits = useTraitsSelection(traitsInput);
  const effort: SelectDescriptor | null = traits.modelIsUnavailable
    ? null
    : (traits.selectDescriptors.find(isReasoningSelectDescriptor) ?? null);
  const locked =
    effort !== null && effort.id === traits.primarySelectDescriptor?.id
      ? traits.ultrathinkInBodyText
      : false;
  const value = effort ? traits.selectValue(effort) : "";
  const stacked = use(ModelPickerStackedColumnContext);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-model-picker-reasoning="true">
      <ModelPickerColumnHeader
        label={effort?.label ?? "Reasoning"}
        detail={stacked ? null : modelLabel}
      />
      <div
        role="radiogroup"
        aria-label={effort?.label ?? "Reasoning"}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2 pb-1.5"
        onKeyDown={moveBetweenLevels}
      >
        {effort === null ? (
          <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">
            No effort levels
          </div>
        ) : (
          <>
            {locked ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                option.
              </div>
            ) : null}
            {effort.options.map((option) => (
              <LevelRow
                key={option.id}
                label={option.label}
                description={option.description}
                selected={option.id === value}
                isDefault={option.isDefault}
                disabled={locked}
                onPick={() => {
                  traits.handleSelectChange(effort, option.id);
                  onPicked?.();
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

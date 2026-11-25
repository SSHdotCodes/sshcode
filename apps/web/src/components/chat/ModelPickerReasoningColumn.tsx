import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { Slider } from "@base-ui/react/slider";
import { effortChoiceLabel, effortChoices } from "@t3tools/client-runtime/composer-model-display";
import { isReasoningSelectDescriptor } from "@t3tools/shared/model";
import { CheckIcon } from "lucide-react";
import { createContext, use, useState, type CSSProperties, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
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
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none transition-[background-color,color,scale] duration-100 ease-out motion-reduce:transition-none hover:bg-foreground/[0.09] active:scale-[0.985] motion-reduce:active:scale-100 focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64 disabled:active:scale-100";

export function LevelRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  tabIndex?: number;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-reasoning-level": true,
    // The selected level holds the column's one tab stop; Up and Down move between levels.
    tabIndex: props.tabIndex ?? (props.selected ? 0 : -1),
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
    <div className="shrink-0 px-3 pt-2.5">
      <div className="flex -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
        <span className="flex h-6.5 items-center text-muted-foreground">{props.label}</span>
        {props.detail ? (
          <span className="ms-auto min-w-0 truncate text-xs text-muted-foreground">
            {props.detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Glow strength per effects tier (see effortChoices): calm at Low, blazing at Ultracode.
const EFFORT_GLOW = [0.18, 0.4, 0.55, 0.7, 0.85] as const;
const EMBERS = [
  { delay: 0, drift: -6, color: "#FFC864" },
  { delay: 260, drift: 4, color: "#F28C4A" },
  { delay: 540, drift: -2, color: "#FFE3A3" },
  { delay: 800, drift: 7, color: "#E07A50" },
  { delay: 1060, drift: -8, color: "#FFC864" },
] as const;

/** The theme colour, or Ultracode's own warm accent. */
function effortTone(level: { readonly accent?: string | undefined }) {
  return level.accent ?? "var(--effort-accent)";
}

/**
 * Reasoning effort as a slider in the theme colour. The fill deepens as the effort rises and the
 * effects build with it: High glows, XHigh shimmers, Max breathes, and Ultracode turns warm and
 * throws embers off the thumb. The thumb glides to each stop with a small overshoot. Reduced motion keeps the colours and drops the motion.
 */
function EffortSlider(props: {
  readonly effort: SelectDescriptor;
  readonly levels: ReturnType<typeof effortChoices>["levels"];
  readonly value: string;
  readonly disabled: boolean;
  readonly onPick: (id: string, close: boolean) => void;
}) {
  const { levels, value } = props;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const selectedIndex = levels.findIndex((level) => level.id === value);
  const activeIndex = dragIndex ?? selectedIndex;
  const active = levels[activeIndex];
  const currentChoice = active ?? props.effort.options.find((option) => option.id === value);
  const currentLabel = currentChoice ? effortChoiceLabel(currentChoice) : null;
  const last = levels.length - 1;
  const onlyLevel = levels[0];
  const percent = last > 0 && activeIndex >= 0 ? (100 * activeIndex) / last : 0;
  const fx = active?.fx ?? 0;
  const glow = EFFORT_GLOW[fx] ?? EFFORT_GLOW[0];
  const tone = active ? effortTone(active) : "var(--effort-accent)";
  return (
    <div className={cn("shrink-0 px-1 pt-1 pb-1.5", props.disabled && "opacity-64")}>
      {currentLabel ? (
        <div className="px-1 text-sm font-medium text-foreground">{currentLabel}</div>
      ) : null}
      {last === 0 && onlyLevel ? (
        <button
          type="button"
          disabled={props.disabled}
          aria-label={effortChoiceLabel(onlyLevel)}
          className="flex w-full flex-col items-center gap-1 rounded-sm pt-2 pb-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => props.onPick(onlyLevel.id, true)}
        >
          <span
            className="size-2.5 rounded-full"
            style={{
              backgroundColor: activeIndex === 0 ? effortTone(onlyLevel) : undefined,
            }}
          />
          {onlyLevel.shortLabel}
        </button>
      ) : (
        <Slider.Root
          min={0}
          max={last}
          step={1}
          value={Math.max(0, activeIndex)}
          disabled={props.disabled}
          className="px-4"
          onValueChange={(index, details) => {
            if (details.reason === "drag" || details.reason === "track-press") {
              setDragIndex(index);
            }
          }}
          onValueCommitted={(index, details) => {
            setDragIndex(null);
            const level = levels[index];
            if (level)
              props.onPick(
                level.id,
                details.reason !== "keyboard" && details.reason !== "input-change",
              );
          }}
        >
          <Slider.Control
            data-effort-fx={fx}
            className="group/effort relative h-11 cursor-pointer touch-none select-none rounded-sm outline-none has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring has-[input:focus-visible]:ring-inset data-disabled:cursor-not-allowed"
            onPointerCancel={() => setDragIndex(null)}
            onKeyDown={(event) => {
              if (
                ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
                  event.key,
                )
              )
                event.stopPropagation();
            }}
          >
            <Slider.Track className="absolute inset-x-0 top-[11px] h-1.5 overflow-hidden rounded-full bg-foreground/10">
              {activeIndex >= 0 ? (
                <span
                  aria-hidden="true"
                  data-effort-fill="true"
                  className="effort-fill absolute inset-0 rounded-full"
                  style={{
                    // Paler at Low, full strength at the top: deeper thinking reads deeper, and
                    // Ultracode burns hottest at the tip.
                    backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${tone} 40%, transparent), ${fx >= 4 ? `${tone} 70%, #FFC864` : tone})`,
                    clipPath: `inset(0 ${100 - percent}% 0 0 round 9999px)`,
                  }}
                />
              ) : null}
            </Slider.Track>
            {fx >= 3 ? (
              <span
                aria-hidden="true"
                className="effort-fill-glow pointer-events-none absolute left-0 top-[11px] h-1.5 rounded-full"
                style={{ width: `${percent}%`, backgroundColor: tone }}
              />
            ) : null}
            {levels.map((level, index) => {
              const marker = (
                <span
                  key={level.id}
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[9px] flex -translate-x-1/2 flex-col items-center gap-1.75 text-3xs leading-4",
                    index === activeIndex ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                  style={{ left: `${(100 * index) / last}%` }}
                >
                  <span className="flex h-2.5 items-center">
                    <span
                      className={cn(
                        "size-1 rounded-full",
                        index <= activeIndex ? "bg-white/85" : "bg-muted-foreground/50",
                      )}
                    />
                  </span>
                  {level.shortLabel}
                </span>
              );
              const hint = level.description ?? (level.isDefault ? "Default" : undefined);
              return hint ? (
                <Tooltip key={level.id}>
                  <TooltipTrigger render={marker} />
                  <TooltipPopup side="top">{hint}</TooltipPopup>
                </Tooltip>
              ) : (
                marker
              );
            })}
            {active ? (
              <span
                aria-hidden="true"
                data-effort-thumb="true"
                className="effort-thumb pointer-events-none absolute top-[14px] size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white group-active/effort:scale-115"
                style={
                  {
                    left: `${percent}%`,
                    borderColor: tone,
                    boxShadow: `0 0 ${3 + 9 * glow}px ${1 + 2 * glow}px color-mix(in srgb, ${tone} ${35 + 45 * glow}%, transparent), 0 1px 2px rgb(0 0 0 / 0.3)`,
                    "--effort-tone": tone,
                  } as CSSProperties
                }
              />
            ) : null}
            {fx >= 4 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-[7px]"
                style={{ left: `${percent}%` }}
              >
                {EMBERS.map((ember) => (
                  <span
                    key={ember.delay}
                    className="effort-ember absolute size-[3px] rounded-full"
                    style={
                      {
                        backgroundColor: ember.color,
                        boxShadow: `0 0 4px 1px ${ember.color}`,
                        animationDelay: `${ember.delay}ms`,
                        "--ember-drift": `${ember.drift}px`,
                      } as CSSProperties
                    }
                  />
                ))}
              </span>
            ) : null}
            <Slider.Thumb
              className="pointer-events-none absolute top-3 size-3 opacity-0"
              getAriaLabel={() => props.effort.label}
              getAriaValueText={(_, index) => {
                const choice = levels[index];
                return currentLabel ?? (choice ? effortChoiceLabel(choice) : "");
              }}
            />
          </Slider.Control>
        </Slider.Root>
      )}
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
  const { levels, otherChoices } = effortChoices(effort?.options ?? []);
  const activeOtherIndex = Math.max(
    0,
    otherChoices.findIndex((choice) => choice.id === value),
  );
  const stacked = use(ModelPickerStackedColumnContext);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-model-picker-reasoning="true">
      <ModelPickerColumnHeader
        label={effort?.label ?? "Reasoning"}
        detail={stacked ? null : modelLabel}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2 pb-1.5">
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
            {levels.length > 0 ? (
              <EffortSlider
                key={`${traitsInput.model}:${effort.id}`}
                effort={effort}
                levels={levels}
                value={value}
                disabled={locked}
                onPick={(id, close) => {
                  traits.handleSelectChange(effort, id);
                  if (close) onPicked?.();
                }}
              />
            ) : null}
            {otherChoices.length > 0 ? (
              <div
                role="radiogroup"
                aria-label={effort.label}
                onKeyDown={moveBetweenLevels}
                className="flex flex-col gap-0.5"
              >
                {otherChoices.map((option, index) => (
                  <LevelRow
                    key={option.id}
                    label={option.label}
                    description={option.description}
                    selected={option.id === value}
                    isDefault={option.isDefault}
                    disabled={locked}
                    tabIndex={index === activeOtherIndex ? 0 : -1}
                    onPick={() => {
                      traits.handleSelectChange(effort, option.id);
                      onPicked?.();
                    }}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

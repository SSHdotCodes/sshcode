import { Toolbar } from "@base-ui/react/toolbar";
import type { ModelMaker } from "@t3tools/client-runtime/model-makers";
import { ProviderDriverKind } from "@t3tools/contracts";
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ShapesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute right-0 z-10 h-5 w-0.75 rounded-l-full bg-primary transition-[top] duration-180 ease-drawer motion-reduce:transition-none";
const RAIL_BUTTON_CLASS =
  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-[background-color,color,scale] duration-100 ease-out motion-reduce:transition-none hover:bg-foreground/10 aria-pressed:bg-foreground/[0.07] active:scale-[0.92] motion-reduce:active:scale-100 focus-visible:bg-foreground/10 focus-visible:outline-none";

/** A rail entry: favorites or one model maker (`maker:<id>`). */
export type ModelPickerRailSelection = "favorites" | `maker:${string}`;

export const makerRailSelection = (makerId: string): ModelPickerRailSelection => `maker:${makerId}`;

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

/** The maker's mark: a harness it ships (Codex for OpenAI), its own logo, else its initials. */
export const ModelMakerIcon = memo(function ModelMakerIcon(props: {
  maker: ModelMaker;
  className: string;
}) {
  if (props.maker.icon) {
    return (
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make(props.maker.icon.driver)}
        displayName={props.maker.label}
        acpRegistryAgentId={props.maker.icon.acpAgentId}
        className={props.className}
        iconClassName={props.className}
      />
    );
  }
  if (props.maker.logo) {
    return (
      <svg
        viewBox={props.maker.logo.viewBox}
        className={cn("shrink-0 text-foreground", props.className)}
        fill="currentColor"
        aria-hidden
      >
        <path
          d={props.maker.logo.path}
          fillRule={props.maker.logo.evenOdd ? "evenodd" : "nonzero"}
        />
      </svg>
    );
  }
  if (props.maker.id === "other") {
    return <ShapesIcon className={cn("shrink-0 text-muted-foreground", props.className)} />;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-foreground/10 text-3xs font-semibold leading-none tracking-tight text-foreground/80",
        props.className,
      )}
      aria-hidden
    >
      {props.maker.monogram}
    </span>
  );
});

function RailButton(props: {
  readonly id: ModelPickerRailSelection;
  readonly selected: boolean;
  readonly label: string;
  readonly onSelect: (id: ModelPickerRailSelection) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="relative w-full" data-model-picker-provider={props.id}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toolbar.Button
              className={RAIL_BUTTON_CLASS}
              onClick={() => props.onSelect(props.id)}
              type="button"
              aria-label={props.label}
              aria-pressed={props.selected}
            >
              {props.children}
            </Toolbar.Button>
          }
        />
        <TooltipPopup
          side={PICKER_TOOLTIP_SIDE}
          sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
          align="center"
        >
          {props.label}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The picker's left rail: favorites, then one button per model maker. */
export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ModelPickerRailSelection;
  onSelectInstance: (selection: ModelPickerRailSelection) => void;
  onFocusSearch: () => void;
  makers: ReadonlyArray<ModelMaker>;
  /** Render the favorites rail entry. */
  showFavorites?: boolean;
}) {
  const showFavorites = props.showFavorites ?? true;
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) return;
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    setSelectedIndicatorTop(
      selectedItem ? selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10 : null,
    );
  }, [props.makers, props.selectedInstanceId, showFavorites]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label="Model makers"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className={SELECTED_INDICATOR_CLASS}
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <RailButton
                id="favorites"
                label="Favorites"
                selected={props.selectedInstanceId === "favorites"}
                onSelect={props.onSelectInstance}
              >
                <StarIcon className="size-5 shrink-0 fill-current" aria-hidden />
              </RailButton>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}
          {props.makers.map((maker) => {
            const id = makerRailSelection(maker.id);
            return (
              <RailButton
                key={maker.id}
                id={id}
                label={maker.label}
                selected={props.selectedInstanceId === id}
                onSelect={props.onSelectInstance}
              >
                <ModelMakerIcon maker={maker} className="size-5" />
              </RailButton>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});

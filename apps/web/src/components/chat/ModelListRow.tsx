import {
  type ModelRankingTier,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, GripVerticalIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getProviderRowLabel,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  /** The model family's tier in the user's Implementation ranking. */
  rankingTier?: ModelRankingTier | null;
  unavailable?: boolean;
  creditWarning?: string | undefined;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  /** A grip that drags the row to a new place, in lists the user can reorder. */
  reorderHandle?: ReactNode;
  onToggleFavorite: () => void;
}) {
  const providerLabel = getProviderRowLabel(props.providerDisplayName, props.model.subProvider);

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="min-w-0 truncate text-xs font-medium leading-snug"
            onPointerEnter={(event) => {
              const name = event.currentTarget;
              name.title = name.scrollWidth > name.clientWidth ? (name.textContent ?? "") : "";
            }}
          >
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {props.rankingTier ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="outline"
                    size="sm"
                    aria-label={`${props.rankingTier} tier for implementation`}
                  />
                }
              >
                {props.rankingTier}
              </TooltipTrigger>
              <TooltipPopup side="top" align="center">
                {props.rankingTier} tier for implementation in your model rankings
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {props.creditWarning ? (
            <Badge variant="warning" size="sm">
              Out of credit
            </Badge>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {props.creditWarning ? (
          <div className="mt-1 line-clamp-2 text-xs text-warning-foreground">
            {props.creditWarning}
          </div>
        ) : null}
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              acpRegistryAgentId={props.acpRegistryAgentId}
              acpRegistryIconUrl={props.acpRegistryIconUrl}
              className="size-3"
              iconClassName="size-3"
            />
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        {props.reorderHandle}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-warning",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});

/**
 * A row that can be dragged by its grip to a new place in the list. Only the
 * grip starts a drag, so clicking the row still picks the model.
 */
export function SortableModelRow(props: {
  readonly id: string;
  readonly children: (reorderHandle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id });
  const handle = (
    <span
      {...attributes}
      {...listeners}
      ref={setActivatorNodeRef}
      data-reorder-handle=""
      aria-label="Reorder favorite"
      className={cn(
        "flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing",
        isDragging && "opacity-100",
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <GripVerticalIcon className="size-3.5" aria-hidden="true" />
    </span>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10")}
      // The row cancels every press to keep the cursor in the search box, and a drag never
      // starts from a cancelled press. Capturing here hands the grip's press to the drag first.
      onPointerDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-reorder-handle]")) {
          listeners?.onPointerDown?.(event);
        }
      }}
    >
      {props.children(handle)}
    </div>
  );
}

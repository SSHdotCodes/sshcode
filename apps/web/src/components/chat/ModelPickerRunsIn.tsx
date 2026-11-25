import type { ProviderDriverKind } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelPickerColumnHeader, moveBetweenLevels } from "./ModelPickerReasoningColumn";

export type ModelPickerRunsInRoute = {
  readonly key: string;
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  readonly selected: boolean;
  /** For one of the user's accounts of a provider: what it has left, such as "93% left". */
  readonly room?: string | null | undefined;
  readonly disabledReason: string | null;
  /** Unavailable until its harness is set up, which picking it opens. */
  readonly canOpenSetup?: boolean | undefined;
  /** Its latest run failed; the route still works. */
  readonly health?:
    | { readonly kind: string; readonly title: string; readonly outOfCredit?: boolean | undefined }
    | null
    | undefined;
};

const ROW =
  "flex min-h-7 w-full shrink-0 cursor-pointer flex-col justify-center rounded-sm px-2 py-1 text-left text-xs text-foreground outline-none transition-[background-color,color,scale] duration-100 ease-out motion-reduce:transition-none hover:bg-foreground/[0.09] active:scale-[0.985] motion-reduce:active:scale-100 focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

function routeIsBlocked(route: ModelPickerRunsInRoute, canOpenSetup: boolean) {
  return route.disabledReason !== null && !(route.canOpenSetup && canOpenSetup);
}

function RouteRow(props: {
  readonly route: ModelPickerRunsInRoute;
  readonly tabStop: boolean;
  readonly onPick: () => void;
  readonly onOpenSetup?: (() => void) | undefined;
}) {
  const { route } = props;
  // A route that needs setup opens it; any other unavailable route only explains itself.
  const blocked = routeIsBlocked(route, props.onOpenSetup !== undefined);
  const note = route.disabledReason ?? (route.health ? route.health.title : null);
  const button = (
    <button
      type="button"
      role="radio"
      aria-checked={route.selected}
      aria-disabled={route.disabledReason !== null}
      disabled={blocked}
      data-reasoning-level
      data-model-picker-route={route.key}
      tabIndex={props.tabStop ? 0 : -1}
      className={cn(ROW, route.disabledReason !== null && "text-muted-foreground")}
      onClick={route.disabledReason !== null ? props.onOpenSetup : props.onPick}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={route.driverKind}
          displayName={route.displayName}
          acpRegistryAgentId={route.acpRegistryAgentId}
          acpRegistryIconUrl={route.acpRegistryIconUrl}
          className="size-3.5"
          iconClassName="size-3.5"
        />
        <span className="min-w-0 flex-1 truncate" data-model-picker-route-name="true">
          {route.label}
        </span>
        {route.health?.outOfCredit ? (
          <Badge variant="warning" size="sm">
            Out of credit
          </Badge>
        ) : route.health ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              route.health.kind === "usage_limit" ? "bg-warning" : "bg-destructive",
            )}
            aria-label={route.health.title}
          />
        ) : null}
        {route.selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      </span>
      {/* What an account has left sits under its name, across the row: beside it, the name was squeezed out. */}
      {route.room ? (
        <span
          className="truncate pl-5.5 text-2xs tabular-nums text-muted-foreground"
          data-model-picker-route-room="true"
        >
          {route.room}
        </span>
      ) : null}
    </button>
  );
  if (note === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={blocked ? <span className="block w-full">{button}</span> : button} />
      <TooltipPopup side="right" className="max-w-56">
        {note}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The harnesses and gateways the selected model runs in; picking one switches the chat to it. */
export function ModelPickerRunsIn(props: {
  readonly modelName: string;
  readonly routes: ReadonlyArray<ModelPickerRunsInRoute>;
  readonly onPick: (routeKey: string) => void;
  readonly onOpenSetup?: ((routeKey: string) => void) | undefined;
  /** Under the routes of a new chat: which account new chats start on, and why. */
  readonly note?: string | null | undefined;
}) {
  const enabledRoutes = props.routes.filter(
    (route) => !routeIsBlocked(route, props.onOpenSetup !== undefined),
  );
  const tabStop = enabledRoutes.find((route) => route.selected) ?? enabledRoutes[0];
  return (
    <div className="flex max-h-52 shrink-0 flex-col" data-model-picker-runs-in="true">
      <ModelPickerColumnHeader label="Runs in" detail={props.modelName} />
      <div
        role="radiogroup"
        aria-label={`Runs in, for ${props.modelName}`}
        className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain px-2 pt-1.5 pb-1"
        onKeyDown={moveBetweenLevels}
      >
        {props.routes.map((route) => (
          <RouteRow
            key={route.key}
            route={route}
            tabStop={route === tabStop}
            onPick={() => props.onPick(route.key)}
            onOpenSetup={props.onOpenSetup ? () => props.onOpenSetup?.(route.key) : undefined}
          />
        ))}
      </div>
      {props.note ? (
        <p
          className="shrink-0 px-4 pb-1.5 text-2xs leading-snug text-muted-foreground"
          data-model-picker-account-note="true"
        >
          {props.note}
        </p>
      ) : null}
    </div>
  );
}

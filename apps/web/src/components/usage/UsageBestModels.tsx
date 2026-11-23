import { useModelPicks } from "./useModelPicks";
import { type EnvironmentId, type UsageProviderKind } from "@t3tools/contracts";
import type { ModelBenchmarkTable } from "@t3tools/shared/modelBenchmarks";
import {
  describePick,
  pickBarShare,
  pickRouteIcon,
  pickRule,
  picksBasis,
  PICKS_WINDOW_DAYS,
  pickTitle,
  pickValueText,
} from "@t3tools/shared/modelPickEvidence";
import {
  MODEL_PICK_KINDS,
  type ModelPick,
  type ModelPickKind,
  type ModelPicks,
  type PickRoute,
} from "@t3tools/shared/modelPicks";
import { AwardIcon, InfoIcon, PiggyBankIcon, ScaleIcon, ZapIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { UsageDither } from "./UsageDither";
import { UsagePlans } from "./UsagePlans";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { useCountUp } from "./useCountUp";

const KIND_STYLE: Record<
  ModelPickKind,
  { readonly color: string; readonly icon: typeof AwardIcon }
> = {
  quality: { color: "#8c7bd1", icon: AwardIcon },
  value: { color: "#4d9f8a", icon: ScaleIcon },
  speed: { color: "#e8a33d", icon: ZapIcon },
  frugal: { color: "#5b9bbd", icon: PiggyBankIcon },
};

// Drawn in a box in the top right corner that ends above the model's name, so the
// texture never sits under text that has to be read, however wide the card is.
const GLOW_BOX = "inset-auto top-0 right-0 h-10 w-[58%]";
function cornerGlow(x: number, y: number): number {
  return 0.7 * Math.max(0, 1 - Math.hypot(1 - x, y)) ** 1.5;
}

function RouteIcon({ route }: { readonly route: PickRoute }) {
  const icon = pickRouteIcon(route);
  if (icon === null) return null;
  if ("usage" in icon) {
    const presentation = PROVIDER_PRESENTATION[icon.usage];
    return (
      <ProviderInstanceIcon
        driverKind={presentation.driverKind}
        acpRegistryAgentId={presentation.acpRegistryAgentId}
        displayName={presentation.label}
        iconClassName="size-4"
      />
    );
  }
  return (
    <ProviderInstanceIcon
      driverKind={icon.driver}
      displayName={route.routeLabel}
      iconClassName="size-4"
    />
  );
}

function PickCard({
  pick,
  picks,
  index,
}: {
  readonly pick: ModelPick;
  readonly picks: ModelPicks;
  readonly index: number;
}) {
  const [hovered, setHovered] = useState(false);
  const style = KIND_STYLE[pick.kind];
  const Icon = style.icon;
  const description = describePick(pick, picks);
  const counted = useCountUp(description?.headline.value ?? 0, description?.headline.value != null);
  const winner = pick.winner;
  const runners = pick.ranked.slice(1, 3);

  return (
    <article
      className="usage-rise group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40 p-4"
      style={{ "--usage-rise-index": index } as CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <UsageDither
        className={cn(
          GLOW_BOX,
          "opacity-70 transition-opacity duration-500 group-hover:opacity-100",
        )}
        color={style.color}
        intensity={cornerGlow}
        pulse={hovered}
        revealKey={winner?.key ?? "none"}
      />
      <div className="relative flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-2xs font-medium tracking-wider text-muted-foreground uppercase">
            <Icon className="size-3.5" style={{ color: style.color }} aria-hidden />
            {pickTitle(pick.kind)}
          </span>
          {description?.badge ? (
            <span
              className="rounded-full border px-1.5 py-px text-3xs font-medium"
              style={{
                color: style.color,
                borderColor: `color-mix(in srgb, ${style.color} 45%, transparent)`,
              }}
            >
              {description.badge}
            </span>
          ) : null}
        </div>

        {winner && description ? (
          <>
            <div className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <RouteIcon route={winner.route} />
                <span className="truncate text-base font-semibold text-foreground">
                  {winner.label}
                </span>
              </span>
              <span className="truncate text-2xs text-muted-foreground">
                {winner.route.routeLabel}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-3xl font-semibold text-foreground tabular-nums">
                {description.headline.value === null
                  ? description.headline.text
                  : description.headline.format(counted)}
              </span>
              <span className="text-xs text-muted-foreground">{description.headline.unit}</span>
            </div>
            {/* One reason on the card; the rest open on hover, so the cards stay scannable. */}
            <div className="flex flex-col items-start gap-0.5 text-xs text-muted-foreground">
              {description.lines[0] ? <span>{description.lines[0]}</span> : null}
              {description.lines.length > 1 ? (
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    render={<InlineButton tone="muted" />}
                    aria-label={`More on why ${winner.label} was picked`}
                  >
                    +{description.lines.length - 1} more
                  </PopoverTrigger>
                  <PopoverPopup
                    side="bottom"
                    align="start"
                    className="w-80 max-w-[calc(100vw-2rem)]"
                  >
                    <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      {description.lines.slice(1).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </PopoverPopup>
                </Popover>
              ) : null}
            </div>
            {runners.length > 0 ? (
              <ol className="mt-auto flex flex-col gap-1.5 border-t border-border/50 pt-2.5">
                {runners.map((candidate, runnerIndex) => (
                  <li key={candidate.key} className="flex flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2 text-2xs">
                      <span className="min-w-0 truncate text-muted-foreground">
                        <span className="tabular-nums">{runnerIndex + 2}.</span> {candidate.label}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {pickValueText(pick.kind, candidate, pick)}
                      </span>
                    </span>
                    <span className="h-0.5 overflow-hidden rounded-full bg-border/50">
                      <span
                        className="usage-bar-grow block h-full rounded-full"
                        style={
                          {
                            width: `${Math.max(2, pickBarShare(pick.kind, candidate, pick) * 100)}%`,
                            backgroundColor: style.color,
                            opacity: 0.7,
                            "--usage-rise-index": index + runnerIndex + 2,
                          } as CSSProperties
                        }
                      />
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not enough evidence yet. This fills in as you use more models and your leads grade their
            subagents.
          </p>
        )}
      </div>
    </article>
  );
}

function HowPicked({ table }: { readonly table: ModelBenchmarkTable }) {
  const metrics = Object.values(table.metrics);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<InlineButton tone="muted" />}
        aria-label="How the best models are picked"
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-3 text-xs">
          {MODEL_PICK_KINDS.map((kind) => (
            <div key={kind} className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{pickTitle(kind)}</span>
              <span className="text-muted-foreground">{pickRule(kind)}</span>
            </div>
          ))}
          <p className="border-t border-border/60 pt-2 text-muted-foreground">
            Every model in your connected providers competes, as long as it has public scores or
            your own grades. Usage is your last {PICKS_WINDOW_DAYS} days. Plan prices are list
            prices unless you enter what you pay under Your plans.
            {metrics.length > 0
              ? ` Benchmarks: ${metrics
                  .map((metric) => [metric.label, metric.version].filter((part) => part).join(" "))
                  .join(", ")}.`
              : ""}
            {table.liveSource
              ? ` Scores and speed are read from ${table.liveSource} once a day.`
              : ""}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function UsageBestModels({
  selectedEnvironmentIds,
  hiddenProviders,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
}) {
  const { picks, providers, table, shown, loading } = useModelPicks(
    selectedEnvironmentIds,
    hiddenProviders,
    now,
  );
  const planPrices = usePrimarySettings((settings) => settings.usagePlanPrices);

  if (shown === null || loading) {
    return (
      <section
        aria-label="Best models for you"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <span role="status" className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-4">
          Updating usage…
        </span>
        {MODEL_PICK_KINDS.map((kind) => (
          <Skeleton key={kind} className="h-52" />
        ))}
      </section>
    );
  }
  // Nothing ran in the window: the page's own empty state says so already.
  if (picks.candidates.length === 0) return null;

  return (
    <section aria-label="Best models for you" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          Best models for you
          <HowPicked table={table} />
        </h2>
        <span className="text-xs text-muted-foreground">{picksBasis(picks, table)}</span>
      </div>
      <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4")}>
        {MODEL_PICK_KINDS.map((kind, index) => (
          <PickCard key={kind} pick={picks.picks[kind]} picks={picks} index={index} />
        ))}
      </div>
      <UsagePlans picks={picks} providers={providers} prices={planPrices} />
    </section>
  );
}

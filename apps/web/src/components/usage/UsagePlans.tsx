import type { ServerProvider } from "@t3tools/contracts";
import { describePlan, planPriceRows, type PlanPriceRow } from "@t3tools/shared/modelPickEvidence";
import type { ModelPicks } from "@t3tools/shared/modelPicks";
import { PLAN_PRICES_AS_OF } from "@t3tools/shared/subscriptionPlans";
import { PencilIcon } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const PLAN_COLOR = "#4d9f8a";

function listPriceDate(): string {
  const [year, month, day] = PLAN_PRICES_AS_OF.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** What the user typed for a price: a number, blank for the list price, or not a price. */
function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : undefined;
}

function PlanPrices({
  rows,
  open,
  onOpenChange,
}: {
  readonly rows: ReadonlyArray<PlanPriceRow>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const updateSettings = useUpdatePrimarySettings();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const text = (row: PlanPriceRow) =>
    drafts[row.instanceId] ?? (row.yourUsd === undefined ? "" : String(row.yourUsd));
  const invalid = rows.some((row) => parsePrice(text(row)) === undefined);

  const save = () => {
    const patch: Record<string, number | null> = {};
    for (const row of rows) {
      const draft = drafts[row.instanceId];
      if (draft === undefined) continue;
      const price = parsePrice(draft);
      if (price === undefined || price === (row.yourUsd ?? null)) continue;
      patch[row.instanceId] = price;
    }
    if (Object.keys(patch).length > 0) updateSettings({ usagePlanPrices: patch });
    setDrafts({});
    onOpenChange(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setDrafts({});
        onOpenChange(next);
      }}
    >
      <PopoverTrigger render={<InlineButton tone="muted" />} aria-label="Edit what your plans cost">
        <PencilIcon className="size-3" aria-hidden />
        <span className="text-xs">What you pay</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <form
          className="flex flex-col gap-3 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) save();
          }}
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">What you pay a month</span>
            <span className="text-muted-foreground">
              Blank uses the list price from {listPriceDate()}, or counts the provider as pay per
              token when there is none. Enter 0 for a plan that is free.
            </span>
          </div>
          <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.instanceId} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-foreground">{row.planLabel}</span>
                  {row.planLabel === row.label ? null : (
                    <span className="truncate text-2xs text-muted-foreground">{row.label}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  $
                  <Input
                    size="compact"
                    className="w-20"
                    inputMode="decimal"
                    value={text(row)}
                    placeholder={row.listUsd === undefined ? "none" : String(row.listUsd)}
                    aria-label={`Monthly price of ${row.planLabel}`}
                    aria-invalid={parsePrice(text(row)) === undefined || undefined}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [row.instanceId]: event.target.value }))
                    }
                  />
                  /mo
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={invalid}>
              Save
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * What each plan costs against what it bought at API prices, and what its
 * limits would allow. The prices here are what Value and Low cost are worked
 * out from, so they can be corrected in place.
 */
export function UsagePlans({
  picks,
  providers,
  prices,
}: {
  readonly picks: ModelPicks;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly prices: Readonly<Record<string, number>>;
}) {
  const [editing, setEditing] = useState(false);
  const rows = useMemo(() => planPriceRows(providers, prices), [providers, prices]);
  if (picks.plans.length === 0) return null;

  return (
    <section aria-label="Your plans against API prices" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-medium text-foreground">Your plans against API prices</h3>
          <span className="text-xs text-muted-foreground">
            what each bought, and what its limits would allow
          </span>
        </span>
        <PlanPrices rows={rows} open={editing} onOpenChange={setEditing} />
      </div>
      <ul className="flex flex-col divide-y divide-border/50 rounded-xl border border-border/60 bg-card/40">
        {picks.plans.map((plan, index) => {
          const description = describePlan(plan);
          const provider = providers.find((entry) => entry.instanceId === plan.instanceId);
          const detail = [description.used, description.capacity].filter(Boolean).join(" · ");
          return (
            <li
              key={plan.accountKey ?? plan.instanceId}
              className="usage-rise grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]"
              style={{ "--usage-rise-index": index + 4 } as CSSProperties}
            >
              <span className="flex min-w-0 items-center gap-2">
                {provider ? (
                  <ProviderInstanceIcon
                    driverKind={provider.driver}
                    displayName={provider.displayName ?? plan.label}
                    iconClassName="size-4"
                  />
                ) : null}
                <span className="truncate text-sm font-medium text-foreground">{plan.label}</span>
                {description.price === null ? (
                  <InlineButton tone="picker" onClick={() => setEditing(true)}>
                    Set price
                  </InlineButton>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {description.price}
                  </span>
                )}
              </span>
              <span className="order-3 col-span-2 flex min-w-0 flex-col gap-1 sm:order-none sm:col-span-1">
                <span className="text-xs text-muted-foreground">{detail}</span>
                {description.usedShare === null ? null : (
                  <span className="h-0.5 overflow-hidden rounded-full bg-border/50">
                    <span
                      className="usage-bar-grow block h-full rounded-full"
                      style={
                        {
                          width: `${Math.max(1, description.usedShare * 100)}%`,
                          backgroundColor: PLAN_COLOR,
                          opacity: 0.7,
                          "--usage-rise-index": index + 5,
                        } as CSSProperties
                      }
                    />
                  </span>
                )}
              </span>
              <span className="flex min-w-16 flex-col items-end">
                {description.usedTimes === null ? (
                  <span className="text-xs text-muted-foreground">
                    {plan.monthlyUsd === 0 ? "free" : "—"}
                  </span>
                ) : (
                  <>
                    <span className="text-lg leading-tight font-semibold text-foreground tabular-nums">
                      {description.usedTimes.replace(" its price", "")}
                    </span>
                    <span className="text-2xs text-muted-foreground">its price, used</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

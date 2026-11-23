import {
  activeProviderFailure,
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  type ServerProvider,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { formatResetsIn, usedPercentLabel } from "@t3tools/shared/usageLimits";
import { recentUsageRunOut } from "@t3tools/shared/usageLimitForecast";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { accountUnavailable } from "../provider/accountAvailability.ts";
import {
  isUsageLimitReadingStale,
  USAGE_LIMIT_STALE_AFTER_MS,
} from "../provider/usageLimitFreshness.ts";

export const UsageLimitsInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId).annotate({
    description:
      "Only this provider instance; omit to include all instances and extra usage sources.",
  }),
});

// An agent choosing a provider has no use for the day-by-day rise the Usage page prices with.
const { dailyRise: _dailyRise, ...agentWindowFields } = ServerProviderUsageWindow.fields;

const Reading = Schema.Struct({
  checkedAt: IsoDateTime,
  stale: Schema.Boolean,
  unavailable: Schema.NullOr(ServerProviderUsageLimits.fields.unavailable.schema),
  windows: Schema.Array(
    Schema.Struct({
      ...agentWindowFields,
      resetsAt: Schema.NullOr(IsoDateTime),
      resetsIn: Schema.NullOr(Schema.String),
    }),
  ),
  resetCredits: Schema.optional(
    Schema.Struct({
      availableCount: Schema.Number,
      nextExpiresAt: Schema.optional(IsoDateTime),
    }),
  ),
  externalUsage: ServerProviderUsageLimits.fields.externalUsage,
  summary: Schema.String,
});

export const UsageLimitsResult = Schema.Struct({
  createdAt: IsoDateTime,
  staleAfterMs: Schema.Number,
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      displayName: Schema.String,
      ...Reading.fields,
    }),
  ),
  sources: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      kind: UsageLimitSourceSnapshot.fields.kind,
      credits: UsageLimitSourceSnapshot.fields.credits,
      displayName: Schema.String,
      checkedAt: IsoDateTime,
      stale: Schema.Boolean,
      unavailable: Schema.NullOr(Schema.String),
      accounts: Schema.Array(
        Schema.Struct({
          accountId: Schema.String,
          driver: ProviderDriverKind,
          displayName: Schema.String,
          ...Reading.fields,
        }),
      ),
    }),
  ),
});
export type UsageLimitsResult = typeof UsageLimitsResult.Type;

function isStale(checkedAt: string, now: number): boolean {
  return now - Date.parse(checkedAt) > USAGE_LIMIT_STALE_AFTER_MS;
}

function reading(
  limits: ServerProviderUsageLimits,
  name: string,
  now: number,
): typeof Reading.Type {
  const windows = limits.windows.map(({ dailyRise: _rise, ...window }) => ({
    ...window,
    resetsAt: window.resetsAt ?? null,
    resetsIn: formatResetsIn(window, now),
  }));
  const stale = isUsageLimitReadingStale(limits, now);
  const windowsText = windows
    .map((window, index) => {
      const at = stale ? null : recentUsageRunOut(limits.windows[index]!, now);
      const minutes = at === null ? null : Math.max(1, Math.round((at - now) / 60_000));
      const left =
        at !== null && minutes !== null && at - now <= 3 * 60 * 60_000
          ? `; ~${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`} left at current pace`
          : "";
      return `${window.label}: ${usedPercentLabel(window)} (${window.resetsIn ?? "reset unknown"})${left}`;
    })
    .join("; ");
  const failure = limits.unavailable
    ? `unavailable (${limits.unavailable.message ?? limits.unavailable.reason})`
    : null;
  // A failed probe can still carry the last reading, dated by `checkedAt`.
  const status =
    failure && windows.length > 0
      ? `${failure}; last read ${limits.checkedAt}: ${windowsText}`
      : (failure ?? (windows.length === 0 ? "no limit windows reported" : windowsText));
  const credits = limits.resetCredits;
  return {
    checkedAt: limits.checkedAt,
    stale,
    unavailable: limits.unavailable ?? null,
    windows,
    ...(credits
      ? {
          resetCredits: {
            availableCount: credits.availableCount,
            ...(credits.nextExpiresAt ? { nextExpiresAt: credits.nextExpiresAt } : {}),
          },
        }
      : {}),
    ...(limits.externalUsage ? { externalUsage: limits.externalUsage } : {}),
    summary: `${name}: ${status}${credits ? `; ${credits.availableCount} reset credits` : ""}${stale ? "; stale" : ""}`,
  };
}

/** Reads only materialized snapshots, without probing providers or exposing credential identities. */
export function collectUsageLimits(
  providers: readonly ServerProvider[],
  sources: readonly UsageLimitSourceSnapshot[],
  now: number,
  input: typeof UsageLimitsInput.Type,
): UsageLimitsResult {
  return {
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    staleAfterMs: USAGE_LIMIT_STALE_AFTER_MS,
    providers: providers.flatMap((provider) => {
      const account = accountUnavailable(provider, now);
      if (
        !provider.enabled ||
        (!provider.usageLimits && !account) ||
        (input.providerInstanceId !== undefined && input.providerInstanceId !== provider.instanceId)
      ) {
        return [];
      }
      const displayName = provider.displayName?.trim() || String(provider.driver);
      const limits = provider.usageLimits
        ? reading(provider.usageLimits, `${displayName} [${provider.instanceId}]`, now)
        : {
            checkedAt: provider.checkedAt,
            stale: isStale(provider.checkedAt, now),
            unavailable: null,
            windows: [],
            summary: "No quota reading.",
          };
      // A run that just hit the limit is fresher than the last quota probe.
      const limitedRun = activeProviderFailure(provider, now);
      return [
        {
          providerInstanceId: provider.instanceId,
          driver: provider.driver,
          displayName,
          ...limits,
          ...(account
            ? {
                summary: account.recheckAt
                  ? `Account unavailable: ${account.reason} Recheck ${account.recheckAt}.`
                  : account.reason,
              }
            : limitedRun?.kind === "usage_limit"
              ? {
                  summary: `${limits.summary}; a run hit the limit at ${limitedRun.occurredAt}${
                    limitedRun.resetAt ? `, resets ${limitedRun.resetAt}` : ""
                  }`,
                }
              : {}),
        },
      ];
    }),
    // A pooled source account is not a runnable provider instance. Do not
    // imply a routing relationship when an instance filter is supplied.
    sources:
      input.providerInstanceId === undefined
        ? sources.map((source) => ({
            sourceId: source.id,
            kind: source.kind,
            displayName: source.label,
            ...(source.credits ? { credits: source.credits } : {}),
            checkedAt: source.checkedAt,
            stale: isStale(source.checkedAt, now),
            unavailable: source.error ?? null,
            accounts: source.accounts.map((account) => ({
              accountId: account.id,
              driver: account.driver,
              displayName: `${source.label} / ${account.id}`,
              ...reading(account.usageLimits, `${source.label} / ${account.id}`, now),
            })),
          }))
        : [],
  };
}

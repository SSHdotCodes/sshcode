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
const { dailyRise: _dailyRise, id: _id, ...agentWindowFields } = ServerProviderUsageWindow.fields;

const Reading = Schema.Struct({
  checkedAt: IsoDateTime,
  stale: Schema.Boolean,
  unavailable: ServerProviderUsageLimits.fields.unavailable,
  windows: Schema.Array(
    Schema.Struct({
      ...agentWindowFields,
      runOutInMinutes: Schema.optional(Schema.Number),
    }),
  ),
  resetCredits: Schema.optional(
    Schema.Struct({
      availableCount: Schema.Number,
      nextExpiresAt: Schema.optional(IsoDateTime),
    }),
  ),
  externalUsage: ServerProviderUsageLimits.fields.externalUsage,
});

export const UsageLimitsResult = Schema.Struct({
  createdAt: IsoDateTime,
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      displayName: Schema.String,
      ...Reading.fields,
      accountUnavailable: Schema.optional(
        Schema.Struct({ reason: Schema.String, recheckAt: Schema.optional(IsoDateTime) }),
      ),
      recentLimit: Schema.optional(
        Schema.Struct({ occurredAt: IsoDateTime, resetAt: Schema.optional(IsoDateTime) }),
      ),
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
      unavailable: Schema.optional(Schema.String),
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
  driver: ProviderDriverKind,
  limits: ServerProviderUsageLimits,
  now: number,
): typeof Reading.Type {
  const stale = isUsageLimitReadingStale(driver, limits, now);
  const windows = limits.windows.map((window) => {
    const { dailyRise: _rise, id: _id, ...fields } = window;
    const runOutAt = stale ? null : recentUsageRunOut(window, now);
    return {
      ...fields,
      ...(runOutAt !== null && runOutAt - now <= 3 * 60 * 60_000
        ? { runOutInMinutes: Math.max(1, Math.round((runOutAt - now) / 60_000)) }
        : {}),
    };
  });
  const credits = limits.resetCredits;
  return {
    checkedAt: limits.checkedAt,
    stale,
    ...(limits.unavailable === undefined ? {} : { unavailable: limits.unavailable }),
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
        ? reading(provider.driver, provider.usageLimits, now)
        : {
            checkedAt: provider.checkedAt,
            stale: isStale(provider.checkedAt, now),
            windows: [],
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
            ? { accountUnavailable: account }
            : limitedRun?.kind === "usage_limit"
              ? {
                  recentLimit: {
                    occurredAt: limitedRun.occurredAt,
                    ...(limitedRun.resetAt ? { resetAt: limitedRun.resetAt } : {}),
                  },
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
            ...(source.error === undefined ? {} : { unavailable: source.error }),
            accounts: source.accounts.map((account) => ({
              accountId: account.id,
              driver: account.driver,
              displayName: `${source.label} / ${account.id}`,
              ...reading(account.driver, account.usageLimits, now),
            })),
          }))
        : [],
  };
}

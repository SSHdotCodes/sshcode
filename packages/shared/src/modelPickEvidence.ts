// @effect-diagnostics globalDate:off -- Calendar days and dates are formatted here, at the display boundary.
/**
 * Turns what the apps already know (merged usage, provider snapshots, subagent
 * grades, the benchmark table) into the "best models" picks, and words each
 * pick's evidence. Shared so the desktop and the phone show the same picks in
 * the same words. Runs on Hermes: no `toSorted`, `toReversed`, `findLast`.
 *
 * @module modelPickEvidence
 */
import {
  rememberedAccountFailure,
  UsageProviderKind,
  type ServerProvider,
  type ServerConfig,
  type EnvironmentId,
  type SubagentRankingsSnapshot,
  type UsageBucket,
} from "@t3tools/contracts";

import { pickAccountForNewSession } from "./accountBalance.ts";
import { isReasoningOptionId, supersededModelVersions } from "./model.ts";
import { isGoogleSubscription, providerAccountKeyResolver } from "./usageLimits.ts";
import type { ModelBenchmarkTable } from "./modelBenchmarks.ts";
import {
  benchmarkFor,
  benchmarksAtEffort,
  normalizeModelId,
  pickBestModels,
  NEAR_FREE_PER_M_OUTPUT_USD,
  PICK_QUALITY_FLOOR,
  realCostForSameWork,
  realCostPerMOutput,
  valueScore,
  type ModelPick,
  type ModelPickKind,
  type ModelPicks,
  type PickBenchmarkModel,
  type PickBenchmarks,
  type PickCandidate,
  type PickGrades,
  type PickLimitWindow,
  type PickPlan,
  type PickRoute,
  type PlanSummary,
} from "./modelPicks.ts";
import { knownPlan, planName } from "./subscriptionPlans.ts";
import { formatCount, formatTokens, formatUsd } from "./usageFormat.ts";
import {
  isModelCostUnknown,
  mergeUsage,
  type EnvironmentUsage,
  type ModelTotals,
} from "./usageMerge.ts";

/** How far back the picks look, in days. */
export const PICKS_WINDOW_DAYS = 30;

const NO_TOKENS = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/** What a route's icon is drawn from: a usage provider, or a provider driver. */
export type PickRouteIcon =
  | { readonly usage: UsageProviderKind }
  | { readonly driver: ServerProvider["driver"] };

export function pickRouteIcon(route: PickRoute): PickRouteIcon | null {
  const [kind, value] = (route.provider ?? "").split(":", 2);
  if (!value) return null;
  if (kind === "usage") {
    const usage = UsageProviderKind.literals.find((literal) => literal === value);
    return usage === undefined ? null : { usage };
  }
  return kind === "driver" ? { driver: value as ServerProvider["driver"] } : null;
}

/** A catalog snapshot remains scoped to the machine that supplied it. */
export type ModelPickProvider = ServerProvider & {
  readonly environmentId?: EnvironmentId;
  readonly accountKey?: string;
  readonly hiddenModels?: readonly string[] | undefined;
};

/** Usage is machine-scoped, so its candidate accounts use that machine's model preferences. */
export function modelPickProviders(
  environmentId: EnvironmentId,
  config: ServerConfig | null | undefined,
): ModelPickProvider[] {
  return (config?.providers ?? []).map((provider) => ({
    ...provider,
    environmentId,
    hiddenModels: config?.settings?.providerModelPreferences?.[provider.instanceId]?.hiddenModels,
  }));
}

function identifyProviders(providers: ReadonlyArray<ModelPickProvider>): ModelPickProvider[] {
  const resolveKey = providerAccountKeyResolver(providers);
  const named = providers.map((provider) => resolveKey(provider) ?? undefined);
  // A login a machine cannot name (a token has no email) is taken for the account its
  // instance id names on a machine that can: apart, one plan would be listed and paid twice.
  const namedByInstance = new Map<string, Set<string>>();
  providers.forEach((provider, index) => {
    const key = named[index];
    if (key === undefined) return;
    const keys = namedByInstance.get(provider.instanceId) ?? new Set<string>();
    keys.add(key);
    namedByInstance.set(provider.instanceId, keys);
  });
  return providers.map((provider, index) => {
    const elsewhere = namedByInstance.get(provider.instanceId);
    const key =
      named[index] ??
      (elsewhere?.size === 1
        ? [...elsewhere][0]
        : provider.environmentId === undefined
          ? undefined
          : JSON.stringify([provider.environmentId, provider.instanceId]));
    return { ...provider, ...(key === undefined ? {} : { accountKey: key }) };
  });
}

const accountOf = (provider: ModelPickProvider) => provider.accountKey ?? provider.instanceId;
export type ModelPickSnapshot = SubagentRankingsSnapshot & {
  readonly environmentId?: EnvironmentId;
};

const routeKey = (route: {
  readonly accountKey?: string;
  readonly instanceId?: string;
  readonly model: string;
}) => `${route.accountKey ?? route.instanceId}\0${route.model}`;

function providerOf(
  providers: ReadonlyArray<ModelPickProvider>,
  instanceId: string | undefined,
  environmentId?: string,
): ModelPickProvider | undefined {
  return instanceId === undefined
    ? undefined
    : (providers.find(
        (provider) =>
          provider.instanceId === instanceId && provider.environmentId === environmentId,
      ) ??
        providers.find(
          (provider) => provider.instanceId === instanceId && provider.environmentId === undefined,
        ));
}

/**
 * Whether work sent here would start: the test agents' model lists apply.
 * A provider that is switched off, missing, signed out or failing its own
 * check is not a pick, however well its models score. Neither is one whose
 * last run ended signed out or out of credit with nothing working since:
 * its own check cannot see that, so it still reads ready.
 */
export function canRunWork(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated" &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    rememberedAccountFailure(provider) === null
  );
}

function catalogLabel(provider: ServerProvider | undefined, model: string): string | undefined {
  return provider?.models.find((entry) => entry.slug === model)?.name;
}

/** One route per model the usage window saw. `scale` prorates a partial day. */
export function routesFromUsage(
  models: ReadonlyArray<ModelTotals>,
  providers: ReadonlyArray<ModelPickProvider>,
  providerLabel: (provider: UsageProviderKind) => string,
  scale = 1,
  includeUnavailable = false,
): PickRoute[] {
  return models.flatMap((model): PickRoute[] => {
    const provider = providerOf(providers, model.instanceId, model.environmentId);
    // Used last week, but it could not take work today.
    if (!includeUnavailable && provider !== undefined && !canRunWork(provider)) return [];
    const label = catalogLabel(provider, model.model);
    return [
      {
        model: model.model,
        ...(label === undefined ? {} : { modelLabel: label }),
        ...(model.instanceId === undefined ? {} : { instanceId: model.instanceId }),
        ...(model.environmentId === undefined ? {} : { environmentId: model.environmentId }),
        ...(provider?.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
        routeLabel: model.displayName ?? provider?.displayName ?? providerLabel(model.provider),
        provider: `usage:${model.provider}`,
        local: false,
        costUsd: model.costUsd * scale,
        unpricedTokens: model.unpricedTokens * scale,
        // A few unpriced records barely move the figure; many make it a floor, not a price.
        costKnown: !isModelCostUnknown(model) && model.unpricedRecords <= model.records * 0.05,
        tokens:
          scale === 1
            ? model.tokens
            : {
                uncachedInputTokens: Math.round(model.tokens.uncachedInputTokens * scale),
                cachedInputTokens: Math.round(model.tokens.cachedInputTokens * scale),
                cacheCreationTokens: Math.round(model.tokens.cacheCreationTokens * scale),
                outputTokens: Math.round(model.tokens.outputTokens * scale),
                reasoningTokens: Math.round(model.tokens.reasoningTokens * scale),
              },
        responses: model.records,
        ...(model.timing ? { timing: model.timing } : {}),
        ...(model.fastTiming ? { fastTiming: model.fastTiming } : {}),
      },
    ];
  });
}

export function gradesFromSnapshots(
  snapshots: ReadonlyArray<ModelPickSnapshot | null>,
): PickGrades[] {
  return snapshots.flatMap((snapshot) =>
    (snapshot?.models ?? []).flatMap((model) =>
      model.stats === undefined
        ? []
        : [
            {
              instanceId: model.instanceId,
              ...(snapshot?.environmentId === undefined
                ? {}
                : { environmentId: snapshot.environmentId }),
              model: model.model,
              runs: model.stats.runs,
              rated: model.stats.rated,
              ...(model.stats.average === undefined ? {} : { average: model.stats.average }),
              completed: model.stats.completed,
            },
          ],
    ),
  );
}

/**
 * Routes for models a lead graded but the usage window did not see, so their
 * grades still count. They carry no tokens and no cost.
 */
export function routesFromGrades(
  grades: ReadonlyArray<PickGrades>,
  providers: ReadonlyArray<ModelPickProvider>,
  existing: ReadonlyArray<PickRoute>,
): PickRoute[] {
  const seen = new Set(existing.map(routeKey));
  const routes: PickRoute[] = [];
  for (const grade of grades) {
    const provider = providerOf(providers, grade.instanceId, grade.environmentId);
    const key = routeKey({
      ...grade,
      ...(provider?.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
    });
    // An instance that is gone, switched off or signed out is not somewhere to send work.
    if (seen.has(key) || provider === undefined || !canRunWork(provider)) continue;
    seen.add(key);
    const label = catalogLabel(provider, grade.model);
    routes.push({
      model: grade.model,
      ...(label === undefined ? {} : { modelLabel: label }),
      instanceId: grade.instanceId,
      ...(provider.environmentId === undefined ? {} : { environmentId: provider.environmentId }),
      ...(provider.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
      routeLabel: provider.displayName ?? provider.instanceId,
      provider: `driver:${provider.driver}`,
      local: false,
      costUsd: 0,
      costKnown: false,
      tokens: NO_TOKENS,
      responses: 0,
    });
  }
  return routes;
}

// A catalog this long is an aggregator's: listing a model there does not mean the user can run it.
const MAX_CATALOG_MODELS = 60;

interface NewerVersion {
  readonly slug: string;
  readonly name: string;
  /** The older ids of the line this one replaces on that account, newest first. */
  readonly replaces: ReadonlyArray<string>;
}

const versionKey = (
  environmentId: string | undefined,
  instanceId: string | undefined,
  model: string,
) => `${environmentId ?? ""}\0${instanceId ?? ""}\0${model}`;

/**
 * The newer version each account offers of an older model it also lists
 * (GPT-6.1 Sol beside GPT-6.2 Sol), keyed by machine, account and the older id.
 * A pick never names the older one: the newer takes over its usage and grades,
 * and until someone publishes figures for it, the older one's stand in.
 *
 * Aggregators are left out (listing a model there does not mean the user can
 * run it), and so is the user's own hardware, where a newer model is another
 * size and speed.
 */
export function newerVersions(
  providers: ReadonlyArray<ModelPickProvider>,
): ReadonlyMap<string, NewerVersion> {
  const newer = new Map<string, NewerVersion>();
  for (const provider of providers) {
    if (!canRunWork(provider) || provider.models.length > MAX_CATALOG_MODELS) continue;
    const models = provider.models;
    const replaced = supersededModelVersions(
      models.map((model) => model.slug),
      // A user's custom id or an already-retired release never retires a current one.
      new Set(
        models
          .filter(
            (model) =>
              model.isCustom !== true && !model.isLegacy && model.unavailableReason === undefined,
          )
          .map((model) => model.slug),
      ),
    );
    const olderBySlug = new Map<string, string[]>();
    for (const [older, slug] of replaced) {
      olderBySlug.set(slug, [...(olderBySlug.get(slug) ?? []), older]);
    }
    for (const [slug, older] of olderBySlug) {
      // Among the versions it replaces, the one no other replaces is the latest.
      const earlier = supersededModelVersions(older);
      const replaces = [
        ...older.filter((id) => !earlier.has(id)),
        ...older.filter((id) => earlier.has(id)),
      ];
      const name = models.find((model) => model.slug === slug)?.name ?? slug;
      for (const id of older) {
        newer.set(versionKey(provider.environmentId, provider.instanceId, id), {
          slug,
          name,
          replaces,
        });
      }
    }
  }
  return newer;
}

/** A route or a grade on an older version counts for the newer one its account offers. */
function onNewerVersion<
  T extends {
    readonly model: string;
    readonly instanceId?: string;
    readonly environmentId?: string;
  },
>(newer: ReadonlyMap<string, NewerVersion>, item: T): T {
  // Like `providerOf`: a provider list without machines stands for every machine.
  const version =
    newer.get(versionKey(item.environmentId, item.instanceId, item.model)) ??
    newer.get(versionKey(undefined, item.instanceId, item.model));
  if (version === undefined) return item;
  return "routeLabel" in item
    ? { ...item, model: version.slug, modelLabel: version.name }
    : { ...item, model: version.slug };
}

/** "GPT-6.1 Sol" for the next version, going by how the two are named in the catalog. */
function labelLike(row: PickBenchmarkModel, olderName: string, name: string): string {
  const version = /\d+(?:\.\d+)*/;
  const from = version.exec(olderName)?.[0];
  const to = version.exec(name)?.[0];
  return from !== undefined && to !== undefined && row.label.split(from).length === 2
    ? row.label.replace(from, to)
    : name;
}

/**
 * The table with a row for each newer version nobody has measured yet: the
 * figures of the latest version before it that the table knows.
 */
export function withStandInFigures(
  benchmarks: PickBenchmarks,
  providers: ReadonlyArray<ModelPickProvider>,
  newer: ReadonlyMap<string, NewerVersion>,
): PickBenchmarks {
  const added = new Map<string, PickBenchmarkModel>();
  for (const [key, version] of newer) {
    if (added.has(version.slug) || benchmarkFor(version.slug, benchmarks) !== undefined) continue;
    for (const older of version.replaces) {
      const row = benchmarkFor(older, benchmarks);
      if (row === undefined) continue;
      const [environmentId, instanceId] = key.split("\0");
      const olderName =
        providers
          .find(
            (provider) =>
              provider.instanceId === instanceId &&
              (provider.environmentId ?? "") === environmentId,
          )
          ?.models.find((model) => model.slug === older)?.name ?? older;
      const { aliases: _aliases, ...figures } = row;
      added.set(version.slug, {
        ...figures,
        id: version.slug,
        label: labelLike(row, olderName, version.name),
        figuresFrom: row.label,
      });
      break;
    }
  }
  return added.size === 0
    ? benchmarks
    : { ...benchmarks, models: [...benchmarks.models, ...added.values()] };
}

/**
 * Routes for models the user can pick in a connected provider but has not run
 * lately, so the picks cover what is available and not only what is habit.
 * Only models with public scores are added: without usage or grades, a model
 * nobody has measured could not win anything.
 */
export function routesFromCatalog(
  providers: ReadonlyArray<ModelPickProvider>,
  existing: ReadonlyArray<PickRoute>,
  benchmarks: PickBenchmarks,
  newer: ReadonlyMap<string, NewerVersion> = new Map(),
): PickRoute[] {
  const seen = new Set(existing.map(routeKey));
  const routes: Array<PickRoute & { readonly order: number }> = [];
  for (const provider of providers) {
    if (!canRunWork(provider) || provider.models.length > MAX_CATALOG_MODELS) continue;
    const subscription =
      isGoogleSubscription(provider) || (provider.usageLimits?.windows.length ?? 0) > 0;
    for (const model of provider.models) {
      const key = routeKey({
        instanceId: provider.instanceId,
        accountKey: accountOf(provider),
        model: model.slug,
      });
      if (
        seen.has(key) ||
        model.isLegacy ||
        newer.has(versionKey(provider.environmentId, provider.instanceId, model.slug)) ||
        benchmarkFor(model.slug, benchmarks) === undefined
      ) {
        continue;
      }
      seen.add(key);
      routes.push({
        model: model.slug,
        modelLabel: model.name,
        instanceId: provider.instanceId,
        ...(provider.environmentId === undefined ? {} : { environmentId: provider.environmentId }),
        ...(provider.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
        routeLabel: provider.displayName ?? provider.instanceId,
        provider: `driver:${provider.driver}`,
        local: false,
        costUsd: 0,
        costKnown: false,
        tokens: NO_TOKENS,
        responses: 0,
        // A model offered several ways is shown the way it is most likely run.
        order: subscription ? 0 : 1,
      });
    }
  }
  return routes.sort((a, b) => a.order - b.order).map(({ order: _order, ...route }) => route);
}

export function limitsFromProviders(
  providers: ReadonlyArray<ModelPickProvider>,
): PickLimitWindow[] {
  const freshest = new Map<string, ModelPickProvider>();
  for (const provider of identifyProviders(providers)) {
    if (!provider.enabled || !provider.usageLimits || provider.usageLimits.unavailable) continue;
    const key = accountOf(provider);
    const previous = freshest.get(key);
    if (
      !previous ||
      Date.parse(provider.usageLimits.checkedAt) > Date.parse(previous.usageLimits!.checkedAt)
    ) {
      freshest.set(key, provider);
    }
  }
  return [...freshest.values()].flatMap((provider) =>
    !provider.enabled || provider.usageLimits?.unavailable
      ? []
      : (provider.usageLimits?.windows ?? []).map((window) => {
          const resetsAtMs =
            window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
          return {
            instanceId: provider.instanceId,
            ...(provider.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
            id: window.id,
            label: window.label,
            kind: window.kind,
            usedPercent: window.usedPercent,
            ...(window.modelIds === undefined ? {} : { modelIds: window.modelIds }),
            ...(window.providerIds === undefined ? {} : { providerIds: window.providerIds }),
            ...(window.limited === undefined ? {} : { limited: window.limited }),
            ...(Number.isNaN(resetsAtMs) ? {} : { resetsAtMs }),
            ...(window.windowDurationMins === undefined
              ? {}
              : { durationMs: window.windowDurationMins * 60_000 }),
            ...(window.dailyRise === undefined ? {} : { dailyRise: window.dailyRise }),
          };
        }),
  );
}

/** One provider instance the user may be paying a flat price for. */
export interface PlanPriceRow {
  readonly instanceId: string;
  readonly accountKey?: string;
  /** The provider as the app names it. */
  readonly label: string;
  /** The plan as the provider names it, else the provider. */
  readonly planLabel: string;
  /** The public list price a month, when the plan is one the table knows. */
  readonly listUsd?: number;
  /** What the user said they pay a month. */
  readonly yourUsd?: number;
  readonly includedMonthlyUsd?: number;
  readonly providerIds?: readonly string[];
  readonly hasLimits: boolean;
}

/**
 * Every cloud provider instance with what is known about its plan: plans the
 * app can price first, then the rest for the user to price if they pay for them.
 */
export function planPriceRows(
  providers: ReadonlyArray<ModelPickProvider>,
  prices: Readonly<Record<string, number>> = {},
): PlanPriceRow[] {
  const seen = new Set<string>();
  const rows: PlanPriceRow[] = [];
  // Two accounts of one provider are often the same plan ("Claude Ultra" twice): each
  // goes by its own name, so the rows tell them apart and neither reads as the spare.
  const hasSibling = (provider: ModelPickProvider) => {
    const shared = provider.continuation?.groupKey;
    return (
      shared !== undefined &&
      providers.some(
        (other) =>
          other.enabled &&
          other.instanceId !== provider.instanceId &&
          other.environmentId === provider.environmentId &&
          other.driver === provider.driver &&
          other.continuation?.groupKey === shared,
      )
    );
  };
  for (const first of providers) {
    if (!first.enabled || seen.has(accountOf(first))) continue;
    seen.add(accountOf(first));
    // The list can span machines, and the same account signed in on a second machine
    // stands alone there under its plan's name: the machine with both accounts names it.
    const provider =
      providers.find(
        (other) => other.enabled && accountOf(other) === accountOf(first) && hasSibling(other),
      ) ?? first;
    const windows = provider.usageLimits?.unavailable ? [] : (provider.usageLimits?.windows ?? []);
    const label = provider.displayName ?? provider.instanceId;
    const known = knownPlan({
      driver: provider.driver,
      ...(provider.auth?.label === undefined ? {} : { planLabel: provider.auth.label }),
      displayName: label,
      windowIds: windows.map((window) => window.id),
    });
    const yours = prices[provider.instanceId];
    rows.push({
      instanceId: provider.instanceId,
      ...(provider.accountKey === undefined ? {} : { accountKey: provider.accountKey }),
      label,
      planLabel: hasSibling(provider)
        ? label
        : (known?.label ?? planName(provider.auth?.label) ?? label),
      ...(known ? { listUsd: known.monthlyUsd } : {}),
      ...(yours === undefined ? {} : { yourUsd: yours }),
      ...(known?.includedMonthlyUsd === undefined
        ? {}
        : { includedMonthlyUsd: known.includedMonthlyUsd }),
      ...(known?.providerIds ? { providerIds: known.providerIds } : {}),
      hasLimits: windows.length > 0,
    });
  }
  const rank = (row: PlanPriceRow) =>
    row.yourUsd !== undefined || row.listUsd !== undefined ? 0 : row.hasLimits ? 1 : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The plans with a price: the user's own figure where they gave one, else the list price. */
export function plansFromProviders(
  providers: ReadonlyArray<ModelPickProvider>,
  prices: Readonly<Record<string, number>> = {},
): PickPlan[] {
  return planPriceRows(providers, prices).flatMap((row) => {
    const monthlyUsd = row.yourUsd ?? row.listUsd;
    return monthlyUsd === undefined
      ? []
      : [
          {
            instanceId: row.instanceId,
            ...(row.accountKey === undefined ? {} : { accountKey: row.accountKey }),
            label: row.planLabel,
            monthlyUsd,
            ...(row.providerIds ? { providerIds: row.providerIds } : {}),
            ...(row.includedMonthlyUsd === undefined
              ? {}
              : { includedMonthlyUsd: row.includedMonthlyUsd }),
          },
        ];
  });
}

/** The calendar day an instant falls on in a zone, and how much of that day is still ahead. */
export function dayAt(
  instantMs: number,
  timeZone: string,
): { readonly day: string; readonly remainingShare: number } {
  const instant = new Date(instantMs);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
  // "07:05"; some engines write midnight as 24:00.
  const [hours = "0", minutes = "0"] = clock.split(":");
  const elapsed = ((Number(hours) % 24) * 60 + Number(minutes)) / (24 * 60);
  return { day, remainingShare: Math.min(1, Math.max(0, 1 - elapsed)) };
}

/** The reasoning effort a saved model selection runs at, when it names one. */
export function effortOfSelection(
  selection:
    | { readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> }
    | null
    | undefined,
): string | undefined {
  const option = selection?.options?.find(
    (entry) => isReasoningOptionId(entry.id) || /effort/i.test(entry.id),
  );
  return typeof option?.value === "string" ? option.value : undefined;
}

export interface BuildModelPicksInput {
  /** Every environment that answered for the evidence window. */
  readonly environments: ReadonlyArray<EnvironmentUsage>;
  readonly contractVersion: number;
  readonly hiddenProviders?: ReadonlySet<UsageProviderKind>;
  readonly providers: ReadonlyArray<ModelPickProvider>;
  readonly snapshots: ReadonlyArray<ModelPickSnapshot | null>;
  readonly table: ModelBenchmarkTable;
  /** The effort the user runs models at; benchmarks are read at it. */
  readonly effort: string | undefined;
  /** What the user pays a month for a provider instance's plan, by instance id. */
  readonly planPrices?: Readonly<Record<string, number>>;
  readonly providerLabel: (provider: UsageProviderKind) => string;
  /** The zone the usage window's days are counted in. */
  readonly timeZone: string;
  /**
   * Whether a machine shares new sessions between the user's accounts of one
   * provider. Absent: it does, as the setting is on unless turned off.
   */
  readonly balanceAccounts?: (environmentId: string | undefined) => boolean;
  readonly now: number;
}

/** The server keeps 28 days of a limit's daily rise; the usage shown beside it covers 30. */
const RISE_EVIDENCE_DAYS = 28;

/** The picks for one screen: joins usage, grades, catalogs and limits, then ranks. */
export function buildModelPicks(input: BuildModelPicksInput): ModelPicks {
  const providers = identifyProviders(input.providers);
  const shown = (bucket: UsageBucket) => !input.hiddenProviders?.has(bucket.provider);
  const modelsWhere = (keep: (bucket: UsageBucket) => boolean) =>
    mergeUsage(input.environments, input.contractVersion, (bucket) => shown(bucket) && keep(bucket))
      .models;
  const newer = newerVersions(providers);
  const benchmarks = withStandInFigures(
    benchmarksAtEffort(input.table, input.effort),
    providers,
    newer,
  );
  // A version the user can run a newer one of is not a pick anywhere, a gateway included.
  const retired = new Set<string>();
  for (const version of newer.values()) {
    for (const older of version.replaces) retired.add(normalizeModelId(older));
  }
  const current = (routes: ReadonlyArray<PickRoute>) =>
    routes
      .map((route) => onNewerVersion(newer, route))
      .filter((route) => route.local || !retired.has(normalizeModelId(route.model)));
  const usage = routesFromUsage(
    modelsWhere(() => true),
    providers,
    input.providerLabel,
    1,
    true,
  );
  const usageRoutes = current(
    usage.filter((route) => {
      const provider = providerOf(providers, route.instanceId, route.environmentId);
      return !provider || canRunWork(provider);
    }),
  );
  const grades = gradesFromSnapshots(input.snapshots).map((grade) => onNewerVersion(newer, grade));
  const ranRoutes = [...usageRoutes, ...current(routesFromGrades(grades, providers, usageRoutes))];
  const sinceCache = new Map<number, ReadonlyArray<PickRoute>>();
  const sinceDayCache = new Map<string, ReadonlyArray<PickRoute>>();
  // A rise from before the usage on hand would be percent with no work to set against it.
  const oldestDay = dayAt(input.now - RISE_EVIDENCE_DAYS * 24 * 60 * 60 * 1000, input.timeZone).day;
  const canStart = (instanceId: string | undefined, model: string, environmentId?: string) => {
    const provider = providerOf(providers, instanceId, environmentId);
    if (!provider) return true;
    if (!canRunWork(provider)) return false;
    const catalog = provider.models;
    // Antigravity still accepts effort-suffixed IDs for families in its current catalog.
    const family =
      provider.driver === "antigravity"
        ? model.replace(/-(?:low|medium|high|xhigh|max)$/, "")
        : model;
    const offered =
      catalog.find((entry) => entry.slug === model || entry.aliases?.includes(model)) ??
      catalog.find((entry) => entry.slug === family);
    return (
      !provider.hiddenModels?.includes(model) &&
      !provider.hiddenModels?.includes(family) &&
      !offered?.isLegacy &&
      offered?.unavailableReason === undefined &&
      (provider.driver !== "antigravity" || offered !== undefined)
    );
  };
  return pickBestModels({
    usage,
    canStart: (route) => canStart(route.instanceId, route.model, route.environmentId),
    routes: [...ranRoutes, ...current(routesFromCatalog(providers, ranRoutes, benchmarks, newer))],
    grades,
    limits: limitsFromProviders(providers).map((window) =>
      window.dailyRise === undefined
        ? window
        : { ...window, dailyRise: window.dailyRise.filter((entry) => entry.day >= oldestDay) },
    ),
    plans: plansFromProviders(providers, input.planPrices),
    subscriptionAccounts: new Set(providers.filter(isGoogleSubscription).map(accountOf)),
    benchmarks,
    usageSince: (sinceMs) => {
      const cached = sinceCache.get(sinceMs);
      if (cached) return cached;
      const { day, remainingShare } = dayAt(sinceMs, input.timeZone);
      const routes = current([
        ...routesFromUsage(
          modelsWhere((bucket) => bucket.day > day),
          providers,
          input.providerLabel,
        ),
        // The limit window opened partway through this day: count the rest of it.
        ...routesFromUsage(
          modelsWhere((bucket) => bucket.day === day),
          providers,
          input.providerLabel,
          remainingShare,
        ),
      ]);
      sinceCache.set(sinceMs, routes);
      return routes;
    },
    usageSinceDay: (day) => {
      const cached = sinceDayCache.get(day);
      if (cached) return cached;
      const routes = current(
        routesFromUsage(
          modelsWhere((bucket) => bucket.day >= day),
          providers,
          input.providerLabel,
        ),
      );
      sinceDayCache.set(day, routes);
      return routes;
    },
    startsOn: (route) => {
      if (route.instanceId === undefined || input.balanceAccounts?.(route.environmentId) !== true) {
        return undefined;
      }
      const machine = providerOf(providers, route.instanceId, route.environmentId)?.environmentId;
      const accounts = providers.filter((provider) => provider.environmentId === machine);
      const pick = pickAccountForNewSession(
        accounts,
        { instanceId: route.instanceId, model: route.model },
        {
          now: input.now,
          accepts: (provider) => canStart(provider.instanceId, route.model, machine),
        },
      );
      return pick === null || pick.instanceId === route.instanceId
        ? undefined
        : {
            instanceId: pick.instanceId,
            ...(machine === undefined ? {} : { environmentId: machine }),
          };
    },
    now: input.now,
  });
}

const TITLES: Record<ModelPickKind, string> = {
  quality: "Quality",
  value: "Value",
  speed: "Speed",
  frugal: "Budget pick",
};

const RULES: Record<ModelPickKind, string> = {
  quality:
    "Public benchmark scores at the effort you run, each scaled against the best model and weighted by how much it tells models apart, blended with your subagent ratings. The headline shows one benchmark. Percentages compare the overall quality score. Completed unflagged work can contribute an automatic rating. Exact ties share a rank and are listed by model ID.",
  value: `Quality per estimated dollar of benchmark work, among models scoring at least ${PICK_QUALITY_FLOOR.value * 100}% of the leader. We allocate a monthly fee by each model’s share of that account’s priced usage over 30 days, including input and cache costs. For models with no priced output on the account we use another route’s token mix or list rates. Without a plan rate, the API rate is a proxy. Missing benchmark task sizes use the median.`,
  speed: `Estimated generation time on benchmark tasks among models scoring at least ${PICK_QUALITY_FLOOR.speed * 100}% of the leader. Task output tokens divided by tokens per second. Uses your response timings when available, otherwise public throughput. Models without a comparable task size follow by throughput.`,
  frugal: `Among models costing at most $${NEAR_FREE_PER_M_OUTPUT_USD.toFixed(2)} per million output tokens including context, highest quality wins, then throughput. Outside that budget we rank by estimated cost for comparable work. Local inference has no API fee. Plans below 10% remaining are skipped.`,
};

export const pickTitle = (kind: ModelPickKind) => TITLES[kind];
export const pickRule = (kind: ModelPickKind) => RULES[kind];

function money(value: number): string {
  if (value >= 10_000) return `$${formatTokens(value)}`;
  if (value >= 100) return `$${formatCount(value)}`;
  // A plan can bring a model down to fractions of a cent; two decimals would say $0.00.
  if (value > 0 && value < 0.095) return value < 0.001 ? "under $0.001" : `$${value.toFixed(3)}`;
  return formatUsd(value);
}

function times(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
}

function percentOfLeader(value: number): string {
  if (value < 100 && value > 99.9) return ">99.9%";
  return `${Number(value.toFixed(value >= 99.5 ? 1 : 0))}%`;
}

/** Exact quality ties share competition rank even when the first is featured. */
export function pickRank(pick: ModelPick, index: number): number {
  const candidate = pick.ranked[index];
  return pick.kind === "quality" && candidate?.quality !== undefined
    ? pick.ranked.findIndex((other) => other.quality === candidate.quality) + 1
    : index + 1;
}

function qualityShare(candidate: PickCandidate): string {
  return candidate.quality === undefined
    ? "No benchmark or grades for it yet"
    : `${percentOfLeader(candidate.quality)} of the top quality score`;
}

function smallPercent(value: number): string {
  if (value < 0.1) return "under 0.1%";
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function gradeLine(candidate: PickCandidate): string | null {
  const grade = candidate.grade;
  if (!grade) return null;
  return `${grade.average.toFixed(1)}/10 across ${formatCount(grade.rated)} rated ${grade.rated === 1 ? "task" : "tasks"}`;
}

export interface PickHeadline {
  readonly text: string;
  readonly unit: string;
}

export interface PickDescription {
  readonly title: string;
  readonly headline: PickHeadline;
  readonly lines: ReadonlyArray<string>;
  /** The mode to run the model in, when the pick depends on one. */
  readonly badge: string | null;
}

function fixed(text: string, unit: string): PickHeadline {
  return { text, unit };
}

function costText(candidate: PickCandidate): string {
  if (candidate.billing === "local") return "No API fee";
  const cost = realCostPerMOutput(candidate);
  if (cost === undefined) return "";
  if (candidate.billing === "subscription" && candidate.paidPerMOutput === undefined)
    return `API ${money(cost)}/M`;
  return cost === 0 ? "free" : `${money(cost)}/M`;
}

/** A ranked model's short value, for the runner-up list. */
export function pickValueText(
  kind: ModelPickKind,
  candidate: PickCandidate,
  pick?: ModelPick,
): string {
  switch (kind) {
    case "quality": {
      // Against the best, since the winner's own figure is one benchmark's score.
      const best = pick?.winner?.quality;
      return best !== undefined && best > 0 && candidate.quality !== undefined
        ? candidate.quality === best && candidate.key !== pick?.winner?.key
          ? "Tied"
          : percentOfLeader((candidate.quality / best) * 100)
        : `${Math.round(candidate.quality ?? 0)}`;
    }
    case "value":
      if (pick?.winner && Number.isFinite(valueScore(pick.winner))) {
        const proxy =
          candidate.billing === "subscription" && candidate.paidPerMOutput === undefined;
        return `${percentOfLeader(pickBarShare(kind, candidate, pick) * 100)} of top value${proxy ? " (API)" : ""}`;
      }
      return costText(candidate);
    case "frugal":
      return costText(candidate);
    case "speed": {
      const speed = candidate.speed;
      if (!speed) return "";
      const fastest = pick?.winner?.speed?.secondsPerTask;
      const figure =
        speed.secondsPerTask !== undefined && fastest !== undefined && fastest > 0
          ? `${times(speed.secondsPerTask / fastest)} as long`
          : `${Math.round(speed.tokensPerSecond)} tok/s`;
      return speed.fast ? `${figure} · Fast` : figure;
    }
  }
}

/** A 0–1 bar length comparing a ranked model with the winner. */
export function pickBarShare(
  kind: ModelPickKind,
  candidate: PickCandidate,
  pick: ModelPick,
): number {
  const winner = pick.winner;
  if (!winner) return 0;
  const ratio = (value: number | undefined, top: number | undefined) =>
    value === undefined || top === undefined || top <= 0 ? 0 : Math.min(1, value / top);
  switch (kind) {
    case "quality":
      return ratio(candidate.quality, winner.quality);
    case "speed":
      return candidate.speed?.secondsPerTask !== undefined &&
        winner.speed?.secondsPerTask !== undefined
        ? ratio(winner.speed.secondsPerTask, candidate.speed.secondsPerTask)
        : ratio(candidate.speed?.tokensPerSecond, winner.speed?.tokensPerSecond);
    case "value": {
      const top = valueScore(winner);
      return Number.isFinite(top)
        ? ratio(valueScore(candidate), top)
        : valueScore(candidate) === Infinity
          ? ratio(candidate.quality, winner.quality)
          : 0;
    }
    case "frugal": {
      if (realCostPerMOutput(winner)! <= NEAR_FREE_PER_M_OUTPUT_USD) {
        return realCostPerMOutput(candidate)! <= NEAR_FREE_PER_M_OUTPUT_USD
          ? ratio(candidate.quality, winner.quality)
          : 0;
      }
      const cost = realCostForSameWork(candidate) ?? 0;
      const least = realCostForSameWork(winner) ?? 0;
      if (cost === 0) return 1;
      return least === 0 ? 0.06 : ratio(least, cost);
    }
  }
}

/** What a million output tokens cost is counted in, for under the figure. */
function costUnit(candidate: PickCandidate): string {
  if (candidate.paidPerMOutput !== undefined && candidate.plan) {
    return `per 1M output tokens including input · estimated from ${candidate.plan.label}’s 30-day usage`;
  }
  return candidate.billing === "subscription"
    ? "per 1M output tokens with their context, at API prices"
    : "per 1M output tokens with their context, pay per token";
}

function costHeadline(candidate: PickCandidate): PickHeadline {
  if (candidate.billing === "local") return fixed("No API fee", "runs on your own GPU");
  const cost = realCostPerMOutput(candidate) ?? 0;
  if (cost === 0 && (candidate.billing !== "subscription" || candidate.paidPerMOutput === 0)) {
    return fixed(
      "Free",
      candidate.plan ? `on your ${candidate.plan.label} plan` : "no token charge",
    );
  }
  return fixed(money(cost), costUnit(candidate));
}

/** How the figure relates to the API price, or why it is the API price. */
function costBasisLine(candidate: PickCandidate): string | null {
  if (candidate.billing === "local") return null;
  const api = candidate.costPerMOutput;
  const plan = candidate.plan;
  if (plan && candidate.paidPerMOutput !== undefined) {
    if (plan.monthlyUsd === 0 || api === undefined) return null;
    const mix =
      candidate.costBasis === "list"
        ? "list rates at your token mix"
        : candidate.costBasis === "other"
          ? "usage on another route"
          : "recorded usage";
    return `${money(plan.monthlyUsd)}/month allocated over ${money(plan.usedUsd)} of priced work. Model rate from ${mix}.`;
  }
  if (candidate.billing === "subscription") {
    return plan
      ? "No priced usage on this plan to allocate its fee"
      : "Plan price or coverage unknown. Showing the API estimate.";
  }
  return candidate.costBasis === "yours"
    ? "Priced from your own usage at API rates"
    : candidate.costBasis === "other"
      ? "Estimated from usage on another route"
      : candidate.costBasis === "list"
        ? "List price at your usual mix of tokens"
        : null;
}

/** "about 1.0%", or "under 0.1%" where "about" would not read. */
function aboutPercent(percent: number): string {
  const text = smallPercent(percent);
  return text.startsWith("under") ? text : `about ${text}`;
}

function limitLine(candidate: PickCandidate): string | null {
  const limit = candidate.limit;
  if (!limit) return null;
  const left = `${Math.round(limit.remainingPercent)}% left`;
  return limit.percentPerMOutput === undefined
    ? `${limit.label} limit: ${left}`
    : `1M output tokens uses ${aboutPercent(limit.percentPerMOutput)} of your ${limit.label} limit, ${left}`;
}

/** How much less the same work costs than on the best model: tokens spent count, not only their price. */
function cheaperThan(winner: PickCandidate, best: PickCandidate | null): string {
  if (!best || best.key === winner.key) return "";
  const sameWork = winner.tokensPerTask !== undefined && best.tokensPerTask !== undefined;
  const price = sameWork ? realCostForSameWork : realCostPerMOutput;
  const cost = price(winner);
  const bestCost = price(best);
  if (cost === undefined || cost <= 0 || bestCost === undefined || bestCost <= cost) return "";
  return ` · ${best.label} costs ~${times(bestCost / cost)} as much ${sameWork ? "on benchmark tasks" : "per output token including input"}`;
}

export function describePick(pick: ModelPick, picks: ModelPicks): PickDescription | null {
  const winner = pick.winner;
  if (!winner) return null;
  const best = picks.picks.quality.winner;
  const lines: string[] = [];
  let headline: PickHeadline;
  let badge: string | null = null;

  switch (pick.kind) {
    case "quality": {
      const benchmark = winner.headlineBenchmark;
      const grade = winner.grade;
      if (benchmark) {
        headline = fixed(
          String(benchmark.value),
          benchmark.effort === undefined || benchmark.effort === "default"
            ? benchmark.label
            : `${benchmark.label}, ${benchmark.effort} effort`,
        );
        const gradeText = gradeLine(winner);
        if (gradeText) lines.push(gradeText);
      } else if (grade) {
        headline = fixed(grade.average.toFixed(1), "/ 10 across rated tasks");
        lines.push(
          `${formatCount(grade.rated)} rated ${grade.rated === 1 ? "task" : "tasks"}, no public benchmark yet`,
        );
      } else {
        headline = fixed("Top", "of your models");
      }
      const second = pick.ranked[1];
      if (second?.quality !== undefined) {
        lines.push(
          second.quality === winner.quality
            ? `${second.label} ties for the top quality score`
            : `${second.label} has ${percentOfLeader(second.quality)} of the top quality score`,
        );
      }
      break;
    }
    case "value": {
      headline = costHeadline(winner);
      lines.push(
        winner.tokensPerTask === undefined
          ? "Highest quality per estimated dollar, assuming typical task length"
          : "Highest quality per estimated dollar of benchmark work",
        `${qualityShare(winner)}${cheaperThan(winner, best)}`,
      );
      const basis = costBasisLine(winner);
      if (basis) lines.push(basis);
      const limit = limitLine(winner);
      if (limit) lines.push(limit);
      break;
    }
    case "speed": {
      const speed = winner.speed!;
      const reference = best && best.key !== winner.key ? best.speed : undefined;
      const sooner =
        speed.secondsPerTask !== undefined && reference?.secondsPerTask !== undefined
          ? reference.secondsPerTask / speed.secondsPerTask
          : undefined;
      const rate = `${formatCount(speed.tokensPerSecond)} tokens a second`;
      if (sooner !== undefined) {
        headline = fixed(
          times(sooner),
          `as fast as ${best!.label} at generating benchmark output (estimated)`,
        );
        lines.push(
          speed.basis === "yours"
            ? `${rate}, timed over ${formatCount(speed.responses ?? 0)} of your responses`
            : `${rate} in public benchmarks`,
        );
        if (speed.tokensPerTask !== undefined && reference?.tokensPerTask !== undefined) {
          const share = speed.tokensPerTask / reference.tokensPerTask;
          lines.push(
            share < 0.95
              ? `Spends ${Math.max(1, Math.round(share * 100))}% of the tokens ${best!.label} does on the same benchmark tasks`
              : share > 1.05
                ? `Spends ${times(share)} the tokens ${best!.label} does on the same benchmark tasks`
                : `Spends about as many tokens as ${best!.label} on the same benchmark tasks`,
          );
        }
        lines.push(qualityShare(winner));
      } else {
        headline = fixed(formatCount(speed.tokensPerSecond), "output tokens per second");
        lines.push(
          speed.basis === "yours"
            ? `Timed over ${formatCount(speed.responses ?? 0)} of your responses`
            : "Public benchmark throughput",
        );
        lines.push(
          reference
            ? `${times(speed.tokensPerSecond / reference.tokensPerSecond)} ${best!.label}'s speed, at ${qualityShare(winner)}`
            : qualityShare(winner),
        );
      }
      if (speed.fast) badge = "Fast mode";
      break;
    }
    case "frugal": {
      headline = costHeadline(winner);
      lines.push(
        realCostPerMOutput(winner)! <= NEAR_FREE_PER_M_OUTPUT_USD
          ? `Highest quality at $${NEAR_FREE_PER_M_OUTPUT_USD.toFixed(2)}/M or less`
          : "Lowest estimated cost for comparable work",
        `${qualityShare(winner)}${winner.quality === undefined ? "" : cheaperThan(winner, best)}`,
      );
      const limit = limitLine(winner);
      const basis = costBasisLine(winner);
      if (limit) lines.push(limit);
      if (basis) lines.push(basis);
      else if (winner.billing === "metered") lines.push("Pay per token, no limit to run out of");
      break;
    }
  }

  if (!winner.used) lines.push("You have not run it lately");
  if (winner.figuresFrom !== undefined) {
    lines.push(`Scored as ${winner.figuresFrom} until its own figures are published`);
  }
  return { title: TITLES[pick.kind], headline, lines, badge };
}

export interface PlanDescription {
  readonly instanceId: string;
  readonly label: string;
  /** `$200/mo`, or null when no price is known for it. */
  readonly price: string | null;
  /** Work done through it in the evidence window, at API prices. */
  readonly used: string;
  /** That work against a month's price. */
  readonly usedTimes: string | null;
  /** What its limits allow in a month, when that can be told. */
  readonly capacity: string | null;
  /** 0–1: how much of what the plan allows was used. Null when unknown. */
  readonly usedShare: number | null;
}

/** Priced work in dollars; work on models without an API price in tokens, never as $0. */
function usedText(plan: PlanSummary): string {
  const unpriced = plan.unpricedTokens ?? 0;
  const window = `in ${PICKS_WINDOW_DAYS} days`;
  if (unpriced > 0 && plan.usedUsd <= 0) {
    return `${formatTokens(unpriced)} tokens ${window} (its models have no API price)`;
  }
  if (plan.scopedUsage && plan.usedUsd === 0)
    return `No priced usage identified this plan ${window}`;
  const work = plan.scopedUsage ? "identified plan work" : "work";
  const priced = `${money(plan.usedUsd)} of ${work} at API prices ${window}`;
  return unpriced > 0
    ? `${priced}, plus ${formatTokens(unpriced)} tokens with no API price`
    : priced;
}

/** One plan in words: what it costs, what it bought, and what it could buy. */
export function describePlan(plan: PlanSummary): PlanDescription {
  const price = plan.monthlyUsd;
  const capacity = plan.monthlyCapacityUsd;
  const multiple = (value: number) =>
    price !== undefined && price > 0 ? ` (${times(value / price)} its price)` : "";
  return {
    instanceId: plan.instanceId,
    label: plan.label,
    price:
      price === undefined
        ? null
        : price === 0
          ? "Free"
          : `${Number.isInteger(price) ? `$${formatCount(price)}` : money(price)}/mo`,
    used: usedText(plan),
    usedTimes:
      price !== undefined && price > 0 && plan.usedUsd > 0
        ? `${times(plan.usedUsd / price)} its price`
        : null,
    capacity:
      capacity === undefined
        ? null
        : plan.capacityBasis === "stated"
          ? `includes ${money(capacity)} a month${multiple(capacity)}`
          : plan.capacityBasis === "used"
            ? // Limits get reset and raised, so the work done can pass what they now add up to.
              plan.limitMonthlyUsd === undefined
              ? null
              : `more than its limits now allow in a month (about ${money(plan.limitMonthlyUsd)})`
            : `room for about ${money(capacity)} a month${multiple(capacity)}`,
    usedShare:
      capacity === undefined || capacity <= 0 ? null : Math.min(1, plan.usedUsd / capacity),
  };
}

/** One line on what the picks rest on, for under the section title. */
export function picksBasis(picks: ModelPicks, benchmarks: ModelBenchmarkTable): string {
  const models = picks.candidates.filter((candidate) => candidate.quality !== undefined).length;
  const parts = [
    `${formatCount(models)} ${models === 1 ? "model" : "models"} scored`,
    `your last ${PICKS_WINDOW_DAYS} days of usage`,
  ];
  if (picks.gradedRuns > 0) {
    parts.push(
      `${formatCount(picks.gradedRuns)} rated subagent ${picks.gradedRuns === 1 ? "task" : "tasks"}`,
    );
  }
  if (benchmarks.models.length > 0) {
    const [year, month, day] = benchmarks.asOf.split("-").map(Number);
    const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    const shown = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    // The publisher's terms ask for a visible credit beside figures read from its API.
    parts.push(
      benchmarks.liveSource === undefined
        ? `public benchmarks from ${shown}`
        : `${benchmarks.liveSource} figures from ${shown}`,
    );
  }
  return parts.join(" · ");
}

/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  activeProviderFailure,
  isProviderAvailable,
  rememberedAccountFailure,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerSettings,
  type ServerProviderUsageWindow,
  type StorageUsageSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export const unavailableGoogleLimits = (checkedAt: string): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported", message: "Google doesn't share limits with apps yet" },
});

export const isGoogleSubscription = (provider: Pick<ServerProvider, "driver" | "auth">) =>
  provider.driver === "antigravity" &&
  (provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business");

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const MISTRAL_USAGE_URL = "https://admin.mistral.ai/subscription";

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a third quota.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok and Composer use this first. Auto can use either pool.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here.",
  },
] as const;

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers?: readonly ServerProvider[] | undefined;
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      /** Shown by Usage › Limits after the plan cards; see storageUsage. */
      readonly storage?: StorageUsageSnapshot | undefined;
      readonly settings?:
        | {
            readonly balanceAccounts?: boolean | undefined;
            readonly providerModelPreferences?:
              | ServerSettings["providerModelPreferences"]
              | undefined;
          }
        | undefined;
    } | null;
  }
>;

/** One destination per service, even when several accounts or environments use it. */
export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      const isMistral = external?.url === MISTRAL_USAGE_URL;
      if (external && (provider.auth.status === "authenticated" || isMistral)) {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: isMistral ? undefined : provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

/** Prefer the reported email; use an identical credential when no email is available. */
function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

/**
 * Keys each report by the account it draws on. One email can belong to
 * several workspaces, each with its own quota, so a report that names its
 * workspace is keyed by it too. One that does not (a hub, an older server)
 * joins the only workspace known for its email, and gets no key when there
 * are several, since it cannot say which one it read. Pass every enabled
 * login, read or not, so an unreadable workspace still counts as one.
 */
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

/** Subscription identities across snapshots; unknown identities stay local to their source. */
export function providerAccountKeyResolver(providers: readonly ServerProvider[]) {
  const resolve = accountKeyResolver(providers.map(nativeReport));
  return (provider: ServerProvider) => resolve(nativeReport(provider));
}

/**
 * One subscription account as the pooled views see it, whichever way it was
 * reported. Matching emails or credentials across environments name one
 * account, unless they name different workspaces. Its quota is one bucket, so
 * counting it twice would misstate what is left.
 */
export interface LimitAccount {
  readonly key: string;
  /** Every native environment:instance key that reports this subscription. */
  readonly sourceKeys: readonly string[];
  readonly driver: ServerProvider["driver"];
  /** The instance's configured name, which is not sensitive; null for hub accounts. */
  readonly displayName: string | null;
  /** The provider's own instance, as opposed to one the user added beside it. */
  readonly primary: boolean;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  /** The instance's own mark, so a registry agent (Devin, Mistral Vibe) is not drawn as the generic one. */
  readonly iconUrl?: string;
  /** Set on the instance to stay out of compact rows; unset where only a hub reports it. */
  readonly hideRing?: boolean;
  /** Environments the account is signed in on; empty when only a hub reports it. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  /** The hub that reported it, when no environment has it natively. */
  readonly sourceLabel: string | null;
  /** Where the displayed reset credit can be redeemed. */
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
  /** Set when the server serves a saved reading during or after a probe. */
  readonly asOf?: number;
  /**
   * Set on a plan with no numbers at all: its one-line notice. Only with `withNotices`; such
   * a plan sits in its pool's `unread`, never in its windows.
   */
  readonly notice?: string;
}

/**
 * Saved windows keep the date they were read, including while a new probe is pending.
 */
export function olderReadingAt(limits: ServerProviderUsageLimits): number | null {
  if (
    (!limits.refreshing && limits.unavailable?.reason !== "probeFailed") ||
    limits.windows.length === 0
  )
    return null;
  const at = Date.parse(limits.checkedAt);
  return Number.isFinite(at) ? at : null;
}

const asOfClock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const asOfDay = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const asOfDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * `5:23 PM`, or `Nov 19, 5:23 PM` from another day, in the device's time zone and on a 12-hour
 * clock. `clock` lets a client use its own time setting.
 */
export function formatReadTime(
  at: number,
  now: number,
  clock: (ms: number) => string = (ms) => asOfClock.format(ms),
): string {
  const day = asOfDay.format(at) === asOfDay.format(now) ? "" : `${asOfDate.format(at)}, `;
  return `${day}${clock(at)}`;
}

/** `as of 5:23 PM`: the quiet note beside an older reading. */
export function formatAsOf(at: number, now: number, clock?: (ms: number) => string): string {
  return `as of ${formatReadTime(at, now, clock)}`;
}

/** Live, then older, then none: a plan's best reading wins wherever else it is reported. */
function readingRank(account: LimitAccount): number {
  return account.notice !== undefined ? 0 : account.asOf !== undefined ? 1 : 2;
}

/**
 * Every account with usable windows across the connected environments, one
 * entry per distinct account. The freshest reads supply windows and credits,
 * a live read before an older one; native instances supply names and
 * environment labels. `withNotices` adds the instances with no numbers at
 * all, each with its `notice`, so a view can still list every plan.
 */
export function collectLimitAccounts(
  presentations: LimitPresentations,
  options?: { readonly withNotices?: boolean },
): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Redeeming through a hub also clears the routing cooldown that hub holds
    // for the account. Redeeming natively against the same subscription resets
    // it upstream but leaves the hub refusing to route to the account until
    // its own cooldown expires, so a hub target wins the redemption outright
    // while the displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher =
      readingRank(next) > readingRank(previous) ||
      (readingRank(next) === readingRank(previous) &&
        Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt));
    // Two instances on one machine sharing an account still name it once.
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    // Credits and their redemption target travel together. A failed credit
    // probe must not erase a successful read from another environment.
    const creditSource = creditSources.get(key);
    const { asOf: _asOf, notice: _notice, ...known } = previous;
    accounts.set(key, {
      ...known,
      ...(winner.asOf === undefined ? {} : { asOf: winner.asOf }),
      ...(winner.notice === undefined ? {} : { notice: winner.notice }),
      sourceKeys: [...new Set([...previous.sourceKeys, ...next.sourceKeys])],
      displayName: previous.displayName ?? next.displayName,
      primary: previous.primary || next.primary,
      plan: previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      ...((previous.iconUrl ?? next.iconUrl) === undefined
        ? {}
        : { iconUrl: previous.iconUrl ?? next.iconUrl }),
      // Hidden only when every instance that has a say hides it.
      ...((previous.hideRing ?? next.hideRing) === undefined
        ? {}
        : { hideRing: (previous.hideRing ?? true) && (next.hideRing ?? true) }),
      environments,
      // A hub only names the account when no environment has it natively.
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    const providers = presentation.serverConfig?.providers ?? [];
    const primaryByDriver = new Map<ServerProvider["driver"], ProviderInstanceId>();
    for (const provider of providers) {
      if (
        !primaryByDriver.has(provider.driver) ||
        String(provider.instanceId) === String(provider.driver)
      ) {
        primaryByDriver.set(provider.driver, provider.instanceId);
      }
    }
    for (const provider of providersWithLimits(providers)) {
      if (!provider.usageLimits) continue;
      // A signed-out plan says so: its last numbers no longer stand for anything it can run.
      const signedOut = rememberedAccountFailure(provider);
      const signInNotice = signedOut?.kind === "authentication_error" ? signedOut.message : null;
      const asOf = signInNotice === null ? olderReadingAt(provider.usageLimits) : null;
      const notice = signInNotice ?? (asOf === null ? limitsNotice(provider.usageLimits) : null);
      // Google subscriptions keep a plan row explaining why they have no windows.
      if (
        notice !== null &&
        (options?.withNotices !== true ||
          (provider.driver !== "antigravity" &&
            provider.usageLimits.requiredApiKey === undefined &&
            provider.usageLimits.unavailable?.reason === "unsupported"))
      ) {
        continue;
      }
      merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
        key: `${environmentId}:${provider.instanceId}`,
        sourceKeys: [`${environmentId}:${provider.instanceId}`],
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        primary: provider.instanceId === primaryByDriver.get(provider.driver),
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        ...(provider.iconUrl ? { iconUrl: provider.iconUrl } : {}),
        hideRing: provider.hideLimitRing === true,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
        ...(asOf === null ? {} : { asOf }),
        ...(notice === null ? {} : { notice }),
      });
    }
  }
  // Every hub account, including those a native instance also knows: the hub
  // may hold a fresher read of the same subscription, and the merge above
  // keeps the redeem target consistent with whichever snapshot wins.
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits);
        if (
          notice !== null &&
          !(
            options?.withNotices &&
            account.driver === "antigravity" &&
            account.usageLimits.unavailable?.reason === "unsupported"
          )
        )
          continue;
        const key = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolveKey(account) ?? key, {
          key,
          sourceKeys: [],
          driver: account.driver,
          displayName: account.email ? null : account.id.replace(/\.json$/i, ""),
          primary: false,
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
          ...(notice === null ? {} : { notice }),
        });
      }
    }
  }
  return [...accounts.values()];
}

/**
 * What the pooled views cannot draw as a bar or a plan row: a hub that failed
 * to read, a run that just hit a limit. A plan whose probe read nothing is a
 * row of its own (`collectLimitAccounts` with `withNotices`). The environment
 * is named only when more than one is connected.
 */
export function collectLimitNotices(
  presentations: LimitPresentations,
  /** With the time, a run that just hit a provider's limit is named too. */
  now?: number,
): readonly string[] {
  // "OpenCode on Workstation", not "Workstation · OpenCode": that could also name an instance.
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${subject} on ${environmentLabel}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    // A run's limit error is fresher than the last probe, and API-key providers have no bars.
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (now === undefined || !provider.enabled) continue;
      const limitHit = activeProviderFailure(provider, now);
      if (limitHit?.kind !== "usage_limit") continue;
      const name = provider.displayName?.trim() || String(provider.driver);
      const left = limitHit.resetAt ? Date.parse(limitHit.resetAt) - now : Number.NaN;
      const reset = !Number.isFinite(left)
        ? ""
        : left < MINUTE
          ? "; resets momentarily"
          : `; resets in ${formatDuration(left)}`;
      notices.push(`${label(environmentLabel, name)}: A run hit the usage limit${reset}.`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.credits) {
        const credits = source.credits;
        notices.push(
          `${label(environmentLabel, source.label)}: $${credits.dollars.toFixed(2)} left · ${credits.defaultHours.toFixed(1)} default-hours / ${credits.largeHours.toFixed(1)} large-hours${credits.low ? " · Low credits" : ""}`,
        );
      } else if (source.accounts.length === 0) {
        notices.push(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
    }
  }
  return notices;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
}

/**
 * One window id across every account that reports it: the pooled share left,
 * pace against the clock, and the resets in the order they will land, each
 * with the share of the pool it hands back.
 */
export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Fixed account positions across rows; a null window leaves a gap. */
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: ServerProviderUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly limited?: boolean;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    /** Points of the pool the reset restores: the member's used share over the member count. */
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  /** One per section: the driver, or the driver with the added instance's account. */
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  /** The added instance's name; null where the provider's own name says it. */
  readonly label: string | null;
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
  /** Plans in this section with no numbers to show, each with its `notice`. */
  readonly unread: readonly LimitAccount[];
}

/** The mark for a limits section or ring: the first plan in it that has its own. */
export function limitPoolIconUrl(pool: Pick<LimitPool, "accounts" | "unread">): string | undefined {
  for (const account of pool.accounts) if (account.iconUrl) return account.iconUrl;
  for (const account of pool.unread) if (account.iconUrl) return account.iconUrl;
  return undefined;
}

/** Order provider limit windows for display (pairing Antigravity buckets, showing Cursor's two pools). */
export function displayProviderUsageWindows<
  W extends Pick<ServerProviderUsageWindow, "id" | "kind">,
>(driver: ServerProvider["driver"], windows: readonly W[]): readonly W[] {
  if (driver === "antigravity") {
    // Keep each model group's five-hour and weekly buckets next to one another.
    return [...windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (driver !== "cursor") return windows;
  const hasAuto = windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

/** Show Cursor's two usable pools instead of a combined percentage when both are available. */
export function displayLimitWindows(pool: LimitPool) {
  return displayProviderUsageWindows(pool.driver, pool.windows);
}

export function monthlyBudgetDetail(window: LimitPoolWindow): string | undefined {
  const budget = window.members[0]?.window.includedBudget;
  if (
    !budget ||
    !window.members.every(
      ({ window }) =>
        window.includedBudget?.amount === budget.amount &&
        window.includedBudget.currency === budget.currency,
    )
  ) {
    return undefined;
  }
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: budget.currency,
    minimumFractionDigits: 0,
  }).format(budget.amount);
  return `of ${amount} a month`;
}

export function mistralPayAsYouGoNotices(windows: readonly LimitPoolWindow[]): string[] {
  return windows.flatMap((window) =>
    window.members.some(({ window }) => window.payAsYouGo === true)
      ? [
          `${window.label} pay-as-you-go is on at Mistral: ${window.label} use past the included amount is billed.`,
        ]
      : [],
  );
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * Accounts grouped by driver, each with its windows pooled by kind and id.
 * Window ids are stable per provider, so a hub row and a native row for the
 * same window land in the same pool; the kind is part of the key because
 * Codex's `primary` is a position, not a duration (five hours on paid plans,
 * a month on Free/Go), and a monthly allowance must not average into a
 * five-hour pool. Pools order by kind, then first appearance.
 *
 * Accounts and columns share the session reset order, soonest first. When
 * no account reports a session window, use the first window by kind instead.
 * Missing reset times sort last, with account names and keys breaking ties.
 * Each window's reset list still follows its own clock.
 */
/**
 * The clock to read limits against: the caller's `now`, or the freshest
 * reading if that is newer. A view that holds `now` still between refreshes
 * still receives live readings during turns, and measuring those against an
 * older clock overstates the time left before each reset.
 */
export function limitsClock(accounts: readonly LimitAccount[], now: number): number {
  let clock = now;
  for (const account of accounts) {
    const checkedAt = Date.parse(account.limits.checkedAt);
    if (checkedAt > clock) clock = checkedAt;
  }
  return clock;
}

/**
 * How much each plan ran lately, keyed like an account's `sourceKeys`
 * (`environment:instance`): the `recentUse` hours its server reports.
 */
export function recentUseBySource(presentations: LimitPresentations): Map<string, number> {
  const use = new Map<string, number>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (provider.recentUse !== undefined && provider.recentUse > 0) {
        use.set(`${environmentId}:${provider.instanceId}`, provider.recentUse);
      }
    }
  }
  return use;
}

/**
 * With `use` (hours per source key, from {@link recentUseBySource}), providers
 * order by their plans' combined use and each provider's plans by their own,
 * most used first. Without it, or on a tie, providers keep the order they are
 * listed in and a provider's own plan leads its added ones.
 */
export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
  use?: ReadonlyMap<string, number>,
): readonly LimitPool[] {
  // Native accounts are independent choices. At most one shares the driver's
  // section with hub accounts; several machines can each call a different
  // account primary without making those subscriptions one allowance.
  const primaryByDriver = new Map<ServerProvider["driver"], LimitAccount>();
  for (const account of accounts) {
    if (account.environments.length === 0) continue;
    const previous = primaryByDriver.get(account.driver);
    if (!previous || (!previous.primary && account.primary)) {
      primaryByDriver.set(account.driver, account);
    }
  }
  const byDriver = new Map<ServerProvider["driver"], Map<string, LimitAccount[]>>();
  for (const account of accounts) {
    const added =
      account.environments.length > 0 && primaryByDriver.get(account.driver) !== account;
    const key = added ? `${account.driver}:${account.key}` : String(account.driver);
    const groups = byDriver.get(account.driver) ?? new Map<string, LimitAccount[]>();
    byDriver.set(account.driver, groups.set(key, [...(groups.get(key) ?? []), account]));
  }
  const useOf = (members: readonly LimitAccount[]): number => {
    if (use === undefined || use.size === 0) return 0;
    let total = 0;
    for (const key of new Set(members.flatMap((member) => member.sourceKeys))) {
      total += use.get(key) ?? 0;
    }
    return total;
  };
  // Sorting is stable: providers with equal use keep the order they are listed in.
  const drivers = [...byDriver]
    .map(([driver, groups]) => ({ driver, groups, use: useOf([...groups.values()].flat()) }))
    .sort((left, right) => right.use - left.use);
  return drivers.flatMap(({ driver, groups }) =>
    [...groups]
      // Most single sections use the driver's name. A registry agent or a Google plan
      // with only a notice needs its own name in the heading. Sibling plans always use theirs.
      .map(([key, members]) =>
        groups.size === 1
          ? {
              key: String(driver),
              members,
              label:
                driver === "acpRegistry" ||
                (driver === "antigravity" &&
                  members.length === 1 &&
                  members[0]?.notice !== undefined)
                  ? ((members.find((member) => member.primary) ?? members[0])?.displayName ?? null)
                  : null,
            }
          : key === String(driver)
            ? {
                key,
                members,
                label:
                  (members.find((member) => member.primary) ?? members[0])?.displayName ?? null,
              }
            : { key, members, label: accountLabel(members[0]!) },
      )
      .sort(
        (left, right) =>
          useOf(right.members) - useOf(left.members) ||
          // The provider's own section leads, named or not.
          Number(left.key !== String(driver)) - Number(right.key !== String(driver)) ||
          (left.label ?? "").localeCompare(right.label ?? "") ||
          left.key.localeCompare(right.key),
      )
      .map(({ key, label, members }): LimitPool => {
        const orderWindow = members
          .flatMap((account) => account.limits.windows)
          .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
        const orderReset = (account: LimitAccount) => {
          const window = account.limits.windows.find(
            (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
          );
          return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
        };
        const sorted = [...members].sort(
          (left, right) =>
            Number(right.primary) - Number(left.primary) ||
            orderReset(left) - orderReset(right) ||
            accountSortName(left).localeCompare(accountSortName(right)) ||
            left.key.localeCompare(right.key),
        );
        const read = sorted.filter((account) => account.notice === undefined);
        return {
          key,
          driver,
          label,
          accounts: read,
          windows: poolWindows(read, now),
          unread: sorted.filter((account) => account.notice !== undefined),
        };
      }),
  );
}

/** What an added instance is called: the name the user gave it, else its email. */
function accountLabel(account: LimitAccount): string {
  return account.displayName ?? account.email ?? "Added account";
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

/**
 * Codex ids are slots, not allowances: a weekly-only plan reports its weekly
 * window as `primary`, other plans as `secondary`. Its windows pool by kind;
 * other drivers' ids name distinct allowances.
 */
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      const pooled = poolKey(account.driver, window);
      // An account with two windows of one kind keeps the second apart.
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    // Pooled Codex slots take the pool's own key, so the id stays the same
    // whichever account sorts first.
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    const usedPercent =
      members.reduce(
        (sum, m) => sum + (isUsageWindowLimited(m.window) ? 100 : m.window.usedPercent),
        0,
      ) / members.length;
    const limited = members.every((member) => isUsageWindowLimited(member.window));
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict. An older
    // reading's spend stopped at the time it was read, so it has no say.
    const timed = members.flatMap((m) => {
      if (m.account.asOf !== undefined) return [];
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.window.usedPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent,
      limited,
      remainingPercent: remainingPercent({ usedPercent, limited }),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

type UsageWindowAmount = Pick<ServerProviderUsageWindow, "usedPercent" | "limited">;

/** An explicit provider verdict takes precedence over its rounded percentage. */
export function isUsageWindowLimited(window: UsageWindowAmount): boolean {
  return window.limited ?? window.usedPercent >= 100;
}

export function isUsageWindowAlmostOut(window: UsageWindowAmount): boolean {
  return !isUsageWindowLimited(window) && window.usedPercent > 99;
}

/** Quota left, keeping fractional headroom rather than rounding it to zero. */
export function remainingPercent(window: UsageWindowAmount): number {
  if (isUsageWindowLimited(window)) return 0;
  const remaining = 100 - Math.max(0, Math.min(100, window.usedPercent));
  return remaining < 1 ? remaining : Math.round(remaining);
}

/** Rounded labels, without claiming an allowed window has no quota left. */
export function remainingPercentLabel(window: UsageWindowAmount): string {
  return isUsageWindowAlmostOut(window) ? "<1%" : `${remainingPercent(window)}%`;
}

export function usedPercentLabel(window: UsageWindowAmount): string {
  return isUsageWindowAlmostOut(window)
    ? "<1% left"
    : `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}% used`;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. Spending evenly leaves the same share of quota as
 * there is time left in the window; within five points of that counts as on
 * pace, further ahead means the window may run dry first.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

/** Average consumption since this window opened, without rounding the remaining quota. */
export function projectUsageWindow(
  window: ServerProviderUsageWindow,
  now: number,
): { readonly kind: "runsOut"; readonly at: number } | { readonly kind: "lasts" } | null {
  const reset = resetMillis(window);
  const duration =
    window.windowDurationMins ??
    (window.kind === "weekly"
      ? 7 * 24 * 60
      : window.kind === "session"
        ? 5 * 60
        : window.kind === "monthly" && reset !== null
          ? (reset -
              DateTime.toEpochMillis(
                DateTime.subtract(DateTime.makeUnsafe(reset), { months: 1 }),
              )) /
            MINUTE
          : 0);
  if (
    reset === null ||
    reset <= now ||
    duration <= 0 ||
    !Number.isFinite(duration) ||
    !Number.isFinite(now) ||
    !Number.isFinite(window.usedPercent)
  )
    return null;
  const elapsed = now - (reset - duration * MINUTE);
  if (elapsed <= 0) return null;
  if (isUsageWindowLimited(window)) return { kind: "runsOut", at: now };
  const used = Math.max(0, Math.min(100, window.usedPercent));
  if (used === 0) return { kind: "lasts" };
  const at = now + ((100 - used) * elapsed) / used;
  return at < reset ? { kind: "runsOut", at } : { kind: "lasts" };
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A countdown or the status of the reported reset time. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "reset time passed";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

/** Limit commands are served by T3 from the same snapshots as Usage → Limits. */
export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

/** Handled by the client without sending a turn; anything with arguments stays an ordinary prompt. */
export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

/**
 * Whether Limits has anything to say about this driver. A source that failed to
 * read keeps no accounts, so its error counts for every driver rather than
 * disappearing until the next successful refresh.
 */
export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

/**
 * The drivers a set of sources would offer the command to, where a source that
 * failed to read counts for every driver. Two snapshots with the same coverage
 * need no catalog republish, however much their quotas moved.
 */
export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

/** A point-in-time report; never refreshes or guesses which pooled account serves a turn. */
export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const native = providersWithLimits(providers).filter(
    (provider) => provider.driver === selected.driver,
  );
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  const nativeAccounts = new Set(
    native.flatMap((provider) => {
      const key = resolveKey(nativeReport(provider));
      return key && provider.usageLimits?.windows.length && !provider.usageLimits.unavailable
        ? [key]
        : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const provider of native) {
    if (!provider.usageLimits) continue;
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    // Two independent decisions. Which balance to *display* follows whichever
    // snapshot is fresher. Which path to *redeem through* always prefers the
    // hub, because only the hub path clears the routing cooldown it holds for
    // that account; redeeming natively against the same account resets the
    // subscription upstream but leaves the hub refusing to route to it until
    // its own cooldown expires. A hub credit id that a fresher native redeem
    // already spent comes back as `alreadyRedeemed`, which still clears the
    // cooldown, so preferring it is safe even when the hub snapshot is stale.
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!provider.usageLimits.resetCredits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(provider.usageLimits.checkedAt));
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: showHubCredits
        ? { ...provider.usageLimits, resetCredits: hubCredits.account.usageLimits.resetCredits }
        : provider.usageLimits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccounts.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.id}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    // A source that failed to read has no accounts left to match on, so its
    // error is reported to every provider rather than silently dropped.
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}

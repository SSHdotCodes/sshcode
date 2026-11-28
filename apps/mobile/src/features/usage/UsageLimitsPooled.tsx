import { getProviderClient } from "../../lib/providerClients";
import { useEnvironmentDisplayLabels } from "../../state/environment-labels";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type StorageUsageSnapshot } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  formatAsOf,
  isUsageWindowAlmostOut,
  mistralPayAsYouGoNotices,
  monthlyBudgetDetail,
  usedPercentLabel,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPoolMember,
  formatResetsIn,
  recentUseBySource,
  limitPoolIconUrl,
} from "@t3tools/shared/usageLimits";
import { newSessionAccountKeys } from "@t3tools/shared/accountBalance";
import { collectStorage, describeStorage } from "@t3tools/shared/storageUsage";
import {
  borrowedPoolForecast,
  describeLimitForecast,
  headlineWindows,
  poolForecast,
} from "@t3tools/shared/usageLimitForecast";
import { Fragment, type ReactNode, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { environmentPresentations } from "../../state/presentation";
import {
  LIMIT_TONE_COLOR,
  limitTone,
  resetsInLabel,
  summarizeProviderLimits,
  type ProviderLimits,
} from "./limitsGlance";
import { ResetCredits } from "./UsageLimitsSection";
import { useVisibleMinuteClock } from "../threads/use-visible-second-clock";

const BUILT_IN_DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  antigravity: "Antigravity",
};
const providerLabel = (driver: string) =>
  BUILT_IN_DRIVER_LABEL[driver] ?? getProviderClient(driver)?.label ?? driver;

/**
 * One provider: its windows as bars of the share used, in the provider's own
 * order, each with when it resets. A row opens the account behind it. A plan
 * that read nothing keeps a row with its notice, so it never just vanishes.
 */
function ProviderLimitsCard({
  pool,
  limits,
  now,
  environmentIds,
  startsNewChats,
}: {
  readonly pool: LimitPool;
  /** Null when no plan in the section has numbers to draw. */
  readonly limits: ProviderLimits | null;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
  /** Of the user's accounts of this provider, the one new chats start on. */
  readonly startsNewChats: boolean;
}) {
  const environmentLabels = useEnvironmentDisplayLabels();
  const navigation = useNavigation();
  const windows = limits?.windows ?? [];
  const accounts = [...pool.accounts, ...pool.unread];
  const plan = accounts.length === 1 ? accounts[0]?.plan : undefined;
  const accountName = (account: LimitPool["accounts"][number]) =>
    account.displayName ??
    `Account ${accounts.findIndex((candidate) => candidate.key === account.key) + 1}`;
  const whereSignedIn = (account: LimitPool["accounts"][number]) =>
    account.environments
      .map((environment) => environmentLabels.get(environment.environmentId) ?? environment.label)
      .join(", ") || account.sourceLabel;
  // Use the same recent-or-average forecast as the web and thread details. A Google plan's
  // headline follows Gemini's limits, not the pool it shares out to Claude and GPT.
  // With one account, its per-window rows would only repeat the bars above them, so the
  // card ends in a single row that opens the account instead.
  const soleAccountWindow =
    pool.accounts.length === 1 && pool.unread.length === 0
      ? windows.find((window) => window.members.length === 1)
      : undefined;
  const soleMember = soleAccountWindow?.members[0];
  const forecastWindows = headlineWindows(pool.driver, windows);
  const forecast = poolForecast(forecastWindows, now);
  const forecastText = forecast ? describeLimitForecast(forecast, now) : null;
  const openAccount = (window: LimitPoolWindow, member: LimitPoolMember) => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsUsageAccount",
        initial: false,
        params: {
          accountKey: member.account.key,
          windowId: window.id,
          windowKind: window.kind,
          environmentIds,
        },
      },
    });
  };
  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={pool.driver} iconUrl={limitPoolIconUrl(pool)} size={18} />
        <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground" numberOfLines={1}>
          {pool.label ?? providerLabel(pool.driver)}
        </Text>
        {startsNewChats ? (
          <Text className="text-xs text-foreground-muted">New chats start here</Text>
        ) : accounts.length > 1 ? (
          <Text className="text-xs text-foreground-muted">{accounts.length} accounts</Text>
        ) : plan ? (
          <Text className="max-w-[60%] text-right text-xs text-foreground-muted">{plan}</Text>
        ) : null}
      </View>
      {mistralPayAsYouGoNotices(windows).map((notice) => (
        <Text key={notice} className="text-sm text-foreground-muted">
          {notice}
        </Text>
      ))}
      {forecast && forecastText ? (
        <View className="gap-0.5">
          <Text
            className={
              forecastText.warn
                ? "text-sm font-t3-medium text-warning-foreground"
                : "text-sm text-foreground-muted"
            }
          >
            {forecast.kind === "runsOut" ? "Heads up. " : ""}
            {forecastText.text}
          </Text>
          {forecastWindows.length > 1 ? (
            <Text className="text-xs text-foreground-muted">
              Based on the {forecast.label} limit
            </Text>
          ) : null}
        </View>
      ) : null}
      {windows.map((window) => {
        const details = pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        const label = details?.label ?? window.label;
        const color = LIMIT_TONE_COLOR[limitTone(window.usedPercent)];
        const resetsIn = resetsInLabel(window, now);
        const description = details?.description ?? monthlyBudgetDetail(window);
        const shared = borrowedPoolForecast(pool.driver, window, now);
        return (
          <View key={`${window.kind}:${window.id}`} className="gap-1.5">
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                {label}
              </Text>
              <Text className="text-sm font-t3-medium tabular-nums text-foreground">
                {usedPercentLabel(window)}
              </Text>
            </View>
            <View className="h-2 overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(window.usedPercent, window.usedPercent > 0 ? 2 : 0)}%`,
                  ...(isUsageWindowAlmostOut(window) ? { maxWidth: "99%" } : {}),
                  backgroundColor: color,
                }}
              />
            </View>
            {resetsIn || description ? (
              <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={2}>
                {[resetsIn, description].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            {shared ? (
              <Text className="text-xs text-warning-foreground">
                {describeLimitForecast(shared, now).text}
              </Text>
            ) : null}
            {(soleMember ? [] : window.members).map((member) => (
              <Pressable
                key={member.account.key}
                accessibilityRole="button"
                accessibilityHint="Show account details"
                onPress={() => openAccount(window, member)}
                className="flex-row items-center gap-2 border-t border-border-subtle py-2 active:opacity-60"
                style={{ minHeight: 44 }}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground">{accountName(member.account)}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {[
                      member.account.plan,
                      whereSignedIn(member.account),
                      formatResetsIn(member.window, now),
                      member.account.asOf === undefined
                        ? null
                        : formatAsOf(member.account.asOf, now),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Text className="text-sm tabular-nums text-foreground-muted">
                  {usedPercentLabel(member.window)}
                </Text>
                <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ))}
          </View>
        );
      })}
      {soleAccountWindow && soleMember ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Show account details"
          onPress={() => openAccount(soleAccountWindow, soleMember)}
          className="flex-row items-center gap-2 border-t border-border-subtle pt-3 active:opacity-60"
          style={{ minHeight: 44 }}
        >
          <View className="shrink-0">
            <Text className="text-sm text-foreground">Account details</Text>
            {soleMember.account.asOf === undefined ? null : (
              <Text className="text-xs text-foreground-muted">
                {formatAsOf(soleMember.account.asOf, now)}
              </Text>
            )}
          </View>
          <Text
            className="min-w-0 flex-1 text-right text-sm text-foreground-muted"
            numberOfLines={1}
          >
            {whereSignedIn(soleMember.account)}
          </Text>
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
      {pool.unread.map((account) => {
        const notice = [
          account.notice,
          account.limits.requiredApiKey
            ? `Add ${account.limits.requiredApiKey} to this provider’s environment variables in web or desktop Settings.`
            : null,
        ]
          .filter(Boolean)
          .join(" ");
        // A card that is only this plan: its header already names it, so just the notice.
        if (pool.accounts.length === 0 && pool.unread.length === 1)
          return (
            <Text key={account.key} className="pb-1 pt-2 text-sm text-foreground-muted">
              {notice}
            </Text>
          );
        const detail = [account.plan, whereSignedIn(account)].filter(Boolean).join(" · ");
        return (
          <View
            key={account.key}
            className="justify-center gap-0.5 border-t border-border-subtle py-2"
            style={{ minHeight: 44 }}
          >
            <Text className="text-sm text-foreground">{accountName(account)}</Text>
            {detail ? <Text className="text-xs text-foreground-muted">{detail}</Text> : null}
            <Text className="text-xs text-foreground-muted">{notice}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** One storage reading in a plan card's frame: share used, trash, and when it was read. */
function StorageCard({
  storage,
  now,
}: {
  readonly storage: StorageUsageSnapshot;
  readonly now: number;
}) {
  const text = describeStorage(storage, now);
  const usedPercent = text.usedShare * 100;
  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="flex-row items-center gap-2">
        <SymbolView name="cloud" size={18} tintColorClassName="accent-icon-muted" />
        <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground" numberOfLines={1}>
          {storage.label}
        </Text>
        <Text className="text-xs text-foreground-muted">Storage</Text>
      </View>
      <View className="gap-1.5">
        <Text className="text-sm tabular-nums text-foreground">{text.used}</Text>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${storage.label}: ${text.used}`}
          className="h-2 overflow-hidden rounded-full bg-subtle"
        >
          <View
            className="h-full rounded-full"
            style={{
              width: `${Math.max(usedPercent, storage.usedBytes > 0 ? 2 : 0)}%`,
              backgroundColor: LIMIT_TONE_COLOR[limitTone(usedPercent)],
            }}
          />
        </View>
        <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={2}>
          {[text.trash, text.checked].filter(Boolean).join(" · ")}
        </Text>
        {storage.error ? (
          <Text className="text-xs text-warning-foreground">
            Could not refresh: {storage.error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  cursorPrompt,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly cursorPrompt?: ReactNode;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  // Most used first: the hours each plan's chats and subagents ran this past week.
  const pools = collectLimitPools(
    collectLimitAccounts(selected, { withNotices: true }),
    now,
    recentUseBySource(selected),
  );
  const summaries = new Map(summarizeProviderLimits(pools).map((entry) => [entry.pool.key, entry]));
  // Every plan keeps its card: with bars, or with only its notice.
  const cards = pools.filter((pool) => summaries.has(pool.key) || pool.unread.length > 0);
  const startsNewChats = newSessionAccountKeys(selected, now);
  const notices = collectLimitNotices(selected, now);
  // A selected machine on its first connection attempt, or connected without
  // its provider snapshot yet, may still report limits: no data and no error
  // yet. A reconnect in backoff has failed already and can retry forever.
  const awaitingProviders = [...selected.values()].some(
    (presentation) =>
      presentation.serverConfig === null &&
      (presentation.connection.phase === "connecting" ||
        presentation.connection.phase === "connected"),
  );
  const externalLinks = collectExternalUsageLinks(selected);
  const storage = collectStorage(selected);
  const cursorPromptAt =
    cards.reduce(
      (last, pool, index) =>
        pool.driver === "codex" || pool.driver === "claudeAgent" ? index : last,
      -1,
    ) + 1;
  return (
    <View className="gap-6">
      {cards.length === 0 &&
      notices.length === 0 &&
      failedLabels.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        awaitingProviders ? (
          <View className="items-center py-12">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : (
          <Text className="py-12 text-center text-base text-foreground-muted">
            {presentations.size === 0
              ? "Connect an environment to see limits."
              : selected.size === 0
                ? "Select an environment to see limits."
                : "No provider on the selected environments reports subscription limits."}
          </Text>
        )
      ) : null}
      {cards.map((pool, index) => (
        <Fragment key={pool.key}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <ProviderLimitsCard
            pool={pool}
            limits={summaries.get(pool.key) ?? null}
            now={now}
            environmentIds={selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds]}
            startsNewChats={[...pool.accounts, ...pool.unread].some((account) =>
              account.sourceKeys.some((key) => startsNewChats.has(key)),
            )}
          />
        </Fragment>
      ))}
      {cursorPromptAt === cards.length ? cursorPrompt : null}
      {storage.map((entry) => (
        <StorageCard key={entry.label} storage={entry} now={now} />
      ))}
      {externalLinks.map((link) => (
        <View key={link.url} className="gap-3 rounded-xl border border-border-subtle p-4">
          <Text className="text-base font-t3-medium text-foreground">{link.label}</Text>
          <Text className="text-xs text-foreground-muted">{link.accounts.join(", ")}</Text>
          {link.message ? (
            <Text className="text-sm text-foreground-muted">{link.message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
          >
            <Text className="text-sm font-t3-medium text-primary">Manage usage</Text>
          </Pressable>
        </View>
      ))}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-t3-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-t3-medium text-warning-foreground">
                {failedLabels.join(", ")} could not refresh limits. Showing the last known values.
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
}>;

/** Resolve the account again so live quota and credit updates reach the open detail screen. */
export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const environmentLabels = useEnvironmentDisplayLabels();
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const { accountKey, windowId, windowKind, environmentIds } = route.params;
  const now = useVisibleMinuteClock();
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.accounts.some((member) => member.key === accountKey))
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const window = pool?.members.find((member) => member.account.key === accountKey)?.window;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <SettingsScreen title="Account">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            This account is no longer reporting limits on the selected environments.
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} iconUrl={account.iconUrl} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ?? providerLabel(account.driver)}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              {/* "Used", like the row this screen was opened from. */}
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {usedPercentLabel(window)}
              </Text>
              {account.asOf === undefined ? null : (
                <Text className="text-sm text-foreground-muted">
                  {account.limits.refreshing ? "Refreshing · reading" : "Reading"}{" "}
                  {formatAsOf(account.asOf, now)}
                </Text>
              )}
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  Resets{" "}
                  {new Date(window.resetsAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              ) : null}
              {reset && reset.at > now && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Restores {reset.restoresPercent}% of the pool
                </Text>
              ) : null}
            </View>
            <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length ? "Signed in" : "Source"}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environmentLabels.get(environment.environmentId) ?? environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">Reset credits</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

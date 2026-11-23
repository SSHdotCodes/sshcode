import type {
  EnvironmentId,
  ThreadId,
  UsageLimitsReport,
  ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { rememberedAccountFailure } from "@t3tools/contracts";
import { providerHealthNotice } from "@t3tools/client-runtime/providerHealth";
import { formatAsOf, olderReadingAt } from "@t3tools/shared/usageLimits";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ResetCredits } from "../usage/UsageLimitsSection";
import { useVisibleMinuteClock } from "./use-visible-second-clock";

import { ThreadChatUsageRows, ThreadLimitRow, type ThreadUsageContext } from "./ThreadUsageRows";

/** The windows a failed probe left from the last reading are dated, so they never pass as live. */
function olderReading(limits: UsageLimitsReport["accounts"][number]["limits"], now: number) {
  const at = olderReadingAt(limits);
  return at === null ? null : (
    <Text className="px-4 pt-1 text-xs text-foreground-muted">Reading {formatAsOf(at, now)}</Text>
  );
}

/**
 * The chat’s usage and limits, docked above the composer. Tap a row for its details.
 */
export function ComposerUsageLimits({
  report,
  provider,
  environmentId,
  threadId,
  context,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly provider?: ServerProvider | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly context?: ThreadUsageContext | null | undefined;
  readonly onClose: () => void;
}) {
  const now = useVisibleMinuteClock();
  const { height } = useWindowDimensions();
  const close = (
    <Pressable
      accessibilityLabel="Dismiss usage limits"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onClose}
      className="-me-1 p-1 active:opacity-60"
    >
      <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
      >
        <ProviderCreditNotice provider={provider} environmentId={environmentId} />
        {report.accounts.map((account, index) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          return (
            <View key={account.id} className="py-2">
              {index === 0 ? <View className="items-end px-4 pb-1">{close}</View> : null}
              {account.limits.windows.map((window) => (
                <ThreadLimitRow
                  key={window.id}
                  window={window}
                  now={now}
                  readAt={olderReadingAt(account.limits)}
                />
              ))}
              {olderReading(account.limits, now)}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  dense
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </View>
          );
        })}
        <View className="pb-2">
          <ThreadChatUsageRows
            environmentId={environmentId}
            threadId={threadId}
            context={context}
          />
        </View>
        {report.accounts.length === 0 ? (
          // Nothing but notices, so the close control needs a row of its own.
          <View className="flex-row items-center gap-3 px-4 pt-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">Usage limits</Text>
            {close}
          </View>
        ) : null}
        {report.notices.map((notice) => (
          <Text
            key={notice}
            className={
              report.accounts.length === 0
                ? "px-4 py-3 text-xs text-foreground-muted"
                : "border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted"
            }
          >
            {notice}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

/** An advisory account warning; a retry can clear it with real model output. */
export function ProviderCreditNotice({
  provider,
  environmentId,
}: {
  readonly provider: ServerProvider | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const clear = useAtomCommand(serverEnvironment.refreshProviders);
  const input = { instanceId: provider?.instanceId, clearOutOfCredit: true };
  const allowed = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(environmentId, input),
  );
  // Out of credit, or signed out in its last run: it stays until a run works or it is cleared.
  const notice =
    provider && rememberedAccountFailure(provider)
      ? providerHealthNotice(provider, Date.now())
      : null;
  if (!notice) return null;
  return (
    <View className="px-4 py-2">
      <Text className="text-xs text-warning-foreground">
        {notice.outOfCredit ? notice.message : `${notice.title}: ${notice.message}`}
      </Text>
      {allowed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear account warning"
          onPress={() => {
            void clear({ environmentId, input });
          }}
          className="min-h-11 justify-center active:opacity-60"
        >
          <Text className="text-xs text-foreground-muted">Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

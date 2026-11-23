import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ThreadId,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  formatCount,
  formatTokens,
  formatUsageRunOut,
  threadUsageRows,
} from "@t3tools/shared/usageFormat";
import {
  formatAsOf,
  formatDuration,
  paceOf,
  remainingPercentLabel,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { describeLimitForecast, usageWindowForecast } from "@t3tools/shared/usageLimitForecast";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

// Matches the phone's existing message timestamp formatter and device preference.
export interface ThreadUsageContext {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const clock = (ms: number) => clockFormatter.format(new Date(ms));

export function UsageRow({
  label,
  value,
  fill = null,
  warning = false,
  details,
}: {
  readonly label: string;
  readonly value: string;
  readonly fill?: number | null;
  readonly warning?: boolean;
  readonly details: readonly string[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="h-6 flex-row items-center gap-3 px-4"
      >
        <Text className="text-xs text-foreground-muted">{label}</Text>
        <View className="min-w-6 flex-1">
          {fill !== null ? (
            <View className="h-[3px] overflow-hidden rounded-full bg-subtle">
              <View
                className={warning ? "h-full bg-warning" : "h-full bg-foreground"}
                style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
              />
            </View>
          ) : null}
        </View>
        <Text
          className={
            warning
              ? "text-xs font-t3-medium tabular-nums text-warning-foreground"
              : "text-xs font-t3-medium tabular-nums text-foreground-muted"
          }
        >
          {value}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-0.5 px-4 pb-2">
          {details.map((line) => (
            <Text key={line} className="text-xs tabular-nums text-foreground-muted">
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ThreadLimitRow({
  window,
  now,
  readAt = null,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  /** Set for an older reading: its spend stopped then, so no pace or forecast is drawn. */
  readonly readAt?: number | null;
}) {
  const projection = readAt === null ? usageWindowForecast(window, now) : null;
  const runOut = projection?.kind === "runsOut" ? formatUsageRunOut(projection.at, clock) : null;
  const forecast = projection ? describeLimitForecast(projection, now, clock).text : null;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const pace = readAt === null ? paceOf(window, now) : null;
  return (
    <>
      <UsageRow
        label={window.label}
        value={`${remainingPercentLabel(window)}`}
        fill={remainingPercent(window)}
        warning={remainingPercent(window) <= 20}
        details={[
          `${window.label}: ${remainingPercentLabel(window)} left`,
          ...(resetsAt > now
            ? [
                `Resets in ${formatDuration(resetsAt - now)} · ${formatUsageRunOut(resetsAt, clock)}`,
              ]
            : []),
          ...(pace ? [{ ahead: "Ahead of pace", on: "On pace", under: "Under pace" }[pace]] : []),
          ...(forecast ? [forecast] : []),
          ...(readAt === null ? [] : [`Reading ${formatAsOf(readAt, now)}`]),
        ]}
      />
      {runOut ? <UsageRow label="Runs out" value={runOut} warning details={[forecast!]} /> : null}
    </>
  );
}

export function ThreadChatUsageRows({
  environmentId,
  threadId,
  context,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly context?: ThreadUsageContext | null | undefined;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const result = useEnvironmentQuery(
    canRead
      ? serverEnvironment.threadUsage({
          environmentId,
          input: { threadId, timeZone },
        })
      : null,
  );
  const rows = result.data ? threadUsageRows(result.data, threadId, clock) : [];
  return (
    <>
      {context ? (
        <UsageRow
          label="Context"
          value={`${formatTokens(context.usedTokens)}${context.maxTokens ? ` / ${formatTokens(context.maxTokens)}` : ""}`}
          fill={context.maxTokens ? (context.usedTokens / context.maxTokens) * 100 : null}
          details={[
            `${formatCount(context.usedTokens)}${context.maxTokens ? ` of ${formatCount(context.maxTokens)}` : ""} tokens`,
          ]}
        />
      ) : null}
      {rows.map((row) => (
        <UsageRow key={row.label} {...row} />
      ))}
    </>
  );
}

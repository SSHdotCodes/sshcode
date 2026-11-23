import type {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { rememberedAccountFailure } from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
  remainingPercentLabel,
} from "@t3tools/shared/usageLimits";
import {
  describeLimitForecast,
  LIMIT_WARNING_MIN_USED_PERCENT,
  usageWindowForecast,
} from "@t3tools/shared/usageLimitForecast";
import { useAtomValue } from "@effect/atom-react";
import { providerHealthNotice } from "@t3tools/client-runtime/providerHealth";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatClockTime, formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { formatUsageRunOut, threadUsageRows } from "@t3tools/shared/usageFormat";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
  environmentId,
}: Omit<ThreadDetailsUsageInput, "contextWindow"> & {
  readonly environmentId: EnvironmentId | null;
}) {
  const clear = useAtomCommand(serverEnvironment.refreshProviders);
  const canClear = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(environmentId, {
      instanceId: providerInstanceId ?? undefined,
      clearOutOfCredit: true,
    }),
  );
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  // Out of credit, or signed out in its last run: it stays until a run works or it is cleared.
  const health =
    provider && rememberedAccountFailure(provider) ? providerHealthNotice(provider, now) : null;
  if (!limits && !health) return null;
  const notice = limits ? limitsNotice(limits) : null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {health ? (
          <div className="col-span-3 px-2.5 py-1 text-warning-foreground">
            <span>
              {health.outOfCredit ? health.message : `${health.title}: ${health.message}`}
            </span>
            <div>
              {environmentId && providerInstanceId && canClear ? (
                <InlineButton
                  onClick={() => {
                    void clear({
                      environmentId,
                      input: { instanceId: providerInstanceId, clearOutOfCredit: true },
                    });
                  }}
                >
                  Clear
                </InlineButton>
              ) : null}
            </div>
          </div>
        ) : null}
        {notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits?.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                  tokens
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(null, threshold)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const room = `${remainingPercentLabel(window)} left`;
  const pace = paceOf(window, now);
  const projection = usageWindowForecast(window, now);
  const runsOut =
    projection?.kind === "runsOut"
      ? formatUsageRunOut(projection.at, (ms) => formatClockTime(ms, timestampFormat))
      : null;
  const forecast = projection
    ? describeLimitForecast(projection, now, (ms) => formatClockTime(ms, timestampFormat)).text
    : null;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <>
      <UsageRow
        label={window.label}
        fill={left}
        tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
        // "left" is spelled out: toasts and the Usage page count the same window as used.
        value={room}
        ariaValue={room}
        tooltip={
          <>
            <span className="text-foreground">
              {window.label}: {room}
            </span>
            {window.resetsAt && resetsAt > now ? (
              <span className="text-muted-foreground">
                Resets in {formatDuration(resetsAt - now)} ·{" "}
                {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
              </span>
            ) : null}
            {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
            {forecast ? <span className="text-muted-foreground">{forecast}</span> : null}
          </>
        }
      />
      {runsOut ? (
        <UsageRow
          label="Runs out"
          fill={null}
          // A forecast with most of the limit left is information; it warns once the toast would.
          tone={100 - left >= LIMIT_WARNING_MIN_USED_PERCENT ? "warning" : null}
          value={runsOut}
          tooltip={<span>{forecast}</span>}
        />
      ) : null}
    </>
  );
}

/** One request is mounted only while the details card is open. */
export function ThreadDetailsChatUsage({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const result = useEnvironmentQuery(
    canRead
      ? serverEnvironment.threadUsage({
          environmentId,
          input: { threadId, timeZone },
        })
      : null,
  );
  const usage = result.data;
  if (!usage) return null;
  const rows = threadUsageRows(usage, threadId, (ms) => formatClockTime(ms, timestampFormat));
  if (rows.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-chat-usage-heading"
      title="Chat usage"
      showHeading={false}
      separated={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {rows.map((row) => (
          <UsageRow
            key={row.label}
            label={row.label}
            fill={row.fill}
            tone={null}
            value={row.value}
            tooltip={row.details.map((line, index) => (
              <span
                key={line}
                className={index === 0 ? "text-foreground" : "text-muted-foreground"}
              >
                {line}
              </span>
            ))}
          />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

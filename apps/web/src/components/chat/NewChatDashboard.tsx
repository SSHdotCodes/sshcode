import { use, useId, useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { ActivityIcon, ArrowUpRightIcon, CalendarClockIcon, GaugeIcon, PlugIcon, RadioIcon } from "lucide-react";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ModelSelection,
  ServerConfig,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildNewChatActivity,
  chatBackdropPalette,
  chatPaceChart,
  formatChatDelta,
  formatQuotaReset,
  newChatAccounts,
  newChatUsageWindows,
  selectHappeningNow,
  selectUpcomingScheduledTasks,
  type ChatBackdropMood,
  type ChatPace,
  type HappeningNowEntry,
  type UpcomingScheduledTask,
  type UpcomingScheduledTaskEntry,
} from "@t3tools/client-runtime/new-chat-dashboard";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import { HarnessMascot, HarnessMascotAgentId, HarnessMascotDriver } from "../HarnessMascot";
import { useElapsed } from "../sessionBoxes/SessionBox";
import { useHiddenWorkflowChatKeys } from "../workflows/WorkflowRunChatsTracker";
import { usePrivacyLabel, usePrivacyMode } from "../../hooks/usePrivacyMode";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import styles from "./NewChatDashboard.module.css";
import { ChatDither, type ChatDitherActivity, type ChatDitherMode } from "./ChatDither";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import {
  resolveAgentSetupRows,
  type AgentSetupRow,
} from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { providerClients } from "../settings/providerDriverMeta";

/**
 * Tinted by the selected harness. A new chat shows a dithered cloud of its light; a
 * conversation docks the arc under the composer, where it follows the turn: breathing
 * with a light along the rim while the agent works, brighter and still while it waits on
 * you, one sunrise when a turn you watched finishes, and dimmer after one that failed.
 */
export function NewChatBackdrop({
  docked = false,
  mood = "idle",
}: {
  docked?: boolean;
  mood?: ChatBackdropMood;
}) {
  const driver = use(HarnessMascotDriver);
  const agentId = use(HarnessMascotAgentId);
  const palette = chatBackdropPalette(driver, agentId);
  return (
    <div
      className={styles.horizon}
      data-chat-backdrop
      data-docked={docked || undefined}
      data-mood={docked && mood !== "idle" ? mood : undefined}
      style={
        {
          "--horizon-glow": palette.glow,
          "--horizon-rim-dark": palette.rimDark,
          "--horizon-rim-light": palette.rimLight,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <div className={styles.glow} />
      <div className={styles.rim} />
      <div className={styles.glint} />
    </div>
  );
}

/**
 * The new chat's dithered cloud, settling into faint embers once the chat is open, in the
 * harness's colours. One component across both, so sending the first message animates.
 */
export function ChatDitherBackdrop(props: { mode: ChatDitherMode; activity: ChatDitherActivity }) {
  const driver = use(HarnessMascotDriver);
  const agentId = use(HarnessMascotAgentId);
  const palette = chatBackdropPalette(driver, agentId);
  return (
    <ChatDither
      mode={props.mode}
      tint={palette.glow}
      coreDark={palette.cloudCoreDark}
      coreLight={palette.rimLight}
      activity={props.activity}
    />
  );
}

/** The most rows the card lists; the rest are a count and the Board. */
const HAPPENING_NOW_ROWS = 4;

function HappeningNowRow({
  entry,
  config,
}: {
  entry: HappeningNowEntry;
  config: ServerConfig | undefined;
}) {
  const { thread, box } = entry;
  const privateLabel = usePrivacyLabel();
  // A recording gets the status in a word.
  const status = usePrivacyMode() ? box.statusShort : box.status;
  const elapsed = useElapsed(box.tone === "working" ? box.since : null);
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
  const identity = harnessMascotIdentity({
    driver: provider?.driver ?? null,
    instanceId: provider?.instanceId ?? null,
    model: thread.modelSelection.model,
    agentId: harnessMascotAgentId(
      provider?.driver,
      provider ? config?.settings.providerInstances[provider.instanceId]?.config : null,
    ),
  });
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const title = privateLabel("Chat", scopedThreadKey(ref), thread.title);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className={styles["now-row"]}
      data-tone={box.tone}
      aria-label={`${title}: ${status}${elapsed ? `, ${elapsed}` : ""}`}
    >
      <HarnessMascot
        driver={identity.driver}
        agentId={identity.agentId}
        size={18}
        state={box.mascot}
      />
      <span className={styles["now-title"]}>{title}</span>
      <span className={styles["now-status"]}>
        <span className={styles["now-status-text"]}>{status}</span>
        {elapsed ? <i>{elapsed}</i> : null}
      </span>
    </Link>
  );
}

type EnvironmentScheduledTaskList = readonly [EnvironmentId, ReadonlyArray<UpcomingScheduledTask>];

const EMPTY_SCHEDULED_TASK_LISTS_ATOM = Atom.make<ReadonlyArray<EnvironmentScheduledTaskList>>(
  Object.freeze([]),
).pipe(Atom.withLabel("web-new-chat-scheduled-tasks:empty"));

/** One derived atom fans the live task subscription out across the connected machines. */
const scheduledTaskListsAtomFamily = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentScheduledTaskList> => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    const lists: Array<EnvironmentScheduledTaskList> = [];
    for (const environmentId of environmentIds) {
      const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) lists.push([environmentId, value.tasks]);
    }
    return lists;
  }).pipe(Atom.withLabel(`web-new-chat-scheduled-tasks:${key}`)),
);

type DashboardUpcomingScheduledTaskEntry = UpcomingScheduledTaskEntry<
  UpcomingScheduledTask & { readonly environmentId: EnvironmentId }
>;

function UpcomingScheduledTaskRow({ entry }: { entry: DashboardUpcomingScheduledTaskEntry }) {
  const privateLabel = usePrivacyLabel();
  const environmentId = entry.task.environmentId;
  const title = privateLabel(
    "Chat",
    `scheduled-task:${environmentId}:${entry.task.id}`,
    entry.task.title,
  );
  const starts = `· starts ${entry.startsLabel}`;
  if (entry.task.threadId !== null) {
    const ref = scopeThreadRef(environmentId, entry.task.threadId);
    return (
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(ref)}
        className={styles["now-row"]}
        aria-label={`${title} ${starts}`}
      >
        <CalendarClockIcon size={18} aria-hidden />
        <span className={styles["now-title"]}>{title}</span>
        <span className={styles["now-status"]}>
          <span className={styles["now-status-text"]}>{starts}</span>
        </span>
      </Link>
    );
  }
  return (
    <Link
      to="/settings/scheduled-tasks"
      search={{ environmentId }}
      className={styles["now-row"]}
      aria-label={`${title} ${starts}. Open scheduled task settings`}
    >
      <CalendarClockIcon size={18} aria-hidden />
      <span className={styles["now-title"]}>{title}</span>
      <span className={styles["now-status"]}>
        <span className={styles["now-status-text"]}>{starts}</span>
      </span>
    </Link>
  );
}

/**
 * What is going on while you start something new: the chats waiting on you, then the ones
 * working, each a way in. Absent when everything is quiet, so an idle start stays plain.
 */
function HappeningNow({
  threads,
  now,
  headingId,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  now: number;
  headingId: string;
}) {
  const hiddenWorkflowChats = useHiddenWorkflowChatKeys();
  const serverConfigs = useServerConfigs();
  const { presentationById } = useEnvironments();
  const { entries, needsYou, working } = useMemo(
    () =>
      selectHappeningNow(threads, {
        now,
        connectionPhase: (environmentId) => presentationById.get(environmentId)?.connection.phase,
        snoozes: (environmentId) =>
          serverConfigs.get(environmentId)?.environment.capabilities.threadSnooze === true,
        isHidden: (thread) =>
          hiddenWorkflowChats !== null &&
          (thread.source.creationSource === "workflows" ||
            hiddenWorkflowChats.has(`${thread.environmentId}:${thread.id}`)),
      }),
    [threads, now, presentationById, serverConfigs, hiddenWorkflowChats],
  );
  const connectedEnvironmentIds = useMemo(
    () =>
      [...presentationById.entries()]
        .filter(([, presentation]) => presentation.connection.phase === "connected")
        .map(([connectedEnvironmentId]) => connectedEnvironmentId)
        .sort(),
    [presentationById],
  );
  const scheduledTaskLists = useAtomValue(
    connectedEnvironmentIds.length === 0
      ? EMPTY_SCHEDULED_TASK_LISTS_ATOM
      : scheduledTaskListsAtomFamily(JSON.stringify(connectedEnvironmentIds)),
  );
  const upcomingTasks = useMemo(
    () =>
      selectUpcomingScheduledTasks(
        scheduledTaskLists.flatMap(([taskEnvironmentId, tasks]) =>
          tasks.map((task) => ({ ...task, environmentId: taskEnvironmentId })),
        ),
        now,
      ),
    [scheduledTaskLists, now],
  );
  if (entries.length === 0 && upcomingTasks.length === 0) return null;
  const more = entries.length - HAPPENING_NOW_ROWS;
  const summary = [
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : null,
    working > 0 ? `${working} working` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <section
      className={styles.card + " " + styles.now}
      aria-labelledby={headingId}
      data-needs-you={needsYou > 0 || undefined}
    >
      <div className={styles["card-heading"]}>
        <h2 id={headingId}>
          <RadioIcon aria-hidden />
          Right now
        </h2>
        {summary ? (
          <Link to="/board" className={styles.more} aria-label={`${summary}. Open the Board`}>
            {summary}
          </Link>
        ) : null}
      </div>
      <div
        className={styles["now-list"]}
        data-single={entries.length + upcomingTasks.length === 1 || undefined}
      >
        {entries.slice(0, HAPPENING_NOW_ROWS).map((entry) => (
          <HappeningNowRow
            key={`${entry.thread.environmentId}:${entry.thread.id}`}
            entry={entry}
            config={serverConfigs.get(entry.thread.environmentId)}
          />
        ))}
        {upcomingTasks.map((entry) => (
          <UpcomingScheduledTaskRow
            key={`scheduled:${entry.task.environmentId}:${entry.task.id}`}
            entry={entry}
          />
        ))}
      </div>
      {more > 0 ? (
        <Link to="/board" className={styles.more + " " + styles["now-more"]}>
          {`+${more} more on the Board`}
        </Link>
      ) : null}
    </section>
  );
}

const AGENT_SETUP_STATUS: Record<AgentSetupRow["state"], string> = {
  install: "Not installed",
  signIn: "Sign in needed",
  attention: "Needs attention",
};

/**
 * Shown on a new chat while no agent on this environment can run yet: one row per agent
 * harness with its status and the one step that moves it along. Install copies the official
 * installer and opens its docs (or opens SSHCode's own installer in Settings); Sign in opens
 * that provider's setup. Gone once any agent is ready; Settings › Providers adds the rest.
 */
function AgentSetup({
  environmentId,
  platform,
  config,
  headingId,
}: {
  environmentId: EnvironmentId;
  platform: ExecutionEnvironmentPlatformOs;
  config: ServerConfig;
  headingId: string;
}) {
  const navigate = useNavigate();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const rows = useMemo(() => resolveAgentSetupRows(providers, platform), [providers, platform]);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const canRefresh = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(environmentId, {}),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [copiedInstanceId, setCopiedInstanceId] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "install command",
    onCopy: setCopiedInstanceId,
  });
  if (rows === null) return null;

  const runAction = (row: AgentSetupRow) => {
    const { action, provider } = row;
    if (action.kind === "settings") {
      void navigate({
        to: "/settings/providers",
        search: { environmentId, instanceId: provider.instanceId },
      });
      return;
    }
    if (action.command !== null) copyToClipboard(action.command, provider.instanceId);
    void ensureLocalApi()
      .shell.openExternal(action.docsUrl)
      .catch(() => undefined);
  };
  const refresh = () => {
    setRefreshing(true);
    void refreshProviders({ environmentId, input: {} }).finally(() => setRefreshing(false));
  };

  return (
    <section className={styles.card + " " + styles.setup} aria-labelledby={headingId}>
      <div className={styles["card-heading"]}>
        <h2 id={headingId}>
          <PlugIcon aria-hidden />
          Set up an agent
        </h2>
        {canRefresh ? (
          <button type="button" className={styles.more} disabled={refreshing} onClick={refresh}>
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        ) : null}
      </div>
      <p className={styles["setup-lead"]}>
        SSHCode runs the coding agents you already use. Install one and sign in to start.
      </p>
      <ul className={styles["setup-list"]}>
        {rows.map((row) => {
          const { provider, action } = row;
          const name =
            provider.displayName ??
            providerClients.get(provider.driver)?.label ??
            String(provider.driver);
          const copied = isCopied && copiedInstanceId === provider.instanceId;
          return (
            <li key={provider.instanceId} className={styles["setup-row"]}>
              <HarnessMascot
                driver={provider.driver}
                agentId={harnessMascotAgentId(
                  provider.driver,
                  config.settings.providerInstances[provider.instanceId]?.config,
                )}
                size={18}
                still
              />
              <span className={styles["setup-name"]}>{name}</span>
              <span className={styles["setup-status"]} role="status">
                {copied ? "Copied. Paste it in Terminal" : AGENT_SETUP_STATUS[row.state]}
              </span>
              <button
                type="button"
                className={styles["setup-action"]}
                aria-label={`${action.kind === "settings" ? action.label : "Install"} ${name}`}
                onClick={() => runAction(row)}
              >
                {action.kind === "settings" ? action.label : "Install"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The pace chart is drawn in this box and stretched to the card; strokes keep their width. */
const PACE_BOX = { width: 320, height: 64 };

/**
 * This month's chats as a running total against last month's, day for day: the picture of
 * the "+12" beside the count. The line stops at today; last month runs on as what is ahead.
 */
function PaceChart({ pace, delta }: { pace: ChatPace; delta: number }) {
  const chart = useMemo(() => chatPaceChart(pace, PACE_BOX.width, PACE_BOX.height), [pace]);
  const total = pace.current.at(-1) ?? 0;
  return (
    <div className={styles.pace}>
      <div
        className={styles["pace-plot"]}
        role="img"
        aria-label={`${total.toLocaleString()} ${total === 1 ? "chat" : "chats"} started so far in ${pace.month}, ${formatChatDelta(delta)} against the same days of ${pace.previousMonth}`}
      >
        <svg
          viewBox={`0 0 ${PACE_BOX.width} ${PACE_BOX.height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {chart.area ? <path className={styles["pace-area"]} d={chart.area} /> : null}
          {chart.previous ? <path className={styles["pace-previous"]} d={chart.previous} /> : null}
          <path className={styles["pace-current"]} d={chart.current} />
        </svg>
        <i
          style={{
            left: `${(chart.today.x / PACE_BOX.width) * 100}%`,
            top: `${(chart.today.y / PACE_BOX.height) * 100}%`,
          }}
        />
        {chart.previousEnd ? (
          <span
            aria-hidden
            style={{
              left: `${(chart.previousEnd.x / PACE_BOX.width) * 100}%`,
              top: `${(chart.previousEnd.y / PACE_BOX.height) * 100}%`,
            }}
          >
            {chart.previousEnd.total.toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className={styles["pace-axis"]} aria-hidden>
        <span>{`${pace.month} 1`}</span>
        <span>{`${pace.month} ${pace.daysInMonth}`}</span>
      </div>
    </div>
  );
}

/** Only mounted for the empty draft, so active chats never subscribe to these summaries. */
export function NewChatDashboard({
  environmentId,
  config,
  driver,
  instanceId,
  selection,
  balanceAccounts,
  acceptsAccount,
  onPickAccount,
}: {
  environmentId: EnvironmentId;
  config: ServerConfig | null;
  driver: string | null;
  /** The account the selected model runs on; its limits are the ones shown. */
  instanceId: string | null;
  /** The selected model: with two accounts of its provider, Usage shows both as equals. */
  selection: ModelSelection | null;
  /** Says where new chats start; off when the user picks accounts by hand. */
  balanceAccounts: boolean;
  /** Whether this chat could start a model on an account (its project, hidden models). */
  acceptsAccount: (provider: ServerConfig["providers"][number], model: string) => boolean;
  /** Starts this chat on another of the user's accounts. */
  onPickAccount: (instanceId: string) => void;
}) {
  const headingId = useId();
  const threads = useThreadShells();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const activity = useMemo(
    () => buildNewChatActivity(threads, environmentId, now),
    [threads, environmentId, now],
  );
  const windows = useMemo(
    () => newChatUsageWindows(config, environmentId, driver, instanceId),
    [config, environmentId, driver, instanceId],
  );
  const accounts = useMemo(
    () => newChatAccounts(config, selection, now, acceptsAccount),
    [acceptsAccount, config, selection, now],
  );
  const hasUsage = windows.length > 0 || accounts !== null;
  return (
    // The frame is the size container, so the grid follows the composer lane, not the window.
    <div className={styles.frame}>
      <div
        className={styles.dashboard}
        data-no-usage={hasUsage ? undefined : true}
        aria-label="Your chat activity"
      >
        {config ? (
          <AgentSetup
            environmentId={environmentId}
            platform={config.environment.platform.os}
            config={config}
            headingId={`${headingId}-setup`}
          />
        ) : null}
        <HappeningNow threads={threads} now={now} headingId={`${headingId}-now`} />
        <section
          className={styles.card + " " + styles.activity}
          aria-labelledby={`${headingId}-activity`}
          aria-description="From loaded chats on this machine"
        >
          <div className={styles["card-heading"]}>
            <h2 id={`${headingId}-activity`}>
              <ActivityIcon aria-hidden />
              Activity
            </h2>
            <span>26 weeks</span>
          </div>
          <div
            className={styles.heatmap}
            role="img"
            aria-label={`${activity.total} ${activity.total === 1 ? "chat" : "chats"} started across ${activity.activeDays} active ${activity.activeDays === 1 ? "day" : "days"} in the last 26 weeks`}
          >
            {activity.days.map((day) => (
              <span key={day.date} data-level={day.level} data-future={day.future || undefined} />
            ))}
          </div>
          <div className={styles["card-footer"]}>
            <span>
              <strong>{activity.total.toLocaleString()}</strong>{" "}
              {activity.total === 1 ? "chat" : "chats"} · {activity.activeDays} active{" "}
              {activity.activeDays === 1 ? "day" : "days"}
            </span>
            <span className={styles.legend} aria-hidden>
              Less <i data-level="0" />
              <i data-level="2" />
              <i data-level="4" /> More
            </span>
          </div>
        </section>

        {hasUsage ? (
          <section
            className={styles.card + " " + styles.usage}
            aria-labelledby={`${headingId}-usage`}
            aria-description="Latest reported provider limits"
          >
            <div className={styles["card-heading"]}>
              <h2 id={`${headingId}-usage`}>
                <GaugeIcon aria-hidden />
                Usage
              </h2>
            </div>
            <div className={styles["quota-list"]} data-accounts={accounts ? true : undefined}>
              {accounts?.rows.map((account) => (
                <button
                  key={account.instanceId}
                  type="button"
                  className={styles.quota + " " + styles.account}
                  aria-pressed={account.current}
                  onClick={() => {
                    if (!account.current) onPickAccount(account.instanceId);
                  }}
                >
                  <div className={styles["quota-label"]}>
                    <span>
                      {account.name}
                      {account.limit ? ` · ${account.limit.label}` : ""}
                    </span>
                    <em>{account.current ? "This chat" : "Use for this chat"}</em>
                    <strong>
                      {account.limit
                        ? `${Math.round(account.limit.usedPercent)}% used`
                        : "No limits reported"}
                    </strong>
                  </div>
                  <div
                    className={styles["quota-track"]}
                    role="meter"
                    aria-label={`${account.name} ${account.limit?.label ?? "limit"} used`}
                    aria-valuenow={account.limit?.usedPercent ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${account.limit?.usedPercent ?? 0}%` }} />
                  </div>
                  {/* A limit nothing has counted against yet has no reset to state. */}
                  {account.limit?.resetsAt ? (
                    <p>{`Resets ${formatQuotaReset(account.limit.resetsAt)}`}</p>
                  ) : null}
                </button>
              ))}
              {accounts && balanceAccounts && accounts.note ? (
                <p className={styles["account-note"]}>{accounts.note}</p>
              ) : null}
              {accounts ? (
                <Link to="/usage" className={styles.more}>
                  All limits in Usage
                </Link>
              ) : null}
              {(accounts ? [] : windows.slice(0, 2)).map((window) => (
                <div key={window.key} className={styles.quota}>
                  <div className={styles["quota-label"]}>
                    <span>
                      {window.accountLabel} · {window.label}
                    </span>
                    <strong>{Math.round(window.usedPercent)}% used</strong>
                  </div>
                  <div
                    className={styles["quota-track"]}
                    role="meter"
                    aria-label={`${window.accountLabel} ${window.label} used`}
                    aria-valuenow={window.usedPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${window.usedPercent}%` }} />
                  </div>
                  {window.resetsAt ? <p>{`Resets ${formatQuotaReset(window.resetsAt)}`}</p> : null}
                </div>
              ))}
              {!accounts && windows.length > 2 ? (
                <Link to="/usage" className={styles.more}>
                  {`+${windows.length - 2} more in Usage`}
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}

        <section
          className={styles.card + " " + styles.month}
          aria-labelledby={`${headingId}-month`}
        >
          <div className={styles["card-heading"]}>
            <h2 id={`${headingId}-month`}>
              <ArrowUpRightIcon aria-hidden />
              This month
            </h2>
            <span className={styles["pace-legend"]} aria-hidden>
              <i />
              {activity.pace.month}
              <i data-previous />
              {activity.pace.previousMonth}
            </span>
          </div>
          <div className={styles["month-body"]}>
            <div>
              <div className={styles["month-stats"]}>
                {(
                  [
                    ["Chats started", activity.month.chats, activity.delta.chats],
                    ["Active days", activity.month.activeDays, activity.delta.activeDays],
                  ] as const
                ).map(([label, count, delta]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <div>
                      <strong>{count.toLocaleString()}</strong>
                      <span
                        className={styles.delta}
                        aria-label={`${formatChatDelta(delta)} versus the same days last month`}
                      >
                        {formatChatDelta(delta)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className={styles.source}>vs. same days last month</p>
            </div>
            <PaceChart pace={activity.pace} delta={activity.delta.chats} />
          </div>
        </section>
      </div>
    </div>
  );
}

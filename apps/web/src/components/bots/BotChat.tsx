import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BOT_INFO_SECTIONS,
  BOT_MEMORY_EMPTY,
  BOT_ROUTINES_EMPTY,
  BOT_STARTERS,
  BOT_WATCHING_EMPTY,
  BOTS_OFF_SETTINGS_LABEL,
  botGreeting,
  botMemoryDayLabel,
  botsOffNote,
} from "@t3tools/client-runtime/state/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_MEMORY_ENTRY_MAX,
  AuthOrchestrationOperateScope,
  type Bot,
  type BotMemoryEntry,
  type BotRuntimeState,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  CalendarClockIcon,
  InfoIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { useLinkedThreadShell, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { ThreadDetailsCard } from "../chat/ThreadDetailsCard";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import type { ThreadDetailsPanelProps } from "../chat/ThreadDetailsPanel";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "../chat/threadDetailsPanelStyles";
import {
  isFinishedOnceTask,
  relativeLabel,
  scheduleLabel,
} from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar } from "./BotAvatar";
import { BotModelPicker } from "./BotModelPicker";
import { openBotSheet } from "./botRequests";
import { BotPermissionSwitches } from "./BotSheet";
import {
  useBotActions,
  useBotCommand,
  useBotPresence,
  useBotsRuntime,
  useCanEditBots,
} from "./useBots";

/** The model a bot's chat runs on, as the picker names it. */
function useModelName(environmentId: EnvironmentId, instanceId: string, model: string): string {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const known = providers
    .find((provider) => provider.instanceId === instanceId)
    ?.models.find((candidate) => candidate.slug === model);
  return known ? getTriggerDisplayModelName(known) : formatModelSlugName(model);
}

export interface BotInfoToggleProps {
  readonly open: boolean;
  readonly presentation: ThreadPanelPresentation;
  readonly popoverHandle?: ReturnType<typeof PopoverCreateHandle> | undefined;
  readonly onToggle: () => void;
}

/**
 * A bot chat's header: its face, name, model and one status line, and the button that opens
 * the info panel. Never its tool activity.
 */
export function BotChatHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly info: BotInfoToggleProps;
  /** Room for the window's panel controls, as the normal header leaves. */
  readonly reserveClassName: string;
}) {
  const { environmentId, bot } = props;
  const runtime = useBotsRuntime(environmentId, true);
  const presence = useBotPresence(environmentId, bot, runtime.byBotId.get(bot.id));
  const shell = useThreadShell(scopeThreadRef(environmentId, bot.threadId));
  const selection = shell?.modelSelection ?? bot.target;
  const modelName = useModelName(environmentId, selection.instanceId, selection.model);
  const infoButton = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`About ${bot.name}`}
      aria-pressed={props.info.open}
      className="[-webkit-app-region:no-drag]"
    >
      <InfoIcon />
    </Button>
  );
  const withTooltip = (trigger: ReactElement) => (
    <Tooltip>
      <TooltipTrigger
        render={trigger}
        {...(props.info.presentation === "popover" ? {} : { onClick: props.info.onToggle })}
      />
      <TooltipPopup side="bottom">About {bot.name}</TooltipPopup>
    </Tooltip>
  );
  return (
    <div
      data-bot-chat-header
      className={cn("flex min-w-0 flex-1 items-center gap-2.5", props.reserveClassName)}
    >
      <BotAvatar color={bot.color} size={36} state={presence.avatarState} />
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold leading-5 text-foreground">{bot.name}</h2>
          <span className="max-w-40 shrink-0 truncate rounded-md bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
            {modelName}
          </span>
        </div>
        <p
          className={cn(
            "truncate text-xs leading-4",
            presence.status.kind === "needsYou" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {presence.status.label}
        </p>
      </div>
      {props.info.presentation === "popover"
        ? withTooltip(<PopoverTrigger handle={props.info.popoverHandle} render={infoButton} />)
        : withTooltip(infoButton)}
    </div>
  );
}

/**
 * The header of a bot's chat while Bots are off: its face and name, nothing that reads its
 * memory or watches (no bot stream opens while off).
 */
export function BotParkedHeader(props: { readonly bot: Bot; readonly reserveClassName: string }) {
  return (
    <div
      data-bot-chat-header="parked"
      className={cn("flex min-w-0 flex-1 items-center gap-2.5", props.reserveClassName)}
    >
      <BotAvatar color={props.bot.color} size={36} state="idle" />
      <h2 className="truncate text-sm font-semibold leading-5 text-foreground">{props.bot.name}</h2>
    </div>
  );
}

/** Stands in for the composer of a bot's chat while Bots are off. */
export function BotsOffBar(props: { readonly bot: Bot }) {
  const navigate = useNavigate();
  return (
    <div
      data-bots-off-bar
      className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm"
    >
      <p className="min-w-0 flex-1 text-muted-foreground">{botsOffNote(props.bot.name)}</p>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void navigate({ to: "/settings/bots" })}
      >
        {BOTS_OFF_SETTINGS_LABEL}
      </Button>
    </div>
  );
}

/** A bot chat with nothing in it yet: the face, a hello and three things to ask. */
export function BotEmptyState(props: {
  readonly bot: Bot;
  readonly disabled: boolean;
  /** Absent while Bots are off: the chat takes no messages. */
  readonly onSend: ((text: string) => void) | null;
}) {
  return (
    <div
      data-bot-empty-state
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 pb-40"
    >
      <div className="pointer-events-auto flex max-w-md flex-col items-center gap-4 text-center">
        <BotAvatar color={props.bot.color} size={88} ringClassName="stroke-background" />
        <p className="text-xl font-semibold text-foreground">{botGreeting(props.bot.name)}</p>
        {props.onSend === null ? null : (
          <div className="flex flex-wrap justify-center gap-2">
            {BOT_STARTERS.map((starter) => (
              <Button
                key={starter}
                variant="outline"
                size="sm"
                disabled={props.disabled}
                onClick={() => props.onSend?.(starter)}
              >
                {starter}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The right-hand panel of a bot chat: memory, watches, routines, permissions, model. */
export function BotInfoPanel(
  props: Pick<
    ThreadDetailsPanelProps,
    "anchor" | "handle" | "onPresentationChange" | "defaultInlineOpen"
  > & { readonly environmentId: EnvironmentId; readonly bot: Bot },
) {
  const { environmentId, bot } = props;
  const runtime = useBotsRuntime(environmentId, true);
  const botRuntime = runtime.byBotId.get(bot.id);
  const presence = useBotPresence(environmentId, bot, botRuntime);
  const canEdit = useCanEditBots(environmentId);
  const runBotCommand = useBotCommand();
  const { setPaused, remove } = useBotActions();
  const update = (
    patch: Omit<Extract<Parameters<typeof runBotCommand>[1], { type: "update" }>, "type" | "botId">,
  ) =>
    runBotCommand(
      environmentId,
      { type: "update", botId: bot.id, ...patch },
      `Couldn't save ${bot.name}`,
    );
  return (
    <ThreadDetailsCard
      threadRef={scopeThreadRef(environmentId, bot.threadId)}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
      defaultInlineOpen={props.defaultInlineOpen ?? false}
    >
      {() => (
        <>
          <section aria-label={bot.name} className="flex items-center gap-3 px-4 pt-3 pb-2">
            <BotAvatar
              color={bot.color}
              size={44}
              state={presence.avatarState}
              ringClassName="stroke-popover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{bot.name}</p>
              <p
                className={cn(
                  "truncate text-xs",
                  presence.status.kind === "needsYou" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {presence.status.label}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="icon"
                    aria-label={`Edit ${bot.name}`}
                    disabled={!canEdit}
                    onClick={() => openBotSheet(environmentId, bot.id)}
                  />
                }
              >
                <PencilIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Edit name, color and personality</TooltipPopup>
            </Tooltip>
          </section>
          <BotMemorySection
            environmentId={environmentId}
            bot={bot}
            runtime={botRuntime}
            loaded={runtime.loaded}
            failed={runtime.failed}
            canEdit={canEdit}
          />
          <BotWatchingSection
            environmentId={environmentId}
            bot={bot}
            runtime={botRuntime}
            loaded={runtime.loaded}
            failed={runtime.failed}
            canEdit={canEdit}
          />
          <BotRoutinesSection environmentId={environmentId} threadId={bot.threadId} />
          <ThreadDetailsSection
            headingId="bot-info-permissions"
            title={BOT_INFO_SECTIONS.permissions}
          >
            <div className="px-2.5 pb-1">
              <BotPermissionSwitches
                permissions={bot.permissions}
                disabled={!canEdit}
                onChange={(permissions) => void update({ permissions })}
              />
            </div>
          </ThreadDetailsSection>
          <ThreadDetailsSection headingId="bot-info-model" title={BOT_INFO_SECTIONS.model}>
            <div className="px-2.5 pb-1">
              <BotModelPicker
                environmentId={environmentId}
                value={bot.target}
                disabled={!canEdit}
                onChange={(target) => void update({ target })}
              />
            </div>
          </ThreadDetailsSection>
          <ThreadDetailsSection headingId="bot-info-actions" title="Actions" showHeading={false}>
            <ThreadDetailsControl
              disabled={!canEdit}
              onClick={() => void setPaused(environmentId, bot, !bot.paused)}
            >
              {bot.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
              {bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`}
            </ThreadDetailsControl>
            <ThreadDetailsControl
              tone="destructive"
              disabled={!canEdit}
              onClick={() => void remove(environmentId, bot)}
            >
              <Trash2Icon className="size-4" />
              Delete {bot.name}
            </ThreadDetailsControl>
          </ThreadDetailsSection>
        </>
      )}
    </ThreadDetailsCard>
  );
}

function SectionEmpty({ children }: { readonly children: string }) {
  return <p className="px-2.5 pb-1 text-xs leading-normal text-muted-foreground">{children}</p>;
}

function BotMemorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly runtime: BotRuntimeState | undefined;
  readonly loaded: boolean;
  readonly failed: boolean;
  readonly canEdit: boolean;
}) {
  const memory = props.runtime?.memory ?? [];
  return (
    <ThreadDetailsSection headingId="bot-info-memory" title={BOT_INFO_SECTIONS.memory}>
      {!props.loaded ? (
        <SectionEmpty>{props.failed ? "Couldn't load this right now." : "Loading…"}</SectionEmpty>
      ) : memory.length === 0 ? (
        <SectionEmpty>{BOT_MEMORY_EMPTY}</SectionEmpty>
      ) : (
        <ul className="m-0 list-none p-0">
          {memory.toReversed().map((entry) => (
            <BotMemoryRow
              key={entry.id}
              environmentId={props.environmentId}
              bot={props.bot}
              entry={entry}
              canEdit={props.canEdit}
            />
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}

function BotMemoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly entry: BotMemoryEntry;
  readonly canEdit: boolean;
}) {
  const { entry } = props;
  const runBotCommand = useBotCommand();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const text = editing?.trim() ?? "";
    if (busy || text.length === 0) return;
    if (text === entry.text) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const result = await runBotCommand(
      props.environmentId,
      { type: "memory", botId: props.bot.id, replace: { id: entry.id, text } },
      "Couldn't save the note",
    );
    setBusy(false);
    if (result.ok) setEditing(null);
  };
  const removeEntry = async () => {
    if (busy) return;
    setBusy(true);
    await runBotCommand(
      props.environmentId,
      { type: "memory", botId: props.bot.id, remove: entry.id },
      "Couldn't delete the note",
    );
    setBusy(false);
  };
  if (editing !== null) {
    return (
      <li className="space-y-1.5 px-2.5 py-1.5">
        <Textarea
          autoFocus
          aria-label="Note"
          value={editing}
          maxLength={BOT_MEMORY_ENTRY_MAX}
          rows={3}
          disabled={busy}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(null);
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={busy || editing.trim().length === 0}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li
      className={cn(
        "group flex items-start rounded-lg py-1.5",
        THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/85">{entry.text}</p>
        <p className="text-2xs text-muted-foreground">
          {botMemoryDayLabel(entry.at, new Date().getFullYear())}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
        <ThreadDetailsControl
          part="icon"
          aria-label="Edit note"
          disabled={!props.canEdit || busy}
          onClick={() => setEditing(entry.text)}
        >
          <PencilIcon className="size-3.5" />
        </ThreadDetailsControl>
        <ThreadDetailsControl
          part="icon"
          aria-label="Delete note"
          disabled={!props.canEdit || busy}
          onClick={() => void removeEntry()}
        >
          <Trash2Icon className="size-3.5" />
        </ThreadDetailsControl>
      </div>
    </li>
  );
}

function BotWatchingSection(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly runtime: BotRuntimeState | undefined;
  readonly loaded: boolean;
  readonly failed: boolean;
  readonly canEdit: boolean;
}) {
  const watching = props.runtime?.watching ?? [];
  const runBotCommand = useBotCommand();
  const unwatch = (threadId: ThreadId) =>
    void runBotCommand(
      props.environmentId,
      { type: "unwatch", botId: props.bot.id, threadIds: [threadId] },
      "Couldn't stop watching",
    );
  return (
    <ThreadDetailsSection headingId="bot-info-watching" title={BOT_INFO_SECTIONS.watching}>
      {!props.loaded ? (
        <SectionEmpty>{props.failed ? "Couldn't load this right now." : "Loading…"}</SectionEmpty>
      ) : watching.length === 0 ? (
        <SectionEmpty>{BOT_WATCHING_EMPTY}</SectionEmpty>
      ) : (
        <ul className="m-0 list-none p-0">
          {watching.map((watch) => (
            <BotWatchRow
              key={watch.threadId}
              environmentId={props.environmentId}
              threadId={watch.threadId}
              events={watch.events}
              disabled={!props.canEdit}
              onUnwatch={() => unwatch(watch.threadId)}
            />
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}

function BotWatchRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly events: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onUnwatch: () => void;
}) {
  const shell = useLinkedThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const title = shell?.title.trim() || "A chat that's gone";
  return (
    <li className={cn("flex items-center rounded-lg py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground/80">{title}</p>
        {props.events.length > 0 ? (
          <p className="truncate text-2xs text-muted-foreground">{props.events.join(", ")}</p>
        ) : null}
      </div>
      <ThreadDetailsControl
        part="icon"
        aria-label={`Stop watching ${title}`}
        disabled={props.disabled}
        onClick={props.onUnwatch}
      >
        <XIcon className="size-3.5" />
      </ThreadDetailsControl>
    </li>
  );
}

/** Scheduled tasks that run in the bot's chat, with their usual on/off switch. */
function BotRoutinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine toggle",
    reportFailure: false,
  });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const routines = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId && !isFinishedOnceTask(task, nowMs),
  );
  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't update the routine",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
  };
  return (
    <ThreadDetailsSection headingId="bot-info-routines" title={BOT_INFO_SECTIONS.routines}>
      {tasksQuery.error !== null ? (
        <SectionEmpty>{`Couldn't load routines: ${tasksQuery.error}`}</SectionEmpty>
      ) : tasksQuery.data === null ? (
        <SectionEmpty>Loading…</SectionEmpty>
      ) : routines.length === 0 ? (
        <SectionEmpty>{BOT_ROUTINES_EMPTY}</SectionEmpty>
      ) : (
        <ul className="m-0 list-none p-0">
          {routines.map((task) => (
            <li
              key={task.id}
              className={cn(
                "flex items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground/80">{task.title}</p>
                <p className="truncate text-2xs text-muted-foreground">
                  {scheduleLabel(task.schedule)}
                  {task.enabled && task.nextRunAt !== null
                    ? ` · next ${relativeLabel(task.nextRunAt, nowMs)}`
                    : task.enabled
                      ? ""
                      : " · off"}
                </p>
              </div>
              <Switch
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Turn off ${task.title}` : `Turn on ${task.title}`}
                onCheckedChange={(enabled) => void toggle(task, enabled)}
              />
            </li>
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}

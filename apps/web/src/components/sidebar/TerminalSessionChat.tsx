import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeRcItem, ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import {
  summarizeToolGroup,
  toolGroupSummaryKind,
  workEntryDisplayIndicatesToolFailure,
} from "@t3tools/client-runtime/work-log/presentation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ArrowUpIcon, ChevronRightIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { ComposerSurface } from "../chat/ComposerSurface";
import {
  WorkLogBlock,
  WorkLogButton,
  WorkLogDetails,
  WorkLogList,
  WorkLogRow,
} from "../chat/WorkLog";
import {
  WorkEntryIcon,
  failedToolIconClassName,
  toolCallExpandedBodyClassName,
  toolGroupSummaryIconName,
  workEntryIconName,
} from "../chat/MessagesTimeline";
import { singleToolCallLabel } from "../chat/MessagesTimeline.logic";
import { ToolOutputText } from "../chat/ToolOutputText";
import { cn } from "../../lib/utils";
import { UserMessageBubble } from "../chat/UserMessageBubble";
import { TimelineSystemDivider } from "../chat/TimelineSystemDivider";
import { SidebarTrigger } from "../ui/sidebar";
import { useUiMode } from "../../hooks/useTheme";
import "../chat/discordChat.css";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { claudeRcEnvironment } from "../../state/claudeRc";
import {
  TERMINAL_MESSAGE_MAX_LENGTH,
  TERMINAL_SESSION_LABEL,
  composerTextAfterSend,
  terminalCommandFailure,
  terminalSessionRows,
  terminalToolDetails,
  terminalToolEntry,
} from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionChat(props: {
  readonly environmentId: EnvironmentId;
  readonly session: ClaudeRcSession;
  readonly machineLabel: string;
  readonly onBack: () => void;
  readonly hostMessage?: string | null;
  readonly hostReady?: boolean;
}) {
  const watch = useEnvironmentQuery(
    claudeRcEnvironment.watch({
      environmentId: props.environmentId,
      input: { sessionId: props.session.id },
    }),
  );
  const allowed = useAtomValue(claudeRcEnvironment.command.permissionAtom(props.environmentId));
  const run = useAtomCommand(claudeRcEnvironment.command, { reportFailure: false });
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const state = watch.data;
  const rows = useMemo(() => terminalSessionRows(state?.items ?? []), [state?.items]);
  useEffect(() => {
    if (!state) return;
    const scroller = scrollRef.current;
    if (scroller && followRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [state]);

  const connected = props.hostReady !== false && state?.phase === "connected" && !watch.error;
  const canSend = allowed && connected;
  const send = async () => {
    const draft = text.trim();
    if (!canSend || draft.length === 0 || sending) return;
    if (draft.length > TERMINAL_MESSAGE_MAX_LENGTH) {
      setSendError("That message is too long.");
      return;
    }
    setSending(true);
    setSendError(null);
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "send", sessionId: props.session.id, text: draft },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText((current) => composerTextAfterSend(current, draft, true));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setSendError(terminalCommandFailure(squashAtomCommandFailure(result), "Could not send."));
    }
  };

  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "interrupt", sessionId: props.session.id },
    });
    setInterrupting(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setSendError(terminalCommandFailure(squashAtomCommandFailure(result), "Could not stop."));
  };

  const decide = async (requestId: string, allow: boolean) => {
    const result = await run({
      environmentId: props.environmentId,
      input: { action: "permission", sessionId: props.session.id, requestId, allow },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setSendError(
      terminalCommandFailure(squashAtomCommandFailure(result), "Could not answer that request."),
    );
  };

  const phaseMessage =
    props.hostMessage ??
    watch.error ??
    (state?.phase === "disconnected"
      ? (state.message ?? "Disconnected. Reconnect or return to Terminal sessions.")
      : state?.phase === "connecting" || state === null
        ? (state?.message ?? "Connecting…")
        : state.message);

  return (
    <section aria-label={TERMINAL_SESSION_LABEL} className="flex h-full min-h-0 flex-col">
      <header
        data-chat-header
        className="flex min-h-14 shrink-0 items-center border-b px-4 [-webkit-app-region:drag]"
      >
        <div className={discord ? "dc-chat-heading" : "flex min-w-0 flex-1 items-center gap-3"}>
          <SidebarTrigger />
          <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium">
              {props.session.title || TERMINAL_SESSION_LABEL}
            </h2>
            <p className="truncate text-xs text-muted-foreground">{props.machineLabel}</p>
          </div>
          <span className="shrink-0 rounded border px-1.5 py-0.5 text-2xs text-muted-foreground">
            {TERMINAL_SESSION_LABEL}
          </span>
        </div>
      </header>
      <div
        ref={scrollRef}
        className="messages-timeline-scroll scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div
          className={
            discord
              ? "flex w-full flex-col gap-4 py-4"
              : "chat-content-lane mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-4 px-4 py-6"
          }
        >
          {rows.map((row, index) => {
            const last = index === rows.length - 1;
            return row.kind === "tools" ? (
              <div key={row.id} data-dc-timeline-row={discord || undefined}>
                <TerminalToolGroup items={row.items} live={state?.working === true && last} />
              </div>
            ) : (
              <TerminalSessionMessage
                key={row.item.id}
                item={row.item}
                discord={discord}
                streaming={state?.working === true && last && row.item.role === "assistant"}
              />
            );
          })}
          {(state?.permissions ?? []).map((permission) => (
            <div key={permission.requestId} data-dc-timeline-row={discord || undefined}>
              <div className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="text-sm font-medium text-foreground">{permission.toolName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{permission.description}</p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    disabled={!canSend}
                    onClick={() => void decide(permission.requestId, true)}
                  >
                    Allow
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canSend}
                    onClick={() => void decide(permission.requestId, false)}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 px-3 pt-2 pb-4 sm:px-6">
        <div className="mx-auto max-w-(--chat-content-max-width)">
          {phaseMessage ? (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {phaseMessage}
            </p>
          ) : null}
          {!connected &&
          (watch.error || state?.phase === "disconnected" || props.hostReady === false) ? (
            <div className="mb-2 flex gap-2">
              <Button variant="ghost" size="sm" onClick={props.onBack}>
                Back to Terminal sessions
              </Button>
              <Button variant="ghost" size="sm" onClick={() => watch.refresh()}>
                Reconnect
              </Button>
            </div>
          ) : null}
          {sendError ? (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {sendError}
            </p>
          ) : null}
          {!allowed ? (
            <p className="mb-2 text-xs text-muted-foreground">
              This connection needs permission to operate chats.
            </p>
          ) : null}
        </div>
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
                className="relative flex flex-col p-3"
              >
                <textarea
                  aria-label="Message the terminal session"
                  value={text}
                  rows={2}
                  placeholder="Message the terminal session"
                  className="max-h-40 min-h-12 w-full resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  {state?.working ? (
                    <button
                      type="button"
                      aria-label="Stop"
                      className="flex size-8 items-center justify-center rounded-full bg-destructive text-white disabled:opacity-50"
                      disabled={!canSend || interrupting}
                      onClick={() => void interrupt()}
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    aria-label="Send"
                    disabled={!canSend || sending || text.trim().length === 0}
                    className="flex size-8 items-center justify-center rounded-full bg-message-action text-message-action-foreground disabled:bg-foreground/12 disabled:text-muted-foreground"
                  >
                    <ArrowUpIcon className="size-4" />
                  </button>
                </div>
              </form>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </section>
  );
}

function TerminalSessionMessage(props: {
  readonly item: ClaudeRcItem;
  readonly streaming: boolean;
  readonly discord: boolean;
}) {
  const { item } = props;
  if (item.role === "notice")
    return (
      <div data-dc-timeline-row={props.discord || undefined}>
        <TimelineSystemDivider label={item.text} />
      </div>
    );
  const body = (
    <ChatMarkdown
      text={item.text}
      cwd={undefined}
      lineBreaks={item.role === "user"}
      isStreaming={props.streaming}
    />
  );
  return (
    <article
      data-message-role={item.role}
      data-dc-timeline-row={props.discord || undefined}
      data-dc-message={props.discord || undefined}
      data-dc-start={props.discord || undefined}
    >
      {props.discord ? (
        <div data-dc-message-header>
          <span data-dc-message-avatar>
            {item.role === "user" ? "Y" : <TerminalIcon className="size-5" />}
          </span>
          <span data-dc-message-author>{item.role === "user" ? "You" : "Assistant"}</span>
        </div>
      ) : null}
      <h3 className="sr-only">{item.role === "user" ? "You" : "Assistant"}</h3>
      {item.role === "user" ? (
        <div data-user-message-content className="flex flex-col items-end">
          <UserMessageBubble>{body}</UserMessageBubble>
        </div>
      ) : (
        body
      )}
    </article>
  );
}

/** A chat's lone edit reads "Changed 1 file" next to its diff; here the path is all there is. */
function terminalToolLabel(entry: ReturnType<typeof terminalToolEntry>): string {
  return entry.itemType === "file_change" ? entry.label : singleToolCallLabel(entry);
}

/** Tool calls drawn like a chat's work log: one row for a lone call, a summary for a run of them. */
function TerminalToolGroup(props: {
  readonly items: readonly ClaudeRcItem[];
  readonly live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(
    () => props.items.map((item) => terminalToolEntry(item, props.live)),
    [props.items, props.live],
  );
  const single = entries.length === 1 ? entries[0] : undefined;
  if (single)
    return (
      <WorkLogBlock>
        <TerminalToolRow item={props.items[0]!} entry={single} label={terminalToolLabel(single)} />
      </WorkLogBlock>
    );
  const latest = entries[entries.length - 1];
  const failed = latest !== undefined && workEntryDisplayIndicatesToolFailure(latest);
  const active = entries.some((entry) => entry.toolLifecycleStatus === "inProgress");
  const summary = summarizeToolGroup(entries).summary;
  return (
    <>
      <WorkLogBlock layout={expanded ? "group-header" : "standalone"}>
        <WorkLogButton
          aria-label={failed ? `${summary}, tool call failed` : summary}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          icon={
            <WorkEntryIcon
              name={toolGroupSummaryIconName(toolGroupSummaryKind(entries))}
              className="size-4 shrink-0 stroke-2 text-icon-muted opacity-70 light:brightness-60"
            />
          }
          label={
            <span className={cn("block truncate", active && !failed && "live-tool-shine")}>
              {summary}
            </span>
          }
        />
      </WorkLogBlock>
      {expanded ? (
        <WorkLogBlock layout="group-content">
          <WorkLogList>
            {props.items.map((item, index) => (
              <TerminalToolRow
                key={item.id}
                item={item}
                entry={entries[index]!}
                label={terminalToolLabel(entries[index]!)}
              />
            ))}
          </WorkLogList>
        </WorkLogBlock>
      ) : null}
    </>
  );
}

function TerminalToolRow(props: {
  readonly item: ClaudeRcItem;
  readonly entry: ReturnType<typeof terminalToolEntry>;
  readonly label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const details = terminalToolDetails(props.item, props.label);
  const failed = workEntryDisplayIndicatesToolFailure(props.entry);
  const toggle = () => setExpanded(!expanded);
  const toggleProps =
    details === null
      ? {}
      : {
          role: "button" as const,
          tabIndex: 0 as const,
          "aria-label": failed ? `${props.label}, tool call failed` : props.label,
          "aria-expanded": expanded,
          onClick: toggle,
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          },
        };
  return (
    <WorkLogRow
      {...toggleProps}
      icon={
        <span
          className={cn(
            "flex size-4 items-center justify-center",
            failed ? failedToolIconClassName : "text-icon-muted",
          )}
        >
          <WorkEntryIcon
            name={workEntryIconName(props.entry)}
            className="block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60"
          />
        </span>
      }
      label={
        <span
          className={cn(
            "block truncate text-sm text-secondary-label",
            props.entry.toolLifecycleStatus === "inProgress" && "live-tool-shine",
          )}
        >
          {props.label}
        </span>
      }
      trailing={
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            details === null && "invisible",
          )}
          aria-hidden
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </span>
      }
    >
      {expanded && details !== null ? (
        <WorkLogDetails>
          <ToolOutputText text={details} className={toolCallExpandedBodyClassName} />
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

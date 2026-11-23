import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeRcItem, ClaudeRcSession, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ArrowUpIcon, ChevronDownIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { ComposerSurface } from "../chat/ComposerSurface";
import { WorkLogBlock, WorkLogButton, WorkLogDetails } from "../chat/WorkLog";
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
  const items = state?.items ?? [];
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
          {items.map((item, index) => (
            <TerminalSessionMessage
              key={item.id}
              item={item}
              discord={discord}
              streaming={
                state?.working === true && index === items.length - 1 && item.role === "assistant"
              }
            />
          ))}
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
  const [expanded, setExpanded] = useState(false);
  const { item } = props;
  if (item.role === "notice")
    return (
      <div data-dc-timeline-row={props.discord || undefined}>
        <TimelineSystemDivider label={item.text} />
      </div>
    );
  if (item.role === "tool")
    return (
      <div data-dc-timeline-row={props.discord || undefined}>
        <WorkLogBlock>
          <WorkLogButton
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            icon={<ChevronDownIcon className="size-3" />}
            label={item.text.split("\n")[0]}
          />
          {expanded ? (
            <WorkLogDetails>
              <pre className="font-mono text-xs whitespace-pre-wrap">{item.text}</pre>
            </WorkLogDetails>
          ) : null}
        </WorkLogBlock>
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

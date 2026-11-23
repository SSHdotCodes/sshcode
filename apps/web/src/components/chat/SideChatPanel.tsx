import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SideChatActivity,
  SideChatKind,
  SideChatState,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleCheckIcon, CircleXIcon, MessagesSquareIcon, QuoteIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";

import { randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  sideChatErrorMessage,
  sideChatIsBusy,
  sideChatPromptAbout,
  sideChatTitle,
  sideChatVisibleMessages,
  splitSideChatQuote,
} from "./sideChat.logic";

/** One opening of a side chat, from the question until the panel closes. */
export interface SideChatSession {
  /** Distinguishes openings, so a late answer for a replaced one is dropped. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly kind: SideChatKind;
  readonly question: string;
  /** The server's first snapshot, once `sideChat.open` answers. */
  readonly opened: SideChatState | null;
  readonly error: string | null;
}

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

/** Owns presentation only. Server snapshots survive dismissal, navigation and reloads. */
export function useSideChat(threadRef: ScopedThreadRef) {
  const threadKey = scopedThreadKey(threadRef);
  const [pending, setPending] = useState<SideChatSession | null>(null);
  const pendingRef = useRef<SideChatSession | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  // Like Claude Code's /btw, a side chat that has closed is not brought back once
  // it has been put away: the next time the popover opens, it starts fresh.
  const [hiddenSideChatId, setHiddenSideChatId] = useState<string | null>(null);
  // Text selected in an answer that the next side question is about.
  const [quoted, setQuoted] = useState<{ threadKey: string; text: string } | null>(null);
  const openSideChat = useAtomCommand(serverEnvironment.openSideChat, COMMAND_OPTIONS);
  const live = useEnvironmentQuery(
    serverEnvironment.sideChatState({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const state = live.data;
  const currentPending = pending?.threadKey === threadKey ? pending : null;
  const recovered =
    state === null || state.sideChatId === hiddenSideChatId
      ? null
      : ({
          key: state.sideChatId,
          threadKey,
          environmentId: threadRef.environmentId,
          threadRef,
          kind: state.kind,
          question: state.messages[0]?.text ?? "",
          opened: state,
          error: null,
        } satisfies SideChatSession);
  // A lost RPC acknowledgement cannot replace an already recovered answer with
  // an optimistic question or a connection error.
  const accepted =
    currentPending !== null && state?.messages.some((message) => message.id === currentPending.key);
  const session = currentPending !== null && !accepted ? currentPending : recovered;
  useEffect(() => {
    if (!accepted || currentPending === null || pendingRef.current?.key !== currentPending.key)
      return;
    pendingRef.current = null;
    setPending(null);
  }, [accepted, currentPending]);

  const open = async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadRef: ScopedThreadRef;
    readonly kind: SideChatKind;
    readonly prompt: string;
  }) => {
    const next: SideChatSession = {
      key: randomUUID(),
      threadKey,
      environmentId: input.environmentId,
      threadRef: input.threadRef,
      kind: input.kind,
      question: input.prompt,
      opened: null,
      error: null,
    };
    pendingRef.current = next;
    setPending(next);
    setHiddenSideChatId(null);
    setOpenThread(threadKey);
    const result = await openSideChat({
      environmentId: input.environmentId,
      input: { threadId: input.threadRef.threadId, prompt: input.prompt, messageId: next.key },
    });
    if (pendingRef.current?.key !== next.key) return;
    if (result._tag === "Success") {
      setPending({ ...next, opened: result.value });
    } else if (!isAtomCommandInterrupted(result)) {
      setPending({ ...next, error: sideChatErrorMessage(squashAtomCommandFailure(result)) });
    }
  };

  const setOpen = (next: boolean) => {
    if (state?.status === "closed") setHiddenSideChatId(state.sideChatId);
    // A question that never reached the server has nothing to come back to.
    if (!next && currentPending?.error != null) {
      pendingRef.current = null;
      setPending(null);
    }
    if (!next) setQuoted(null);
    setOpenThread(next ? threadKey : null);
  };

  /** Opens the side chat ready for a question about `text`, selected in an answer. */
  const askAbout = (text: string) => {
    setQuoted({ threadKey, text });
    setOpenThread(threadKey);
  };

  const busy =
    session !== null && session.error === null && (session !== recovered || sideChatIsBusy(state));
  return {
    session,
    busy,
    isOpen: openThread === threadKey,
    setOpen,
    open,
    quote: quoted?.threadKey === threadKey ? quoted.text : null,
    askAbout,
    clearQuote: () => setQuoted(null),
  };
}

/**
 * The side chat's own control in the header, like the side-chat button in the
 * iPhone header. The conversation opens in a popover beside it, so it never
 * covers the main chat; sending /btw from the composer opens it too.
 */
export function SideChatControl(props: {
  readonly sideChat: ReturnType<typeof useSideChat>;
  /** What a new question starts, or null where the harness has no side chat. */
  readonly kind: SideChatKind | null;
  readonly cwd: string | undefined;
  readonly onStart: (prompt: string) => void;
}) {
  const { sideChat, kind } = props;
  // Hooks stay above the early return: the same control moves between chats
  // with and without a side chat.
  const inputRef = useRef<HTMLInputElement>(null);
  const shownKind = sideChat.session?.kind ?? kind;
  // A selection sent here while the popover is already open still lands in the box.
  const { quote } = sideChat;
  useEffect(() => {
    const input = inputRef.current;
    if (quote !== null && input !== null && !input.disabled) input.focus({ preventScroll: true });
  }, [quote]);
  if (shownKind === null) return null;
  const title = sideChatTitle(shownKind);
  const toggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={sideChat.isOpen}
      aria-label={sideChat.busy ? `${title}, answering` : title}
      variant="ghost"
      size="sm"
    >
      <MessagesSquareIcon className="size-4" />
      {sideChat.busy ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
        />
      ) : null}
    </Toggle>
  );
  return (
    <Popover open={sideChat.isOpen} onOpenChange={sideChat.setOpen}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={toggle} />} />
        <TooltipPopup side="bottom">{title}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="end"
        padding="none"
        className="w-[min(30rem,calc(100vw-2rem))]"
        // Opening is for asking: focus the question box, not the Close button.
        // While an answer streams the box is disabled, so focus stays put.
        initialFocus={() => {
          const input = inputRef.current;
          if (input !== null && !input.disabled) input.focus({ preventScroll: true });
          return false;
        }}
      >
        <SideChatPanel
          key={sideChat.session?.key ?? "new"}
          inputRef={inputRef}
          session={sideChat.session}
          kind={shownKind}
          cwd={props.cwd}
          onStart={kind === null ? null : props.onStart}
          quote={sideChat.quote}
          onClearQuote={sideChat.clearQuote}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The side chat's conversation, like Claude Code's `/btw` answer. With no
 * side chat yet, or once it has closed, the input starts a new one.
 */
export function SideChatPanel(props: {
  readonly session: SideChatSession | null;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly kind: SideChatKind;
  readonly cwd: string | undefined;
  /** Null where a new side chat can't be started. */
  readonly onStart: ((prompt: string) => void) | null;
  /** Selected answer text the next question is about. */
  readonly quote?: string | null;
  readonly onClearQuote?: () => void;
}) {
  const { session } = props;
  const quote = props.quote ?? null;
  // A sent question takes its quote with it, whichever way the send is confirmed.
  const clearQuoteRef = useRef(props.onClearQuote);
  clearQuoteRef.current = props.onClearQuote;
  const sideChatId = session?.opened?.sideChatId ?? null;
  const live = useEnvironmentQuery(
    sideChatId === null || session === null
      ? null
      : serverEnvironment.sideChatState({
          environmentId: session.environmentId,
          input: { threadId: session.threadRef.threadId },
        }),
  );
  const sendSideChat = useAtomCommand(serverEnvironment.sendSideChat, COMMAND_OPTIONS);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const retryRef = useRef<{
    readonly messageId: string;
    readonly prompt: string;
    readonly draft: string;
  } | null>(null);
  const stateRef = useRef<SideChatState | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // The thread query can still hold the previous exchange after open returns.
  const state =
    (live.data?.sideChatId === sideChatId ? live.data : null) ?? session?.opened ?? null;
  useEffect(() => {
    stateRef.current = state;
    const attempted = retryRef.current;
    if (!attempted || !state?.messages.some((message) => message.id === attempted.messageId))
      return;
    retryRef.current = null;
    sendingRef.current = false;
    setSending(false);
    setSendError(null);
    setDraft((current) => (current === attempted.draft ? "" : current));
    clearQuoteRef.current?.();
  }, [state]);
  const messages = session === null ? [] : sideChatVisibleMessages(state, session.question);
  const busy = session !== null && session.error === null && sideChatIsBusy(state);
  const closed = state?.status === "closed";
  // With no side chat, a closed one, or one that never opened, the input starts a new one.
  const starts = session === null || closed || session.error !== null;
  const error =
    session?.error ??
    sendError ??
    state?.error ??
    (live.failure !== null
      ? sideChatErrorMessage(live.failure)
      : live.error !== null
        ? "The side chat stopped responding."
        : closed
          ? "This side chat has closed."
          : null);
  const canFollowUp = sideChatId !== null && state?.status === "idle" && !sending;
  const canSend = starts ? props.onStart !== null : canFollowUp;
  const title = sideChatTitle(props.kind);

  // Like the Claude app, a new question is followed only until it reaches the top,
  // so a long answer reads from its start. Scrolling up stops that until the next question.
  const lastMessage = messages.at(-1);
  const lastQuestionId = messages.findLast((message) => message.role === "user")?.id ?? null;
  const questionRef = useRef<HTMLParagraphElement>(null);
  const followRef = useRef({ questionId: null as string | null, following: true, top: 0 });
  const scrollKey = `${messages.length}:${lastMessage?.text.length ?? 0}:${lastMessage?.activities.length ?? 0}`;
  useLayoutEffect(() => {
    const viewport = endRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const follow = followRef.current;
    if (follow.questionId !== lastQuestionId) {
      follow.questionId = lastQuestionId;
      follow.following = true;
    }
    if (!follow.following) return;
    const questionTop = questionRef.current
      ? questionRef.current.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop
      : 0;
    const top = Math.min(viewport.scrollHeight - viewport.clientHeight, questionTop - 4);
    if (top > viewport.scrollTop) viewport.scrollTop = top;
    follow.top = viewport.scrollTop;
  }, [lastQuestionId, scrollKey]);
  useEffect(() => {
    const viewport = endRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const stopFollowingOnScrollUp = () => {
      if (viewport.scrollTop < followRef.current.top - 2) followRef.current.following = false;
    };
    viewport.addEventListener("scroll", stopFollowingOnScrollUp, { passive: true });
    return () => viewport.removeEventListener("scroll", stopFollowingOnScrollUp);
  }, []);

  const submit = async () => {
    const question = draft.trim();
    if (question.length === 0 || !canSend || sendingRef.current) return;
    const prompt = sideChatPromptAbout(quote, question);
    if (starts) {
      sendingRef.current = true;
      setDraft("");
      props.onClearQuote?.();
      props.onStart?.(prompt);
      return;
    }
    if (session === null || sideChatId === null) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const messageId =
      retryRef.current?.prompt === prompt ? retryRef.current.messageId : randomUUID();
    const attempt = { messageId, prompt, draft };
    retryRef.current = attempt;
    const result = await sendSideChat({
      environmentId: session.environmentId,
      input: { sideChatId, prompt, messageId },
    });
    // A live acknowledgement can release this send before its RPC returns.
    // Its late result must not unlock or overwrite the next question.
    if (retryRef.current !== attempt) return;
    sendingRef.current = false;
    setSending(false);
    if (
      result._tag === "Success" ||
      stateRef.current?.messages.some((message) => message.id === messageId)
    ) {
      retryRef.current = null;
      setDraft((current) => (current === attempt.draft ? "" : current));
      clearQuoteRef.current?.();
    } else if (!isAtomCommandInterrupted(result)) {
      setSendError(sideChatErrorMessage(squashAtomCommandFailure(result)));
    }
  };
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <div role="region" aria-label={title} className="flex flex-col">
      <div className="flex items-center gap-2 py-2 ps-3.5 pe-2 text-sm">
        <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{title}</span>
        {busy ? <span className="text-muted-foreground">· Answering</span> : null}
        <PopoverClose
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="ms-auto"
              aria-label={`Close ${title}`}
            />
          }
        >
          <XIcon className="size-3.5" />
        </PopoverClose>
      </div>
      {session === null ? (
        <p className="px-3.5 pb-2 text-muted-foreground text-xs leading-relaxed">
          {props.kind === "btw"
            ? "A quick question on the side. The agent keeps working and nothing is added to the chat."
            : "A side conversation off this chat. The agent keeps working and the workspace is left alone."}
        </p>
      ) : (
        <ScrollArea scrollFade radius="none" className="h-auto max-h-[min(28rem,60vh)]">
          <div className="flex flex-col gap-2 px-3.5 pb-2 text-sm [[data-has-overflow-y]>&]:pe-5">
            {messages.map((message) =>
              message.role === "user" ? (
                <SideChatQuestion
                  key={message.id}
                  ref={message.id === lastQuestionId ? questionRef : undefined}
                  text={message.text}
                />
              ) : (
                <div key={message.id} className="flex min-w-0 flex-col gap-1">
                  {message.activities.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {message.activities.map((activity) => (
                        <SideChatActivityLine key={activity.id} activity={activity} />
                      ))}
                    </ul>
                  ) : null}
                  {message.text.trim().length > 0 ? (
                    <ChatMarkdown
                      text={message.text}
                      cwd={props.cwd}
                      threadRef={session.threadRef}
                      isStreaming={message.status === "streaming"}
                      lineBreaks
                    />
                  ) : null}
                  {message.status === "failed" ? (
                    <p className="text-destructive text-xs">This answer failed.</p>
                  ) : null}
                </div>
              ),
            )}
            {error !== null ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
            <div ref={endRef} />
          </div>
        </ScrollArea>
      )}
      <div className="px-2 pt-1 pb-2">
        {quote !== null ? (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-md border-border border-s-2 bg-muted/50 py-1 ps-2 pe-1 text-muted-foreground text-xs">
            <QuoteIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
              {quote}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove the selected text"
              onClick={props.onClearQuote}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : null}
        <Input
          ref={props.inputRef}
          size="compact"
          value={draft}
          disabled={!canSend}
          aria-label={`Message ${title}`}
          placeholder={
            busy || sending
              ? "Waiting for the answer…"
              : quote !== null
                ? "Ask about the selection"
                : closed
                  ? "Ask again to start a new one"
                  : props.kind === "btw"
                    ? session === null
                      ? "Ask a side question"
                      : "Ask another side question"
                    : session === null
                      ? "Start a side chat"
                      : "Message the side chat"
          }
          onValueChange={(value) => setDraft(value)}
          onKeyDown={handleInputKeyDown}
        />
      </div>
    </div>
  );
}

/** A side question; one about selected text shows that text as a quiet quote above it. */
function SideChatQuestion(props: {
  readonly text: string;
  readonly ref?: Ref<HTMLParagraphElement> | undefined;
}) {
  const { quote, question } = splitSideChatQuote(props.text);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {quote !== null ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words border-border border-s-2 ps-2 text-muted-foreground text-xs leading-relaxed">
          {quote}
        </p>
      ) : null}
      <p ref={props.ref} className="whitespace-pre-wrap break-words font-medium text-foreground">
        {question}
      </p>
    </div>
  );
}

function SideChatActivityLine({ activity }: { readonly activity: SideChatActivity }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      {activity.status === "running" ? (
        <Spinner size="xs" />
      ) : activity.status === "failed" ? (
        <CircleXIcon aria-hidden className="size-3 shrink-0 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="min-w-0 truncate">{activity.label}</span>
    </li>
  );
}

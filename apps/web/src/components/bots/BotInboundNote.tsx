import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BOT_EVENT_PHRASES } from "@t3tools/client-runtime/state/bots";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { BotWakeItem } from "@t3tools/shared/bots";

import { useLinkedThreadShell } from "../../state/entities";

/**
 * Notes that reached a bot from SSHCode or another chat: a centered muted pill naming where it
 * came from (the chat's title opens it), with any text below in a soft bubble.
 */
export function BotInboundNotes(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<BotWakeItem>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <div data-bot-inbound-note className="flex flex-col items-center gap-2 py-1">
      {noteKeys(props.items).map((key, index) => (
        <BotInboundNoteItem
          key={key}
          environmentId={props.environmentId}
          item={props.items[index]!}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </div>
  );
}

/** Notes carry no ids; their content keys them, with a count for exact repeats. */
function noteKeys(items: ReadonlyArray<BotWakeItem>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base =
      item.kind === "event"
        ? `event:${item.threadId}:${item.event}`
        : item.kind === "message"
          ? `message:${item.threadId}:${item.text}`
          : `routine:${item.text}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}

function BotInboundNoteItem(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BotWakeItem;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const text = item.kind === "event" ? item.detail : item.text;
  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-muted/70 px-2.5 py-0.5 text-xs text-muted-foreground">
        {item.kind === "routine" ? (
          "Routine missed while paused"
        ) : item.kind === "message" ? (
          <>
            From{" "}
            <ChatTitleLink
              environmentId={props.environmentId}
              threadId={item.threadId}
              title={item.title}
              onOpenThread={props.onOpenThread}
            />
          </>
        ) : (
          <>
            <ChatTitleLink
              environmentId={props.environmentId}
              threadId={item.threadId}
              title={item.title}
              onOpenThread={props.onOpenThread}
            />{" "}
            {BOT_EVENT_PHRASES[item.event]}
            {item.count !== undefined && item.count > 1 ? ` (${item.count})` : ""}
          </>
        )}
      </span>
      {text ? (
        <p className="max-w-[min(32rem,85%)] whitespace-pre-wrap break-words rounded-2xl bg-muted/45 px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {text}
        </p>
      ) : null}
    </div>
  );
}

/** The chat's title, opening it when the chat still exists; plain text otherwise. */
function ChatTitleLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly title: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = ThreadId.make(props.threadId);
  const shell = useLinkedThreadShell(scopeThreadRef(props.environmentId, threadId));
  const title = shell?.title.trim() || props.title.trim() || "a chat";
  if (shell === null) return <span className="truncate font-medium">{title}</span>;
  return (
    <button
      type="button"
      onClick={() => props.onOpenThread(threadId)}
      className="cursor-pointer truncate rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {title}
    </button>
  );
}

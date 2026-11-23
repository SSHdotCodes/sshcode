import {
  formatProviderSubagentStatus,
  formatRelayedSentAt,
  type ProviderSubagentStatus,
  type RelayedSubagentMessage,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { ArrowUpIcon, ArrowUpLeftIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * Stands in for the composer on a provider-native subagent thread. The
 * provider runs that conversation, so a message goes through the parent chat;
 * the bar says which model is working, for how long, and leads back to the
 * parent.
 */
export function ProviderSubagentBar(props: {
  /** The provider running the subagent; no icon while its catalog loads. */
  readonly provider: ProviderInstanceEntry | null;
  /** Several accounts on this provider: badge the glyph, as the composer does. */
  readonly showInstanceBadge: boolean;
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
  /** Sends a message through the parent chat; resolves false when it didn't go. */
  readonly onSendThroughParent: ((text: string) => Promise<boolean>) | null;
  /** What this device sent through the parent, oldest first. */
  readonly sentThroughParent: ReadonlyArray<RelayedSubagentMessage>;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Only decides whether a sent time needs its date; a mounted day is fine.
  const [labelNow] = useState(() => Date.now());
  const { onSendThroughParent } = props;
  const send = async () => {
    const text = draft.trim();
    if (text === "" || sending || onSendThroughParent === null) return;
    setSending(true);
    try {
      if (await onSendThroughParent(text)) setDraft("");
    } finally {
      setSending(false);
    }
  };
  const { status } = props;
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  // Announced once per transition; the ticking label below is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // The label is written from an effect, and live bars tick through DOM
  // writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <div className="flex flex-col gap-1 rounded-3xl py-2 ps-5 pe-2 text-sm">
      {props.sentThroughParent.length === 0 ? null : (
        <ol
          aria-label="Messages sent through the parent"
          className="flex flex-col items-end gap-1.5"
        >
          {props.sentThroughParent.map((message) => (
            <li
              key={message.sentAt}
              className="max-w-[85%] rounded-2xl bg-muted px-3 py-1.5 text-foreground"
            >
              <p className="line-clamp-4 break-words whitespace-pre-wrap">{message.text}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sent through the parent · {formatRelayedSentAt(message.sentAt, labelNow)}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className="flex min-h-8 items-center gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {props.provider ? (
            <ProviderInstanceIcon
              driverKind={props.provider.driverKind}
              displayName={props.provider.displayName}
              accentColor={props.provider.accentColor}
              acpRegistryAgentId={props.provider.acpRegistryAgentId}
              acpRegistryIconUrl={props.provider.acpRegistryIconUrl}
              showBadge={props.showInstanceBadge}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground">{props.modelLabel}</span>
          {props.effortLabel === null ? null : (
            <span className="shrink-0 text-muted-foreground">{props.effortLabel}</span>
          )}
        </span>
        <span
          ref={statusRef}
          aria-hidden
          className="min-w-0 truncate text-muted-foreground tabular-nums"
        />
        <span role="status" className="sr-only">
          {`${modelDescription} subagent: ${announcement}`}
        </span>
        <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">
          {onSendThroughParent === null ? "Runs on its own" : null}
        </span>
        {props.onOpenParent ? (
          <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
            <ArrowUpLeftIcon />
            Open parent
          </Button>
        ) : null}
      </div>
      {onSendThroughParent === null ? null : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
            aria-label="Message this subagent"
            placeholder="Message this subagent through its parent"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send to subagent"
            disabled={sending || draft.trim() === ""}
          >
            <ArrowUpIcon />
          </Button>
        </form>
      )}
    </div>
  );
}

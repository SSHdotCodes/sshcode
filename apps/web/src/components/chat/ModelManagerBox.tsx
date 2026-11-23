import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelManagerReply,
} from "@t3tools/contracts";
import {
  modelManagerBoxView,
  modelManagerQuestionAnswers,
  toggleModelManagerOption,
} from "@t3tools/client-runtime/model-manager-box";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { SecretRequestCard } from "./SecretRequestCard";

export function ModelManagerBox(props: {
  environmentId: EnvironmentId;
  reply: ModelManagerReply;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
  /** Shown at the start of the status row, so the box needs no row of its own for it. */
  leading?: ReactNode;
}) {
  const state = useEnvironmentThread(props.environmentId, props.reply.threadId);
  const projection = Option.getOrNull(state.data);
  const view = modelManagerBoxView(projection, props.reply);
  const allowed = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const respond = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  // The box sits under the model list. Open in full it left the list one row,
  // so it starts as three short rows and shows the whole exchange on request.
  const [expanded, setExpanded] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = projection?.messages;
  useEffect(() => {
    // Only the whole exchange scrolls; the short form is a single line.
    if (!messages || !expanded) return;
    const node = transcript.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [expanded, messages]);
  const submit = async () => {
    if (!text.trim() || props.sending || !allowed) return;
    if (await props.onSend(text)) setText("");
  };
  return (
    <div
      className="flex max-h-44 min-h-0 flex-col gap-2"
      aria-label="Models assistant"
      data-model-manager-status={view.status}
    >
      <div className="flex min-w-0 items-center gap-2">
        {props.leading}
        {/* The step under way says more than "Updating models…"; both fit one row only in turn. */}
        <p role="status" className="min-w-0 flex-1 truncate">
          {view.activity && view.activity !== "Working…" ? view.activity : view.label}
        </p>
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <div
          ref={transcript}
          onScroll={(event) => {
            const node = event.currentTarget;
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
          }}
          className={cn(
            "min-w-0 flex-1",
            expanded &&
              "max-h-20 overflow-y-auto overscroll-contain break-words whitespace-pre-wrap [scrollbar-width:thin]",
          )}
          tabIndex={0}
          aria-label="Models transcript"
        >
          {(expanded ? view.messages : view.messages.slice(-1)).map((message) => (
            <div key={message.id} className={cn("text-foreground", expanded ? "mb-2" : "truncate")}>
              <span className="text-muted-foreground">
                {message.role === "user" ? "You" : "Models"}:{" "}
              </span>
              {message.text}
            </div>
          ))}
          {projection === null ? <p>Loading assistant…</p> : null}
        </div>
        {view.messages.length > 0 ? (
          <InlineButton
            tone="muted"
            aria-expanded={expanded}
            aria-label={expanded ? "Show less of the exchange" : "Show the whole exchange"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Less" : "More"}
          </InlineButton>
        ) : null}
      </div>
      <div className="max-h-24 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
        {view.pending.approvals.map((approval) => (
          <div key={approval.requestId} className="flex flex-wrap gap-2">
            <ComposerPendingApprovalPanel
              approval={approval}
              pendingCount={view.pending.approvals.length}
            />
            <ComposerPendingApprovalActions
              requestId={approval.requestId}
              isResponding={busy}
              canRespond={approval.responseCapability === "live"}
              disabled={!allowed}
              options={approval.options}
              onRespondToApproval={async (requestId, decision) => {
                if (inFlight.current) return;
                inFlight.current = true;
                setBusy(true);
                const result = await respond({
                  environmentId: props.environmentId,
                  input: { threadId: props.reply.threadId, requestId, decision },
                });
                inFlight.current = false;
                setBusy(false);
                setError(
                  result._tag === "Success" || isAtomCommandInterrupted(result)
                    ? null
                    : "Could not send the answer. Try again.",
                );
              }}
            />
          </div>
        ))}
        {view.pending.userInputs.map((request) => (
          <ModelManagerQuestion
            key={request.requestId}
            environmentId={props.environmentId}
            reply={props.reply}
            request={request}
          />
        ))}
        {view.secrets.map((row) =>
          row.item.type === "secret_request" ? (
            <SecretRequestCard
              key={row.item.id}
              environmentId={props.environmentId}
              item={row.item}
              visibility={row.visibility}
            />
          ) : null,
        )}
      </div>
      {error || Option.getOrNull(state.error) ? (
        <p role="alert">{error ?? Option.getOrNull(state.error)}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          aria-label="Reply to Models"
          className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          placeholder="Reply or ask for another change"
          value={text}
          disabled={!allowed}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <InlineButton disabled={!allowed || props.sending || !text.trim()} onClick={submit}>
          {props.sending ? "Sending…" : "Send"}
        </InlineButton>
      </div>
    </div>
  );
}

function ModelManagerQuestion(props: {
  environmentId: EnvironmentId;
  reply: ModelManagerReply;
  request: ThreadPendingUserInput;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const answers = modelManagerQuestionAnswers(props.request, selected, custom);
  const disabled = busy || !allowed || props.request.responseCapability === "not_resumable";
  return (
    <div className="flex flex-col gap-2" aria-label="Models question">
      {props.request.questions.map((question) => (
        <fieldset key={question.id} disabled={disabled} className="flex flex-col gap-1">
          <legend className="mb-1 text-foreground">{question.question}</legend>
          {question.options.map((option) => {
            const value = option.value ?? option.label;
            return (
              <label key={value} className="flex items-start gap-1.5">
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={`${props.request.requestId}:${question.id}`}
                  checked={(selected[question.id] ?? []).includes(value)}
                  onChange={() => {
                    setSelected((current) => ({
                      ...current,
                      [question.id]: toggleModelManagerOption(
                        current[question.id] ?? [],
                        value,
                        question.multiSelect,
                      ),
                    }));
                    setCustom((current) => ({ ...current, [question.id]: "" }));
                  }}
                />
                <span>
                  {option.label}
                  {option.description ? (
                    <span className="block text-muted-foreground">{option.description}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {question.allowCustomAnswer !== false ? (
            <input
              aria-label={`Answer: ${question.header}`}
              className="rounded-md border border-border/70 bg-background px-2 py-1 text-foreground"
              placeholder="Your answer"
              value={custom[question.id] ?? question.initialAnswer ?? ""}
              onChange={(event) =>
                setCustom((current) => ({ ...current, [question.id]: event.target.value }))
              }
            />
          ) : null}
        </fieldset>
      ))}
      {props.request.responseCapability === "not_resumable" ? (
        <p>This request is no longer available. Send a reply to try again.</p>
      ) : null}
      <InlineButton
        disabled={disabled || answers === null}
        onClick={async () => {
          if (answers === null || inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          const result = await respond({
            environmentId: props.environmentId,
            input: { threadId: props.reply.threadId, requestId: props.request.requestId, answers },
          });
          inFlight.current = false;
          setBusy(false);
          setError(
            result._tag === "Success" || isAtomCommandInterrupted(result)
              ? null
              : "Could not send the answer. Try again.",
          );
        }}
      >
        {busy ? "Sending…" : "Answer"}
      </InlineButton>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

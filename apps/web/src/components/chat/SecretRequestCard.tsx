import { ApiKeyExpiryPicker } from "./ApiKeyExpiryPicker";
import { useAtomValue } from "@effect/atom-react";
import type { ApiKeyScope } from "@t3tools/contracts";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestPrivacyNote,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkLogRow } from "./WorkLog";

/**
 * Inline card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * toasted, or persisted, and the field clears once the answer is sent.
 */
export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const allowed = useAtomValue(
    serverEnvironment.answerSecretRequest.permissionAtom(props.environmentId),
  );
  const [openedAt] = useState(Date.now);
  const [revealed, setRevealed] = useState(false);
  const [scope, setScope] = useState<ApiKeyScope>(item.apiKey?.suggestedScope ?? "chat");
  const [expiresAt, setExpiresAt] = useState<number | null>(() =>
    item.apiKey?.suggestedExpiresAt === undefined
      ? openedAt + 30 * 86_400_000
      : item.apiKey.suggestedExpiresAt,
  );
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(
      item,
      reply.type === "save" && item.apiKey !== undefined ? { ...reply, scope, expiresAt } : reply,
    );
    if (input === null || inFlight.current || !allowed) return;
    if (
      reply.type === "save" &&
      item.apiKey !== undefined &&
      expiresAt !== null &&
      expiresAt <= Date.now()
    ) {
      setError("Choose an expiry in the future, or Never.");
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setSecret("");
      setRevealed(false);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", secret });
  };

  // Same hierarchy as a chat card: what is asked, why, the field, then the
  // promise about where the value goes.
  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      // A click anywhere on the card targets its field, so a paste that
      // follows lands here rather than with the composer.
      onPointerDown={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest("input, button, a, select")) return;
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {item.label}
        </label>
        {item.apiKey ? (
          <p className="font-mono text-xs text-muted-foreground">{item.apiKey.name}</p>
        ) : null}
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={inputId}
            type={revealed ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Password managers otherwise offer to save or fill this field.
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            value={secret}
            disabled={submitting || !allowed}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        </div>
        <Button
          type="button"
          variant="ghost-muted"
          disabled={submitting || !allowed}
          aria-label={revealed ? "Hide key" : "Reveal key"}
          aria-pressed={revealed}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? "Hide" : "Show"}
        </Button>
        <Button
          type="submit"
          disabled={
            submitting ||
            !allowed ||
            secret.trim().length === 0 ||
            (item.apiKey !== undefined && expiresAt !== null && expiresAt <= openedAt)
          }
        >
          Save
        </Button>
      </div>
      {item.apiKey ? (
        <div className="flex flex-col gap-3">
          <div role="group" aria-label="API key scope" className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={scope === "chat" ? "secondary" : "outline"}
              aria-pressed={scope === "chat"}
              disabled={submitting || !allowed}
              onClick={() => setScope("chat")}
            >
              This chat only
            </Button>
            <Button
              type="button"
              size="sm"
              variant={scope === "all" ? "secondary" : "outline"}
              aria-pressed={scope === "all"}
              disabled={submitting || !allowed}
              onClick={() => setScope("all")}
            >
              All sessions
            </Button>
          </div>
          <ApiKeyExpiryPicker
            value={expiresAt}
            onChange={setExpiresAt}
            disabled={submitting || !allowed}
          />
        </div>
      ) : null}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting || !allowed}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

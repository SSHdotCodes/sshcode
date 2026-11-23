import {
  type EnvironmentId,
  type ModelManagerReply,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canAddModelsTo,
  defaultModelManagerHarness,
  modelManagerRequestText,
  type ModelRef,
} from "@t3tools/shared/modelRefs";
import { type KeyboardEvent, type SyntheticEvent, useState, useRef } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { ModelManagerBox } from "./ModelManagerBox";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";

/** Harnesses a model can be added to: local ones that are on, plus Pi or OpenCode when off. */
export function modelManagerHarnesses(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ProviderInstanceEntry[] {
  return entries.filter((entry) =>
    canAddModelsTo({
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      enabled: entry.enabled,
    }),
  );
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "error"; readonly message: string };

// The picker is a combobox: keys and clicks here must not drive its list.
const keepInPanel = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The model list's footer, shown only when in use: the form the search bar's + opens
 * (paste a model id or URL, or "remove …", and pick a harness), the Models helper's box
 * while it works, or "Add <id> to <harness>" when the search names an unlisted model.
 */
export function ModelManagerPanel(props: {
  environmentId: EnvironmentId;
  harnesses: ReadonlyArray<ProviderInstanceEntry>;
  /** The harness being browsed in the sidebar, if any. */
  browsingInstanceId: string | null;
  /** A model the search names that no harness lists yet. */
  searchedModel: { readonly ref: ModelRef; readonly query: string } | null;
  /** The add/remove form, opened from the search bar's + button. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestClose?: (() => void) | undefined;
}) {
  const { open, onOpenChange: setOpen } = props;
  const helperRef = useAtomValue(
    environmentThreadShells.modelManagerThreadRefAtom(props.environmentId),
  );
  const inFlight = useRef(false);
  const [reply, setReply] = useState<ModelManagerReply | null>(null);
  const requestModelChange = useAtomCommand(serverEnvironment.requestModelChange, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const harnessId =
    instanceId !== null && props.harnesses.some((entry) => entry.instanceId === instanceId)
      ? instanceId
      : defaultModelManagerHarness(
          props.harnesses.map((entry) => ({
            instanceId: entry.instanceId,
            driver: entry.driverKind,
            enabled: entry.enabled,
          })),
          props.browsingInstanceId,
        );
  const harness = props.harnesses.find((entry) => entry.instanceId === harnessId) ?? null;

  if (props.harnesses.length === 0) return null;

  const submit = async (requestText: string): Promise<boolean> => {
    if (harness === null || requestText.trim().length === 0 || inFlight.current) return false;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    const result = await requestModelChange({
      environmentId: props.environmentId,
      input: { text: modelManagerRequestText(requestText), instanceId: harness.instanceId },
    });
    inFlight.current = false;
    if (result._tag === "Success") {
      setPhase({ kind: "sent" });
      setReply(result.value);
      setText("");
      setOpen(false);
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      setPhase({ kind: "idle" });
      return false;
    }
    const error = squashAtomCommandFailure(result);
    setPhase({
      kind: "error",
      message: error instanceof Error ? error.message : "The request didn't reach the server.",
    });
    return false;
  };

  const harnessSelect = (
    <select
      aria-label="Harness"
      className="h-6.5 max-w-36 shrink-0 cursor-pointer truncate rounded-md border border-border/70 bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      value={harnessId ?? ""}
      onChange={(event) => setInstanceId(event.target.value as ProviderInstanceId)}
      onKeyDown={keepInPanel}
      onMouseDown={keepInPanel}
    >
      {props.harnesses.map((entry) => (
        <option key={entry.instanceId} value={entry.instanceId}>
          {entry.enabled ? entry.displayName : `${entry.displayName} (off)`}
        </option>
      ))}
    </select>
  );

  let body;
  const activeReply =
    reply ??
    (helperRef
      ? { threadId: helperRef.threadId, delivery: "started" as const, runId: null }
      : null);
  if (activeReply !== null && !open && (phase.kind !== "idle" || props.searchedModel === null)) {
    body = (
      <ModelManagerBox
        key={activeReply.threadId}
        environmentId={props.environmentId}
        reply={activeReply}
        sending={phase.kind === "sending"}
        onSend={submit}
        leading={
          <>
            <span>In</span>
            {harnessSelect}
          </>
        }
      />
    );
  } else if (props.searchedModel !== null && !open) {
    const { ref, query } = props.searchedModel;
    body = (
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          Add <span className="font-medium text-foreground">{ref.id}</span> to
        </span>
        {harnessSelect}
        <InlineButton disabled={phase.kind === "sending"} onClick={() => submit(query)}>
          {phase.kind === "sending" ? "Adding…" : "Add"}
        </InlineButton>
      </div>
    );
  } else if (open) {
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        submit(text);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    body = (
      <div className="flex flex-col gap-1.5">
        <input
          autoFocus
          aria-label="Model to add or remove"
          className="h-6.5 w-full min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          placeholder="Model id or URL to add, or “remove …”"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onMouseDown={keepInPanel}
        />
        <div className="flex items-center gap-2">
          <span>In</span>
          {harnessSelect}
          <span className="flex-1" />
          <InlineButton onClick={() => setOpen(false)}>Cancel</InlineButton>
          <InlineButton
            disabled={phase.kind === "sending" || text.trim().length === 0}
            onClick={() => submit(text)}
          >
            {phase.kind === "sending" ? "Sending…" : "Go"}
          </InlineButton>
        </div>
      </div>
    );
  } else if (phase.kind !== "error") {
    return null;
  }

  return (
    <div
      className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      data-model-manager
      onKeyDown={keepInPanel}
      onKeyUp={keepInPanel}
      onClick={keepInPanel}
      onMouseDown={keepInPanel}
      onTouchStart={keepInPanel}
    >
      {body}
      {phase.kind === "error" ? (
        <p className="mt-1 line-clamp-2 text-destructive-foreground">{phase.message}</p>
      ) : null}
    </div>
  );
}

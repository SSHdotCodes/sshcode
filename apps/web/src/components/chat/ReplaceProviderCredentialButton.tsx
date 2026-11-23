import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type ProviderCredentialRecovery,
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { newMessageId } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** Keeps credential entry local to the latest failed run, including on desktop. */
export function ReplaceProviderCredentialButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
}) {
  const run = useAtomValue(environmentThreadDetails.threadAtom(props.threadRef), (detail) => {
    const latest = detail?.projection.runs.at(-1);
    return latest?.id === props.runId && latest.status === "failed" ? latest : null;
  });
  const thread = useAtomValue(
    environmentThreadDetails.threadAtom(props.threadRef),
    (detail) => detail?.projection.thread ?? null,
  );
  const latestFailed = useAtomValue(
    environmentThreadShells.threadShellAtom(props.threadRef),
    (shell) => shell?.latestRun?.runId === props.runId && shell.latestRun.status === "failed",
  );
  const allowed = useAtomValue(
    serverEnvironment.replaceProviderCredential.permissionAtom(props.threadRef.environmentId),
  );
  const [open, setOpen] = useState(false);
  if (
    !allowed ||
    !latestFailed ||
    thread === null ||
    run?.id !== props.runId ||
    run.status !== "failed" ||
    run.credentialRecovery === undefined
  )
    return null;

  return (
    <>
      <Button type="button" size="xs" onClick={() => setOpen(true)}>
        Replace API key
      </Button>
      {open ? (
        <ReplaceCredentialDialog
          key={run.credentialRecovery.credentialRef}
          threadRef={props.threadRef}
          run={run}
          thread={thread}
          recovery={run.credentialRecovery}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ReplaceCredentialDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly run: OrchestrationV2Run;
  readonly thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">;
  readonly recovery: ProviderCredentialRecovery;
  readonly onClose: () => void;
}) {
  // Credential-bearing failures stay out of the command reporter.
  const registry = useContext(RegistryContext);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
    reportDefect: false,
  });
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const close = () => {
    active.current = false;
    setValue("");
    props.onClose();
  };
  const submit = async () => {
    if (inFlight.current || (!saved && !value.trim())) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let keySaved = saved;
    try {
      if (!keySaved) {
        const result = await serverEnvironment.replaceProviderCredential.run(registry, {
          environmentId: props.threadRef.environmentId,
          input: { credentialRef: props.recovery.credentialRef, value: value.trim() },
        });
        if (result._tag !== "Success") {
          if (active.current) setError("Could not save the API key. Try again.");
          return;
        }
        keySaved = true;
        setValue("");
        setSaved(true);
      }
      if (!active.current) return;
      const result = await startTurn({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "Continue.",
            attachments: [],
          },
          modelSelection: props.run.modelSelection,
          runtimeMode: props.thread.runtimeMode,
          interactionMode: props.thread.interactionMode,
          dispatchMode: "auto",
        },
      });
      if (!active.current) return;
      if (result._tag === "Success") close();
      else setError("Key saved. Could not retry. Try again.");
    } catch {
      if (active.current)
        setError(
          keySaved
            ? "Key saved. Could not retry. Try again."
            : "Could not save the API key. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Replace API key</DialogTitle>
            <DialogDescription>{props.recovery.label}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {props.recovery.consoleUrl ? (
              <Button
                variant="link"
                render={
                  <a href={props.recovery.consoleUrl} target="_blank" rel="noopener noreferrer" />
                }
              >
                Get API key
              </Button>
            ) : null}
            {props.recovery.alsoUsedBy.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Also used by: {props.recovery.alsoUsedBy.join(", ")}
              </p>
            ) : null}
            {!saved ? (
              <label className="block space-y-2 text-sm">
                <span>New API key</span>
                <Input
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">API key saved.</p>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (!saved && !value.trim())}>
              {busy ? (saved ? "Retrying…" : "Saving…") : saved ? "Retry" : "Save and retry"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

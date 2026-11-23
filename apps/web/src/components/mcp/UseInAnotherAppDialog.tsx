import { useAtomValue } from "@effect/atom-react";
import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import {
  AuthAccessReadScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type OutsideAgentSignIn,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useCopyToClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "~/state/environments";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import { relayEnvironmentDiscovery } from "~/state/relay";
import {
  useEnvironmentScope,
  useEnvironmentSessionState,
  usePreparedConnection,
} from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { AgentAccessPicker } from "../auth/AgentAccessPicker";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { OutsideAgentApproval } from "../OutsideAgentApproval";
import { DEFAULT_OUTSIDE_AGENT_ACCESS, useOutsideAgents } from "../OutsideAgentPrompt";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { MCP_APPS, OTHER_MCP_APPS, type McpApp, mcpHandoffAction } from "./mcpApps";
import { rememberMcpApprovalPreference } from "./mcpApprovalPreference";
import {
  canSuggestMcpAccess,
  mcpSignInCompleted,
  resolveMcpGate,
  resolvePublicMcpUrl,
  type McpApprovalPreference,
} from "./mcpGate";
import { mcpCloudTarget } from "./mcpCloudTarget";
import { activeMcpSetupEnvironmentAtom, closeMcpSetup, mcpSetupRequestAtom } from "./mcpSetupState";

export { openUseInAnotherApp } from "./mcpSetupState";

export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(mcpSetupRequestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [externalAuth, setExternalAuth] = useState(false);
  const environment =
    environments.find((item) => item.environmentId === (requested ?? primaryId)) ??
    (requested === null
      ? environments.find((item) => item.connection.phase === "connected")
      : undefined);
  return (
    <Dialog
      open
      modal={!externalAuth}
      disablePointerDismissal={externalAuth}
      onOpenChange={(open, details) => {
        // Clerk owns focus while its sign-in is open. Explicitly closing this wizard still works.
        if (
          !open &&
          details.reason !== "focus-out" &&
          (!externalAuth || details.reason === "close-press")
        )
          closeMcpSetup();
      }}
    >
      <WizardPopup>
        {environment ? (
          <Wizard
            key={environment.environmentId}
            environment={environment}
            onAuthPrompt={setExternalAuth}
          />
        ) : (
          <>
            <WizardHeader title="Use SSHCode in another app (MCP)" />
            <WizardPanel>
              <p>Connect to a computer first.</p>
            </WizardPanel>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

type Step = 0 | 1 | 2;
const STEPS = ["App", "Access", "Connect"] as const;

function Wizard({
  environment,
  onAuthPrompt,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onAuthPrompt: (open: boolean) => void;
}) {
  const environmentId = environment.environmentId;
  const outside = useOutsideAgents(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const canEnable = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const startSignIns = useAtomCommand(serverEnvironment.outsideAgentsCommand, {
    reportFailure: false,
  });
  const refreshRelay = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const relay = useRelayEnvironmentDiscovery();
  const prepared = usePreparedConnection(environmentId);
  const cloudTarget = useMemo(() => mcpCloudTarget(Option.getOrNull(prepared)), [prepared]);
  const [step, setStep] = useState<Step>(0);
  const [showOther, setShowOther] = useState(false);
  const [choice, setChoice] = useState<McpApp | null>(null);
  const [picked, setPicked] = useState<AuthMcpClientAccess>(DEFAULT_OUTSIDE_AGENT_ACCESS);
  const [busy, setBusy] = useState(false);
  const [continuationRequested, setContinuationRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInWindow, setSignInWindow] = useState<McpApprovalPreference | null>(null);
  const [approvedSignIn, setApprovedSignIn] = useState<OutsideAgentSignIn | null>(null);
  const [connectionTimedOut, setConnectionTimedOut] = useState(false);
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const authAccess = useEnvironmentQuery(
    canReadAccess ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const connected = mcpSignInCompleted(
    authAccess.data?.type === "snapshot" ? authAccess.data.payload.clientSessions : [],
    approvedSignIn,
  );
  useEffect(() => {
    if (approvedSignIn === null || connected || !canReadAccess) return;
    const timer = globalThis.window.setTimeout(() => setConnectionTimedOut(true), 60_000);
    return () => globalThis.window.clearTimeout(timer);
  }, [approvedSignIn, connected, canReadAccess]);

  useEffect(() => {
    appAtomRegistry.set(activeMcpSetupEnvironmentAtom, environmentId);
    return () => appAtomRegistry.set(activeMcpSetupEnvironmentAtom, null);
  }, [environmentId]);
  useEffect(() => {
    if (hasCloudPublicConfig()) void refreshRelay();
  }, [refreshRelay]);

  const relayEntry = relay.environments.get(environmentId);
  const publicUrl =
    relayEntry?.availability === "online"
      ? resolvePublicMcpUrl({ relayBaseUrl: relayEntry.environment.endpoint.httpBaseUrl })
      : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    relayHttpBaseUrl: choice?.publicAddress ? (publicUrl ?? undefined) : undefined,
    connectedTarget: Option.isSome(prepared) ? prepared.value.target : null,
  });
  const access = canSuggestMcpAccess(session.data, picked) ? picked : "read-only";
  const gate = resolveMcpGate({
    connected: environment.connection.phase === "connected",
    canAccept: outside.allowed,
    canEnable,
    outsideAgents: environment.serverConfig?.settings.outsideAgents,
    mcpUrl,
    publicUrl,
    connectAvailable: hasCloudPublicConfig(),
    needsPublicUrl: choice?.publicAddress ?? false,
  });
  const pendingId = outside.pending[0]?.id;
  useEffect(() => {
    if (!pendingId) return;
    // Bring the code entry forward without displaying a request's self-declared identity.
    if (globalThis.window.desktopBridge?.focusNotificationWindow)
      void globalThis.window.desktopBridge.focusNotificationWindow().catch(() => undefined);
    else globalThis.window.focus();
  }, [pendingId]);

  const start = async () => {
    setContinuationRequested(false);
    setBusy(true);
    setError(null);
    const result = await startSignIns({ environmentId, input: { _tag: "accept-new" } });
    if (result._tag === "Success" && result.value.acceptingUntil !== null) {
      // Both bounds come from the server, so remote clocks do not select an older request.
      const next = {
        access,
        startedAt: signInWindow?.startedAt ?? result.value.acceptingUntil - 10 * 60_000,
        expiresAt: result.value.acceptingUntil,
      };
      setSignInWindow(next);
      rememberMcpApprovalPreference(environmentId, next);
      setStep(2);
    } else setError("Could not start sign-ins. Try again.");
    setBusy(false);
  };
  const continueWhenReady = useEffectEvent(() => {
    if (continuationRequested && gate === "open" && !busy && step === 1) void start();
  });
  // oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- runs the owner's queued command after its remote prerequisites change
  useEffect(() => {
    continueWhenReady();
  }, [continuationRequested, gate, busy, step]);
  // oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies

  const turnOnOutside = async () => {
    setBusy(true);
    setError(null);
    setContinuationRequested(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { outsideAgents: true } },
    });
    if (result._tag !== "Success") {
      setContinuationRequested(false);
      setError("Could not turn on outside agents. Try again.");
    }
    setBusy(false);
  };
  const back = () => {
    setContinuationRequested(false);
    setError(null);
    onAuthPrompt(false);
    if (step === 0) setShowOther(false);
    else setStep(step === 2 ? 1 : 0);
  };

  return (
    <>
      <WizardHeader title={`Use SSHCode in another app (MCP) · ${environment.label}`}>
        <WizardSteps
          steps={STEPS}
          currentStep={step}
          isStepDisabled={(index) => busy || approvedSignIn !== null || index > step}
          onStepChange={(index) => {
            setContinuationRequested(false);
            setStep(index as Step);
            setError(null);
          }}
        />
      </WizardHeader>
      <WizardPanel>
        {approvedSignIn !== null ? (
          <section className="flex flex-col items-center gap-3 py-6" role="status">
            {connected || !canReadAccess ? <CheckIcon className="size-8 text-primary" /> : null}
            <h3 className="text-lg font-medium">
              {connected
                ? `Connected to ${approvedSignIn.clientName}`
                : canReadAccess
                  ? `Waiting for ${approvedSignIn.clientName}…`
                  : `Allowed ${approvedSignIn.clientName}`}
            </h3>
          </section>
        ) : step === 0 ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Which app?</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(showOther ? OTHER_MCP_APPS : MCP_APPS).map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => {
                    setChoice(app);
                    setStep(1);
                  }}
                  className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-transparent px-1 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {app.logo ? (
                    <img
                      src={app.logo}
                      alt=""
                      className="size-10 rounded-lg ring-1 ring-black/10 dark:ring-white/12"
                    />
                  ) : (
                    <span
                      className="grid size-10 place-items-center rounded-lg bg-muted text-lg"
                      aria-hidden
                    >
                      …
                    </span>
                  )}
                  <span className="text-xs font-medium">
                    {app.id === "other" ? "Another MCP app" : app.name}
                  </span>
                </button>
              ))}
            </div>
            {!showOther ? (
              <Button variant="outline" onClick={() => setShowOther(true)}>
                Something else…
              </Button>
            ) : null}
          </section>
        ) : step === 1 && choice ? (
          <section className="space-y-3">
            <h3 id="mcp-setup-access-label" className="text-sm font-medium">
              Choose what {choice.name} can do.
            </h3>
            <AgentAccessPicker
              labelledBy="mcp-setup-access-label"
              value={access}
              onChange={setPicked}
              disabled={busy || !outside.allowed}
              descriptions={false}
              disabledReason={(level) =>
                canSuggestMcpAccess(session.data, level)
                  ? undefined
                  : "This device cannot grant this access."
              }
            />
            {gate !== "open" && gate !== "turn-on" && gate !== "public-address-needed" ? (
              <GateMessage gate={gate} name={environment.label} />
            ) : null}
          </section>
        ) : step === 2 && choice && mcpUrl && gate === "open" ? (
          <section className="space-y-4">
            <p className="text-sm">{choice.instruction}</p>
            <Handoff app={choice} mcpUrl={mcpUrl} />
            <OutsideAgentApproval
              pending={outside.pending}
              access={access}
              app={choice}
              disabled={busy || !outside.allowed}
              onAnswer={outside.answer}
              onApproved={(signIn) => {
                setConnectionTimedOut(false);
                setApprovedSignIn(signIn);
              }}
            />
          </section>
        ) : (
          <GateMessage gate={gate} name={environment.label} />
        )}
        {connectionTimedOut && !connected ? (
          <p role="status" className="text-sm text-muted-foreground">
            Could not confirm the connection.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </WizardPanel>
      <WizardFooter>
        {approvedSignIn !== null ? (
          connected || !canReadAccess ? (
            <Button onClick={closeMcpSetup}>Done</Button>
          ) : connectionTimedOut ? (
            <Button
              onClick={() => {
                setApprovedSignIn(null);
                setConnectionTimedOut(false);
                void start();
              }}
            >
              Retry sign-in
            </Button>
          ) : null
        ) : (
          <>
            {step > 0 || showOther ? (
              <Button variant="outline" disabled={busy} onClick={back}>
                Back
              </Button>
            ) : null}
            {step === 1 && gate === "public-address-needed" && hasCloudPublicConfig() ? (
              <PublicAddressButton
                target={cloudTarget}
                onAuthPrompt={onAuthPrompt}
                onAttempt={() => setContinuationRequested(true)}
                onFailure={() => setContinuationRequested(false)}
              />
            ) : step === 1 && gate === "turn-on" ? (
              <Button disabled={busy} onClick={() => void turnOnOutside()}>
                {busy ? "Turning on…" : "Turn on outside agents"}
              </Button>
            ) : step === 1 ? (
              <Button
                disabled={busy || gate !== "open" || !canSuggestMcpAccess(session.data, access)}
                onClick={() => void start()}
              >
                {busy ? "Starting…" : "Next"}
              </Button>
            ) : step === 2 ? (
              <Button variant="outline" disabled={busy} onClick={() => void start()}>
                Retry sign-in
              </Button>
            ) : null}
          </>
        )}
      </WizardFooter>
    </>
  );
}

function GateMessage({
  gate,
  name,
}: {
  readonly gate: ReturnType<typeof resolveMcpGate>;
  readonly name: string;
}) {
  const messages = {
    open: "",
    checking: "Checking access…",
    disconnected: `Connect to ${name} first.`,
    "no-permission": `This device needs permission to manage access on ${name}.`,
    "no-settings-permission": `This device cannot turn on outside agents on ${name}.`,
    "turn-on": "",
    "public-address-needed": "",
    "connect-unavailable": "This build has no T3 Connect address for cloud apps.",
    "no-address": "This connection has no address an outside app can reach.",
  };
  return messages[gate] ? (
    <p role="status" className="text-sm text-muted-foreground">
      {messages[gate]}
    </p>
  ) : null;
}

function PublicAddressButton({
  target,
  onAuthPrompt,
  onAttempt,
  onFailure,
}: {
  readonly target: ReturnType<typeof mcpCloudTarget>;
  readonly onAuthPrompt: (open: boolean) => void;
  readonly onAttempt: () => void;
  readonly onFailure: () => void;
}) {
  const controller = useCloudLinkController(target);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [busy, setBusy] = useState(false);
  const [awaitingAuth, setAwaitingAuth] = useState(false);
  const [waitingForAddress, setWaitingForAddress] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const refreshRelay = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const failAddressWait = useEffectEvent(() => onFailure());
  useEffect(() => {
    if (!waitingForAddress) return;
    const refresh = globalThis.window.setInterval(() => void refreshRelay(), 5_000);
    const timeout = globalThis.window.setTimeout(() => {
      setWaitingForAddress(false);
      setBusy(false);
      setAddressError("Could not reach T3 Connect. Try again.");
      failAddressWait();
    }, 60_000);
    return () => {
      globalThis.window.clearInterval(refresh);
      globalThis.window.clearTimeout(timeout);
    };
  }, [waitingForAddress, refreshRelay]);
  const turnOn = async () => {
    onAttempt();
    if (!controller.isSignedIn) {
      setAwaitingAuth(true);
      onAuthPrompt(true);
      openAuthPrompt();
      return;
    }
    setBusy(true);
    setAddressError(null);
    const ok = await controller.reconcileCloudState({
      managedTunnel: true,
      publish: controller.publishAgentActivity,
      installRelayClient: true,
    });
    if (!ok) {
      onFailure();
      setBusy(false);
    } else setWaitingForAddress(true);
  };
  const resume = useEffectEvent(() => {
    if (!awaitingAuth || !controller.isSignedIn) return;
    onAuthPrompt(false);
    if (controller.linkState.data === null) return;
    setAwaitingAuth(false);
    void turnOn();
  });
  // oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- resumes the owner's request after external sign-in and link-state loading
  useEffect(() => {
    resume();
  }, [awaitingAuth, controller.isSignedIn, controller.linkState.data]);
  // oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies
  return (
    <div className="space-y-2">
      <Button
        disabled={
          busy ||
          target === null ||
          controller.linkState.isPending ||
          (awaitingAuth && controller.isSignedIn)
        }
        onClick={() => void turnOn()}
      >
        {busy
          ? "Connecting…"
          : controller.managedTunnelActive
            ? "Retry T3 Connect"
            : "Turn on T3 Connect"}
      </Button>
      {target === null ? (
        <p className="text-xs text-muted-foreground">This route cannot turn on T3 Connect.</p>
      ) : addressError || controller.operationError ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {addressError ?? controller.operationError}
        </p>
      ) : null}
    </div>
  );
}

function openLink(url: string) {
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not open the link",
        description: error instanceof Error ? error.message : url,
      }),
    );
}

function Handoff({ app, mcpUrl }: { readonly app: McpApp; readonly mcpUrl: string }) {
  const action = mcpHandoffAction(app, mcpUrl);
  const handOff = async () => {
    if (!action) return;
    if (action.copy) {
      const copied = await writeTextToClipboard(action.copy.text, action.copy.title).catch(
        () => false,
      );
      if (!copied) {
        toastManager.add({ type: "error", title: "Could not copy the URL" });
        return;
      }
      toastManager.add({
        type: "success",
        title: "URL copied",
        actionProps: { children: `Open ${app.name}`, onClick: () => openLink(action.link) },
      });
    }
    openLink(action.link);
  };
  if (app.handoff.kind === "commands")
    return <CopyRow label="Command" value={app.handoff.command(mcpUrl)} />;
  return (
    <div className="space-y-3">
      {app.handoff.kind === "copy-url" ? (
        <code className="block break-all rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          {mcpUrl}
        </code>
      ) : (
        <CopyRow label="URL" value={mcpUrl} />
      )}
      {action ? <Button onClick={() => void handOff()}>{action.label}</Button> : null}
    </div>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: label,
    onError: () =>
      toastManager.add({ type: "error", title: `Could not copy ${label.toLowerCase()}` }),
  });
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <code className="min-w-0 flex-1 break-all text-sm">{value}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => copyToClipboard(value, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

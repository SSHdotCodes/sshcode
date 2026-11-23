import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  type AuthMcpClientAccess,
  type AuthMcpAuthorizationRequest,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { requestMcpInAppApproval } from "~/environments/primary/mcpApproval";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { AgentAccessPicker } from "./AgentAccessPicker";
import { AuthSurfaceShell } from "./AuthSurfaceShell";

/** How often the page asks whether the owner answered in the app. */
const IN_APP_POLL_MS = 1_500;

/** A CLI agent's callback is a loopback address; a hosted agent's is its own server. */
function redirectsToThisComputer(redirectHost: string): boolean {
  return isLoopbackHost(new URL(`http://${redirectHost}`).hostname);
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

const UNREACHABLE = "Could not reach this environment. Try again.";
const isApprovalError = Schema.is(AuthMcpApprovalError);

type Answer<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Runs an approval call. The server validates the agent's request again on
 * every call and answers what the page asked for, a message to show, or a URL
 * the browser must follow (an approval, a denial, or a protocol error the
 * agent should receive).
 */
function runApproval<A>(
  call: (
    client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>,
  ) => Effect.Effect<A | { readonly redirectTo: string }, unknown>,
): Promise<Answer<A>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap(call),
      Effect.map((value): Answer<A> =>
        typeof value === "object" && value !== null && "redirectTo" in value
          ? { kind: "redirect", url: value.redirectTo }
          : { kind: "ok", value: value as A },
      ),
      Effect.catch((error) =>
        Effect.succeed<Answer<A>>({
          kind: "error",
          message: isApprovalError(error) ? error.message : UNREACHABLE,
        }),
      ),
    ),
  ).catch((): Answer<A> => ({ kind: "error", message: UNREACHABLE }));
}

function readAuthorizationRequest(): AuthMcpAuthorizationRequest {
  return Object.fromEntries(new URL(window.location.href).searchParams);
}

/**
 * /connect-agent: where an outside agent's MCP sign-in lands after the server
 * checks the request. The user picks the most the agent may allow, then
 * approves with a pairing code, or in one click when this browser is already
 * signed in to the environment as an administrator.
 */
/**
 * Whether this browser's session may approve `access` without a pairing code.
 * A session may only grant access whose scopes it holds itself.
 */
function oneClickApproves(details: AuthMcpApprovalDetails, access: AuthMcpClientAccess) {
  return details.csrfToken !== undefined && (details.oneClickAccess ?? []).includes(access);
}

export function ConnectAgentSurface() {
  const [authorization] = useState(readAuthorizationRequest);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [access, setAccess] = useState<AuthMcpClientAccess>("read-only");
  const [pairingCode, setPairingCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [usePairingCode, setUsePairingCode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void runApproval(() =>
      requestMcpInAppApproval(resolvePrimaryEnvironmentHttpUrl("/"), authorization),
    ).then((answer) => {
      if (cancelled) return;
      if (answer.kind === "redirect") {
        window.location.replace(answer.url);
        return;
      }
      setLoaded(
        answer.kind === "error"
          ? { status: "invalid", message: answer.message }
          : { status: "ready", details: answer.value },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [authorization]);

  // A sign-in handed to the SSHCode app: wait for the owner's answer there.
  const inApp = loaded.status === "ready" ? loaded.details.pendingApproval : undefined;
  useEffect(() => {
    if (inApp === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      void runApproval((client) =>
        client.mcpOAuth.approvalStatus({
          payload: { authorization, id: inApp.id, pollSecret: inApp.pollSecret },
        }),
      ).then((answer) => {
        if (cancelled) return;
        if (answer.kind === "redirect") {
          window.location.replace(answer.url);
          return;
        }
        if (answer.kind === "error") {
          setLoaded({ status: "invalid", message: answer.message });
          return;
        }
        timer = setTimeout(check, IN_APP_POLL_MS);
      });
    timer = setTimeout(check, IN_APP_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [authorization, inApp]);

  const decide = useCallback(
    async (choice: "approve" | "deny") => {
      if (loaded.status !== "ready") return;
      setPending(choice);
      setErrorMessage("");
      const { csrfToken } = loaded.details;
      const decision: AuthMcpApprovalDecision =
        choice === "deny"
          ? { _tag: "deny" }
          : csrfToken !== undefined && oneClickApproves(loaded.details, access)
            ? { _tag: "browser-session", access, csrfToken }
            : { _tag: "pairing-code", access, code: pairingCode.trim() };
      const answer = await runApproval((client) =>
        client.mcpOAuth.decision({ payload: { authorization, decision } }),
      );
      if (answer.kind === "redirect") {
        window.location.replace(answer.url);
        return;
      }
      setPending(null);
      setErrorMessage(answer.kind === "error" ? answer.message : "The sign-in could not continue.");
    },
    [access, authorization, loaded, pairingCode],
  );

  if (loaded.status === "loading") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading
          title="Checking the sign-in request"
          description="One moment while this environment verifies the agent's request."
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </AuthSurfaceShell>
    );
  }

  if (loaded.status === "invalid") {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading title="This sign-in cannot continue" description={loaded.message} />
        <p className="mt-4 text-sm text-muted-foreground">
          Close this page and start the sign-in again from your agent.
        </p>
      </AuthSurfaceShell>
    );
  }

  const { details } = loaded;
  const oneClick = oneClickApproves(details, access);
  const canApprove = pending === null && (oneClick || pairingCode.trim().length > 0);

  if (details.pendingApproval !== undefined && !usePairingCode) {
    return (
      <AuthSurfaceShell>
        <ConnectAgentHeading
          title={`Approve ${details.clientName} in SSHCode`}
          description="Type this code in SSHCode to allow this sign-in."
        />
        <p
          className="mt-6 text-center font-mono text-5xl font-semibold tracking-widest tabular-nums"
          aria-label="Sign-in code"
        >
          {details.pendingApproval.code}
        </p>
        <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          Waiting for your answer in SSHCode…
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          The name is chosen by the agent, and approving sends access to{" "}
          <span className="font-medium text-foreground">{details.redirectHost}</span>.{" "}
          <button
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setUsePairingCode(true)}
            type="button"
          >
            Use a pairing code instead
          </button>
        </p>
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectAgentHeading
        title={`Connect ${details.clientName}`}
        description={
          <>
            This agent wants to use the chats in every project on{" "}
            <span className="font-medium text-foreground">{details.environmentHost}</span>.
          </>
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {redirectsToThisComputer(details.redirectHost) ? (
          <>
            The name is chosen by the agent. Approval returns to {details.redirectHost} on the
            computer that opened this page. Only approve a sign-in you just started.
          </>
        ) : (
          <>
            The name is chosen by the agent. Approval gives access to whoever runs{" "}
            <span className="font-medium text-foreground">{details.redirectHost}</span>. Only
            approve a sign-in you just started there.
          </>
        )}
      </p>

      {details.inAppUnavailable !== undefined && !usePairingCode ? (
        <Alert className="mt-4" variant="info">
          <AlertDescription>
            {details.inAppUnavailable} Or approve here with a pairing code.
          </AlertDescription>
        </Alert>
      ) : null}

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve");
        }}
      >
        <div className="space-y-2">
          <span id="connect-agent-access-label" className="text-sm font-medium">
            What it may do
          </span>
          <AgentAccessPicker
            labelledBy="connect-agent-access-label"
            value={access}
            onChange={setAccess}
          />
          <p className="text-xs text-muted-foreground">
            Beyond read only, it can start, message and stop chats, and none of them can run with
            more than the mode you pick.
          </p>
        </div>

        {oneClick ? null : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="connect-agent-pairing-code">
              Pairing code
            </label>
            <Input
              id="connect-agent-pairing-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={pending !== null}
              nativeInput
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder="Paste a one-time pairing code"
              spellCheck={false}
              value={pairingCode}
            />
            <p className="text-xs text-muted-foreground">
              Create one in Settings → Connections, or run <code>sshcode auth pairing create</code>{" "}
              on this machine.
            </p>
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} type="submit">
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny")}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
        </div>
      </form>
    </AuthSurfaceShell>
  );
}

function ConnectAgentHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <>
      <p className="text-3xs font-semibold tracking-widest text-primary uppercase">Agent sign-in</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

import type {
  AuthMcpClientAccess,
  OutsideAgentSignIn,
  OutsideAgentsCommand,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { AgentAccessPicker, agentAccessConfig } from "./auth/AgentAccessPicker";
import { mcpDestinationMismatch, type McpApp } from "./mcp/mcpApps";
import { suggestedMcpAccess, type McpApprovalPreference } from "./mcp/mcpGate";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Reveal self-declared identity only after the owner types the browser's code. */
export function OutsideAgentApproval(props: {
  readonly pending: readonly OutsideAgentSignIn[];
  readonly autoFocus?: boolean;
  readonly onAnswer: (input: OutsideAgentsCommand) => Promise<boolean>;
  readonly onApproved?: (signIn: OutsideAgentSignIn) => void;
  readonly access?: AuthMcpClientAccess;
  readonly preference?: McpApprovalPreference | null;
  readonly app?: McpApp;
  readonly disabled?: boolean;
}) {
  const [code, setCode] = useState("");
  const fieldId = useId();
  const signIn = code.length === 4 ? props.pending.find((item) => item.code === code) : undefined;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Type the 4-digit code your browser shows.
        </label>
        <Input
          id={fieldId}
          autoFocus={props.autoFocus ?? true}
          autoComplete="off"
          inputMode="numeric"
          pattern="[0-9]{4}"
          font="mono"
          size="lg"
          value={code}
          disabled={props.disabled}
          onChange={(event) =>
            setCode(event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 4))
          }
        />
      </div>
      {signIn === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {code.length === 4
            ? "No sign-in has that code. Check the page in your browser."
            : props.pending.length > 0
              ? `${props.pending.length} ${props.pending.length === 1 ? "sign-in" : "sign-ins"} waiting`
              : "Waiting for a sign-in…"}
        </p>
      ) : (
        <MatchedSignIn
          key={signIn.id}
          {...props}
          signIn={signIn}
          code={code}
          onAnswered={() => setCode("")}
        />
      )}
    </div>
  );
}

function MatchedSignIn(props: {
  readonly signIn: OutsideAgentSignIn;
  readonly code: string;
  readonly onAnswer: (input: OutsideAgentsCommand) => Promise<boolean>;
  readonly onApproved?: (signIn: OutsideAgentSignIn) => void;
  readonly onAnswered: () => void;
  readonly access?: AuthMcpClientAccess;
  readonly preference?: McpApprovalPreference | null;
  readonly app?: McpApp;
  readonly disabled?: boolean;
}) {
  const { signIn } = props;
  const [picked, setPicked] = useState<AuthMcpClientAccess>(() =>
    suggestedMcpAccess(props.preference ?? null, signIn, Date.now()),
  );
  const access = props.access ?? picked;
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const accessId = useId();
  const mismatch =
    props.app !== undefined && mcpDestinationMismatch(props.app, signIn.redirectHost);
  const decide = async (choice: "approve" | "deny") => {
    setBusy(choice);
    try {
      const ok = await props.onAnswer(
        choice === "approve"
          ? { _tag: "approve", id: signIn.id, access, code: props.code }
          : { _tag: "deny", id: signIn.id },
      );
      if (ok) {
        if (choice === "approve") props.onApproved?.(signIn);
        props.onAnswered();
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-4">
      <h3 className="text-base font-medium">{signIn.clientName} wants to use SSHCode</h3>
      {mismatch ? (
        <Alert variant="warning">
          <AlertDescription>
            This is not where {props.app!.name} sends access. Deny it unless you know this address.
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">App’s chosen name</dt>
          <dd className="break-words font-medium">{signIn.clientName}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Sends access to</dt>
          <dd className="break-words font-medium">{signIn.redirectHost}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Access</dt>
          <dd className="font-medium">{agentAccessConfig[access].label}</dd>
        </div>
      </dl>
      {props.access === undefined ? (
        <div className="space-y-2">
          <span id={accessId} className="text-sm font-medium">
            What it may do
          </span>
          <AgentAccessPicker
            labelledBy={accessId}
            value={access}
            onChange={setPicked}
            disabled={busy !== null || (props.disabled ?? false)}
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Approving gives access to whoever runs {signIn.redirectHost}. The name is chosen by the app.
        You can disconnect it any time in Settings → Connections → Outside agents.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          variant={mismatch ? "default" : "outline"}
          disabled={busy !== null || (props.disabled ?? false)}
          onClick={() => void decide("deny")}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button
          variant={mismatch ? "ghost" : "default"}
          disabled={busy !== null || (props.disabled ?? false)}
          onClick={() => void decide("approve")}
        >
          {busy === "approve" ? "Allowing…" : "Allow"}
        </Button>
      </div>
    </section>
  );
}

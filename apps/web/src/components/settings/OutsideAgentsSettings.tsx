import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useState } from "react";

import type { ServerClientSessionRecord } from "~/environments/primary";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOutsideAgents } from "../OutsideAgentPrompt";
import { OutsideAgentApproval } from "../OutsideAgentApproval";
import { openUseInAnotherApp } from "../mcp/UseInAnotherAppDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** A signed-in outside agent, as the Connections page lists it. */
export interface OutsideAgentConnection {
  readonly sessionId: AuthSessionId;
  readonly name: string;
  readonly scopes: ServerClientSessionRecord["scopes"];
  readonly connected: boolean;
  readonly issuedAt: string;
  readonly lastConnectedAt: string | null;
}

/** Outside agents sign in with OAuth as the `mcp-client` subject. */
export const isOutsideAgentSession = (session: ServerClientSessionRecord) =>
  session.subject === "mcp-client";

/** "just now", or "5m ago". */
function elapsed(iso: string, nowMs: number): string {
  const label = formatElapsedDurationLabel(iso, nowMs);
  return label === "just now" ? label : `${label} ago`;
}

function accessLabel(agent: OutsideAgentConnection): string {
  if (agent.scopes.includes(AuthSettingsWriteScope)) return "Full access";
  if (agent.scopes.includes(AuthOrchestrationOperateScope)) return "Can start and message chats";
  return "Read only";
}

/**
 * Settings → Connections → Outside agents: the switch that lets agents
 * SSHCode did not start sign in, setup, pending requests, and connected apps.
 */
export function OutsideAgentsSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<OutsideAgentConnection>;
  readonly revokingSessionId: string | null;
  readonly onDisconnect: (sessionId: AuthSessionId) => void;
}) {
  const { environmentId } = props;
  const configs = useServerConfigs();
  const canWrite = useAtomValue(
    serverEnvironment.outsideAgentsCommand.permissionAtom(environmentId),
  );
  const { on, acceptingUntil, pending, answer } = useOutsideAgents(environmentId);
  const [windowBusy, setWindowBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const stored = configs.get(environmentId)?.settings.outsideAgents === true;
  const checked = optimistic ?? stored;
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "outside agents setting",
    reportFailure: false,
  });
  const nowMs = useRelativeTimeTick(30_000);
  const { agents } = props;

  const toggle = async (next: boolean) => {
    setOptimistic(next);
    const result = await update({ environmentId, input: { patch: { outsideAgents: next } } });
    setOptimistic(null);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: next ? "Couldn't turn on outside agents" : "Couldn't turn off outside agents",
        description: "Try again.",
      });
    }
  };

  const stopAccepting = async () => {
    setWindowBusy(true);
    await answer({ _tag: "stop-accepting" });
    setWindowBusy(false);
  };
  // The tick can lag up to 30 s, so the count is capped at the server's 10-minute window.
  const minutesLeft =
    acceptingUntil !== null && acceptingUntil > nowMs
      ? Math.min(10, Math.max(1, Math.ceil((acceptingUntil - nowMs) / 60_000)))
      : null;

  if (!canWrite) return null;
  return (
    <SettingsSection
      {...searchableSetting("outside-agents")}
      icon={<BotIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title="Use SSHCode in another app (MCP)"
        description="Choose an app and allow its sign-in here."
        control={
          <Button size="xs" onClick={() => openUseInAnotherApp(environmentId)}>
            Connect an app
          </Button>
        }
      />
      <SettingsRow
        title="Let outside agents use SSHCode"
        description="Each app needs your approval."
        control={
          <Switch
            checked={checked}
            disabled={optimistic !== null}
            onCheckedChange={(next) => void toggle(Boolean(next))}
            aria-label="Let outside agents use SSHCode"
          />
        }
      />
      {on && checked ? (
        <>
          {minutesLeft !== null ? (
            <SettingsRow
              title={`Taking new agents for ${minutesLeft} more ${minutesLeft === 1 ? "minute" : "minutes"}`}
              description="Already approved apps keep working after this ends."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={windowBusy}
                  onClick={() => void stopAccepting()}
                >
                  Stop
                </Button>
              }
            />
          ) : null}
          {pending.length > 0 ? (
            <>
              <SettingsRow
                title={`${pending.length} ${pending.length === 1 ? "sign-in" : "sign-ins"} waiting`}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void Promise.all(
                        pending.map((signIn) => answer({ _tag: "deny", id: signIn.id })),
                      )
                    }
                  >
                    Deny all
                  </Button>
                }
              />
              <OutsideAgentApproval pending={pending} onAnswer={answer} autoFocus={false} />
            </>
          ) : null}
          {agents.length === 0 ? (
            <SettingsRow
              title="No agents connected yet"
              description="Once you approve an agent's sign-in, it shows up here."
            />
          ) : (
            agents.map((agent) => (
              <SettingsRow
                key={agent.sessionId}
                title={agent.name}
                description={[
                  accessLabel(agent),
                  agent.connected
                    ? "connected now"
                    : agent.lastConnectedAt
                      ? `last used ${elapsed(agent.lastConnectedAt, nowMs)}`
                      : `approved ${elapsed(agent.issuedAt, nowMs)}`,
                ].join(" · ")}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={props.revokingSessionId === agent.sessionId}
                    onClick={() => props.onDisconnect(agent.sessionId)}
                  >
                    {props.revokingSessionId === agent.sessionId ? "Disconnecting…" : "Disconnect"}
                  </Button>
                }
              />
            ))
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}

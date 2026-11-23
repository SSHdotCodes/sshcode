import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  EnvironmentId,
  OutsideAgentSignIn,
  OutsideAgentsCommand,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { mcpApprovalPreferenceAtom } from "./mcp/mcpApprovalPreference";
import { activeMcpSetupEnvironmentAtom } from "./mcp/mcpSetupState";
import { OutsideAgentApproval } from "./OutsideAgentApproval";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

/** Agents can start and message chats, which ask before commands and edits. */
export const DEFAULT_OUTSIDE_AGENT_ACCESS: AuthMcpClientAccess = "approval-required";

/** Outside-agent sign-ins waiting on this environment, while the setting is on. */
export function useOutsideAgents(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  const on = environmentId !== null && configs.get(environmentId)?.settings.outsideAgents === true;
  const allowed = useAtomValue(
    serverEnvironment.outsideAgentsCommand.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    on && allowed && environmentId !== null
      ? serverEnvironment.outsideAgentsState({ environmentId, input: {} })
      : null,
  );
  const run = useAtomCommand(serverEnvironment.outsideAgentsCommand, {
    label: "answer an outside agent",
    reportFailure: false,
  });
  const answer = useCallback(
    async (input: OutsideAgentsCommand) => {
      if (environmentId === null) return false;
      const result = await run({ environmentId, input });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title:
            input._tag === "approve" || input._tag === "deny"
              ? "Couldn't answer the sign-in"
              : "Couldn't change whether SSHCode takes new agents",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
      return false;
    },
    [environmentId, run],
  );
  return {
    on,
    allowed,
    acceptingUntil: query.data?.enabled ? query.data.acceptingUntil : null,
    pending: (query.data?.enabled ? query.data.pending : []) as ReadonlyArray<OutsideAgentSignIn>,
    answer,
  };
}

/**
 * Asks the owner, wherever SSHCode is open, whether an outside agent that is
 * waiting at its sign-in page may come in, and with how much access.
 */
export function OutsideAgentPrompt(props: { readonly environmentId?: EnvironmentId } = {}) {
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryId;
  const { pending, answer } = useOutsideAgents(environmentId);
  const setupEnvironmentId = useAtomValue(activeMcpSetupEnvironmentAtom);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const visible = pending.filter((signIn) => !dismissed.has(signIn.id));
  if (visible.length === 0 || environmentId === null || setupEnvironmentId === environmentId)
    return null;
  return (
    <OutsideAgentPromptDialog
      environmentId={environmentId}
      pending={pending}
      onAnswer={answer}
      onLater={() => setDismissed(new Set(pending.map((signIn) => signIn.id)))}
    />
  );
}

export function OutsideAgentPromptDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly pending: readonly OutsideAgentSignIn[];
  readonly onAnswer: (input: OutsideAgentsCommand) => Promise<boolean>;
  readonly onLater: () => void;
}) {
  const preference = useAtomValue(mcpApprovalPreferenceAtom(props.environmentId));
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onLater())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign-in waiting</DialogTitle>
          <DialogDescription>
            Enter the code from your browser to review a sign-in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <OutsideAgentApproval
            pending={props.pending}
            preference={preference}
            onAnswer={props.onAnswer}
          />
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={props.onLater}>
              Not now
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { AuthSettingsWriteScope } from "@t3tools/contracts";

export function useWorkflowsEnabled(
  environmentIds?: EnvironmentId | ReadonlyArray<EnvironmentId>,
): readonly [boolean, (enabled: boolean) => void, boolean] {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const targets =
    typeof environmentIds === "string" ? [environmentIds] : (environmentIds ?? [...configs.keys()]);
  const writable = useEnvironmentsWithScope(
    targets.map((environmentId) => ({ environmentId })),
    AuthSettingsWriteScope,
  );
  const enabled = targets.some((id) => configs.get(id)?.settings.workflowsBeta === true);
  const setEnabled = useCallback(
    (value: boolean) => {
      for (const environmentId of targets)
        if (readEnvironmentScope(environmentId, AuthSettingsWriteScope))
          void save({ environmentId, input: { patch: { workflowsBeta: value } } });
    },
    [save, targets],
  );
  return [enabled, setEnabled, targets.length > 0 && targets.every((id) => writable.has(id))];
}

export const workflowsState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile:workflows:state",
  tag: WS_METHODS.workflowsSubscribe,
  idleTtlMs: 0,
});
export const mutateWorkflow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:workflows:mutate",
  tag: WS_METHODS.workflowsMutate,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});
export const compileWorkflow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:workflows:compile",
  tag: WS_METHODS.workflowsCompile,
});
export const startWorkflow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:workflows:start",
  tag: WS_METHODS.workflowsStart,
});

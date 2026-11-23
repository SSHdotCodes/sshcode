import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  EnvironmentId,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import type { CloudLinkTarget } from "./linkEnvironment";
import { readCachedPrimaryCloudLinkState, usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  /** The owner's Turn on action includes installing the relay client if needed. */
  readonly installRelayClient?: boolean;
  readonly publish: boolean;
  /** Omit to leave the webhook-hold setting as it is. */
  readonly holdWebhooksWhileOffline?: boolean;
}

export const CLOUD_LINK_RECONCILE_TIMEOUT_MS = 15_000;

interface ReconciliationOperation {
  readonly accountId: string | null;
  readonly abortController: AbortController;
}

/**
 * Whether the link has a working managed tunnel. The local tunnel config can
 * outlive a relay link that drifted to publish-only, and clients then get
 * `endpoint_provider_not_managed`. So when relay discovery has this
 * environment's record, it must also say managed. Older environment servers
 * predate managedTunnelActive; for them a link always implies a tunnel. A link
 * the relay rejected (usually after a Deregister) gives no access at all.
 */
function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel")
  );
}

/**
 * Drives the primary environment's T3 Connect link. T3 Connect (managed
 * tunnel) and agent-activity publishing are independent capabilities backed by
 * a single relay link, so consumers express the full desired state and
 * `reconcileCloudState` applies it: unlink when neither is wanted, otherwise
 * (re)link with the mode the managed-tunnel bit implies and set the publish
 * preference. Re-linking only happens when the managed-tunnel mode actually
 * changes, so flipping publish alone is cheap. Calls are account-scoped and
 * cancellable; queued work runs in order without letting a stale request write
 * after a newer choice or hold the queue forever.
 */
export function useCloudLinkController(targetOverride?: CloudLinkTarget | null) {
  const { getToken, isSignedIn, userId } = useAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState(targetOverride);
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const primaryEnvironmentId = primaryCloudLinkState.target?.environmentId;
  const relayProviderKind = primaryEnvironmentId
    ? relayEnvironments.get(primaryEnvironmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);
  const reconciliationQueue = useRef<Promise<void>>(Promise.resolve());
  const currentReconciliation = useRef<ReconciliationOperation | null>(null);
  const cancelOperation = useCallback((operation: ReconciliationOperation) => {
    if (currentReconciliation.current === operation) currentReconciliation.current = null;
    operation.abortController.abort();
  }, []);
  const cancelReconciliation = useCallback(() => {
    const operation = currentReconciliation.current;
    if (operation) cancelOperation(operation);
  }, [cancelOperation]);
  useEffect(() => {
    const operation = currentReconciliation.current;
    if (operation && (!isSignedIn || operation.accountId !== (userId ?? null))) {
      cancelOperation(operation);
    }
  }, [cancelOperation, isSignedIn, userId]);
  useEffect(
    () => () => {
      const operation = currentReconciliation.current;
      if (operation) cancelOperation(operation);
    },
    [cancelOperation],
  );

  const reportUpdateFailure = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "Could not update T3 Connect access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update T3 Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add({
      type: "error",
      title: "Could not update T3 Connect",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const linkData = primaryCloudLinkState.data;
  // A revoked link reads as off; turning it on links again.
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  // Local state says managed but the relay holds a publish-only link. Turning
  // T3 Connect on relinks as managed, which repairs it.
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = primaryCloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (primaryCloudLinkState.data?.linked ?? false);

  const reconcileCloudStateNow = async (
    desired: CloudLinkDesiredState,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    if (!isCurrent()) return false;
    setOperationError(null);
    const reportFailure = (cause: unknown) => {
      if (isCurrent()) reportUpdateFailure(cause);
    };
    const target = primaryCloudLinkState.target;
    if (!target) {
      reportFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const environmentId = EnvironmentId.make(target.environmentId);
    const canManageLink = () => {
      if (!isCurrent()) return false;
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportFailure(
          new Error("This connection needs permission to view and manage T3 Connect settings."),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedPrimaryCloudLinkState(target);
      if (state === null) {
        reportFailure(new Error("Wait until the current T3 Connect settings can be read."));
      }
      return state;
    };
    if (!canManageLink()) return false;
    const wantsLink = desired.managedTunnel || desired.publish;
    if (wantsLink && readLinkState() === null) return false;
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (!isCurrent() || !canManageLink()) return false;

    // A failure after this point may follow a partially applied mutation (e.g.
    // the link succeeded but the preference update did not), so every exit —
    // success or failure — refreshes the rendered state to whatever the server
    // actually holds now.
    if (!wantsLink) {
      // Unlink works without a relay token — a failed token read must not
      // leave the user unable to turn T3 Connect off.
      if (!isCurrent()) return false;
      const unlinkResult = await unlinkPrimaryEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      if (!isCurrent()) return false;
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          reportFailure(squashAtomCommandFailure(unlinkResult));
        }
        if (isCurrent()) primaryCloudLinkState.refresh();
        return false;
      }
    } else {
      const currentLinkState = readLinkState();
      if (currentLinkState === null) return false;
      if (tokenResult._tag === "Failure") {
        reportFailure(squashAtomCommandFailure(tokenResult));
        return false;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reportFailure(new Error("Sign in to T3 Connect before enabling this."));
        return false;
      }
      const currentManagedTunnel = isManagedTunnelActive(currentLinkState, relayProviderKind);
      if (
        !currentLinkState.linked ||
        currentLinkState.linkRevoked === true ||
        currentManagedTunnel !== desired.managedTunnel
      ) {
        if (!isCurrent()) return false;
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : "publish_only",
          ...(desired.installRelayClient === undefined
            ? {}
            : { installRelayClient: desired.installRelayClient }),
          isCurrent,
        });
        if (!isCurrent()) return false;
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            reportFailure(squashAtomCommandFailure(linkResult));
          }
          if (isCurrent()) primaryCloudLinkState.refresh();
          return false;
        }
      }
      if (!isCurrent() || !canManageLink() || readLinkState() === null) {
        if (isCurrent()) primaryCloudLinkState.refresh();
        return false;
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
        ...(desired.holdWebhooksWhileOffline === undefined
          ? {}
          : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }),
      });
      if (!isCurrent()) return false;
      if (prefResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(prefResult)) {
          reportFailure(squashAtomCommandFailure(prefResult));
        }
        if (isCurrent()) primaryCloudLinkState.refresh();
        return false;
      }
    }

    if (!isCurrent()) return false;
    primaryCloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (!isCurrent()) return false;
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  const runReconciliation = async (
    operation: ReconciliationOperation,
    desired: CloudLinkDesiredState,
  ): Promise<boolean> => {
    const isCurrent = () => currentReconciliation.current === operation;
    if (!isCurrent()) return false;
    const run = reconcileCloudStateNow(desired, isCurrent);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false);
      operation.abortController.signal.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        if (!isCurrent()) return;
        reportUpdateFailure(
          new Error("T3 Connect timed out. Check your connection and try again."),
        );
        cancelOperation(operation);
      }, CLOUD_LINK_RECONCILE_TIMEOUT_MS);
    });
    try {
      if (operation.abortController.signal.aborted) return false;
      return await Promise.race([run, cancelled]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      operation.abortController.signal.removeEventListener("abort", onAbort);
      if (isCurrent()) currentReconciliation.current = null;
    }
  };

  const reconcileCloudState = (desired: CloudLinkDesiredState): Promise<boolean> => {
    cancelReconciliation();
    const operation: ReconciliationOperation = {
      accountId: userId ?? null,
      abortController: new AbortController(),
    };
    currentReconciliation.current = operation;
    const result = reconciliationQueue.current.then(() => {
      if (currentReconciliation.current !== operation) return false;
      return runReconciliation(operation, desired);
    });
    reconciliationQueue.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linked,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
    cancelReconciliation,
  };
}

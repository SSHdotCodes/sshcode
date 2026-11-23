import { useMemo } from "react";

import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
/** What a thread row needs to draw the provider glyph and its account badge. */
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
}

/**
 * The instance a thread's row names: its open session while that works, or while it is
 * another account of the chosen provider; otherwise the chosen model's, since a chat
 * switched to another provider hands off on its next send while the old session idles.
 */
export function threadRowInstanceId(
  providers: ReadonlyArray<Pick<ThreadListProvider, "instanceId" | "driver">> | undefined,
  thread: Pick<EnvironmentThreadShell, "runtime" | "modelSelection">,
): string {
  const chosen = thread.modelSelection.instanceId;
  const runtime = thread.runtime?.providerInstanceId;
  if (runtime == null || runtime === chosen) return chosen;
  if (threadRuntimeIsActive(thread.runtime)) return runtime;
  const driverOf = (id: string) =>
    providers?.find((provider) => provider.instanceId === id)?.driver;
  return driverOf(runtime) === driverOf(chosen) ? runtime : chosen;
}

/**
 * Resolve the provider instance a thread runs on, scoped to the thread's own
 * environment: default instance ids are the driver slug, so the same id
 * names a different account on every server.
 */
export function resolveThreadProviderInstance(
  providers: ReadonlyArray<ThreadListProvider> | undefined,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  if (providers === undefined) return null;
  const instanceId = threadRowInstanceId(providers, thread);
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    instanceId: snapshot.instanceId,
    driverKind: snapshot.driver,
    continuationGroupKey: snapshot.continuation?.groupKey,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
    ...(snapshot.iconUrl ? { acpRegistryIconUrl: snapshot.iconUrl } : {}),
  };
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      entry,
      providers.map((provider) => ({
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        continuationGroupKey: provider.continuation?.groupKey,
        enabled: provider.enabled,
        installed: provider.installed,
      })),
    ),
  };
}

/**
 * Builds a resolver handing out reference-stable `ThreadRowProviderInstance`
 * objects. `resolveThreadProviderInstance` builds a fresh object per call,
 * which breaks the memoized row's props comparison on every parent render —
 * the result only depends on (environment, instance id), so one cache per
 * provider-list generation keeps each row's `providerInstance` prop stable
 * until the instance behind the row actually changes.
 */
export function createThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = threadRowInstanceId(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
    );
    const cacheKey = `${thread.environmentId}|${instanceId ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

/** List-scoped wrapper: one cache per provider-list generation. */
export function useThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(
    () => createThreadRowProviderInstanceResolver(providersByEnvironmentId),
    [providersByEnvironmentId],
  );
}

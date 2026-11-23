import type { HarnessDefaultsState, ServerProvider } from "@t3tools/contracts";
import { useEffect } from "react";

/**
 * The in-app harness defaults as the server already applied them to its
 * provider snapshot: the default harness carries `isHarnessDefault`, and an
 * overridden model or option shows up as a default that differs from the
 * native one. The live defaults stream starts again with every New chat
 * sheet and never arrives offline, so until it does this keeps the explicit
 * choice ahead of "last used" instead of flipping the harness (and its
 * mascot and theme) once the stream catches up.
 */
export function harnessDefaultsFromProviders(
  providers: ReadonlyArray<ServerProvider>,
): HarnessDefaultsState {
  const defaultHarness = providers.find((provider) => provider.isHarnessDefault)?.instanceId;
  const harnesses: Record<string, { model?: string; options?: Record<string, string> }> = {};
  for (const provider of providers) {
    const nativeModel = provider.nativeModelDefaults?.model;
    if (nativeModel === undefined) continue;
    const model = provider.models.find((entry) => entry.isDefault);
    if (!model) continue;
    const options: Record<string, string> = {};
    for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
      if (
        descriptor.type === "select" &&
        descriptor.currentValue !== undefined &&
        descriptor.nativeValue !== undefined &&
        descriptor.currentValue !== descriptor.nativeValue
      ) {
        options[descriptor.id] = descriptor.currentValue;
      }
    }
    const entry = {
      ...(model.slug !== nativeModel ? { model: model.slug } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
    if (Object.keys(entry).length > 0) harnesses[provider.instanceId] = entry;
  }
  return {
    ...(defaultHarness !== undefined ? { defaultHarness } : {}),
    harnesses,
  } as HarnessDefaultsState;
}

type HarnessEntry = HarnessDefaultsState["harnesses"][keyof HarnessDefaultsState["harnesses"]];

/** Whether a remembered choice still matches what the provider now applies. */
function entryMatchesProvider(entry: HarnessEntry, provider: ServerProvider): boolean {
  const model = provider.models.find((candidate) => candidate.isDefault);
  if (!model || (entry.model !== undefined && entry.model !== model.slug)) return false;
  return Object.entries(entry.options ?? {}).every(([id, value]) =>
    (model.capabilities?.optionDescriptors ?? []).some(
      (descriptor) =>
        descriptor.id === id && descriptor.type === "select" && descriptor.currentValue === value,
    ),
  );
}

/**
 * The defaults to use before the live stream delivers: what the provider
 * snapshot implies, plus any choice from the last live state this app saw
 * that the snapshot still agrees with. The snapshot alone cannot show a
 * choice that equals the native default (picking the native model explicitly
 * still beats "last used"); a remembered choice the server no longer applies
 * is stale and dropped.
 */
export function fallbackHarnessDefaults(
  providers: ReadonlyArray<ServerProvider>,
  remembered: HarnessDefaultsState | undefined,
): HarnessDefaultsState {
  const derived = harnessDefaultsFromProviders(providers);
  if (!remembered) return derived;
  const harnesses = { ...derived.harnesses };
  for (const provider of providers) {
    const entry = remembered.harnesses[provider.instanceId];
    if (!entry || !entryMatchesProvider(entry, provider)) continue;
    const implied = derived.harnesses[provider.instanceId];
    const options = { ...implied?.options, ...entry.options };
    harnesses[provider.instanceId] = {
      ...implied,
      ...entry,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }
  return { ...derived, harnesses };
}

const lastLiveHarnessDefaults = new Map<string, HarnessDefaultsState>();

/** The live harness defaults when they have arrived, otherwise the fallback. */
export function useHarnessDefaults(
  environmentId: string | null,
  live: HarnessDefaultsState | null,
  providers: ReadonlyArray<ServerProvider>,
): HarnessDefaultsState {
  useEffect(() => {
    if (environmentId !== null && live !== null) lastLiveHarnessDefaults.set(environmentId, live);
  }, [environmentId, live]);
  return (
    live ??
    fallbackHarnessDefaults(
      providers,
      environmentId === null ? undefined : lastLiveHarnessDefaults.get(environmentId),
    )
  );
}

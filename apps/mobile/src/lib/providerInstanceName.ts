import { resolveOfficialAcpRegistryIconUrl, type ProviderDriverKind } from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";

/**
 * Local ACP agents share one fallback glyph, so a badge alone cannot tell
 * instances apart. Official registry icons stay unlabeled.
 */
export function providerInstanceNameLabel(props: {
  readonly provider: string | null | undefined;
  readonly iconUrl?: string | null | undefined;
  readonly displayName: string;
  readonly showBadge: boolean;
}): string | null {
  return props.showBadge &&
    props.provider === "acpRegistry" &&
    resolveOfficialAcpRegistryIconUrl(props.iconUrl) === null
    ? props.displayName
    : null;
}

interface NamedProvider {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly iconUrl?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly continuation?: { readonly groupKey: string } | undefined;
}

/** Instance name for a composer model control, or null when the glyph is enough. */
export function composerAcpInstanceName(input: {
  readonly providerDriver: string | null | undefined;
  readonly providerIconUrl?: string | null | undefined;
  readonly providerLabel: string;
  readonly instanceId: string | undefined;
  readonly providers: ReadonlyArray<NamedProvider> | null | undefined;
}): string | null {
  const providers = input.providers;
  if (!providers || input.instanceId === undefined) return null;
  let provider: NamedProvider | undefined;
  for (const candidate of providers) {
    if (candidate.instanceId === input.instanceId) {
      provider = candidate;
      break;
    }
  }
  if (!provider) return null;
  const entries = [];
  for (const candidate of providers) {
    entries.push({
      instanceId: candidate.instanceId,
      driverKind: candidate.driver,
      continuationGroupKey: candidate.continuation?.groupKey,
      enabled: candidate.enabled,
      installed: candidate.installed,
    });
  }
  return providerInstanceNameLabel({
    provider: input.providerDriver,
    iconUrl: input.providerIconUrl ?? provider.iconUrl,
    displayName: input.providerLabel,
    showBadge: shouldShowInstanceBadge(
      {
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        continuationGroupKey: provider.continuation?.groupKey,
        accentColor: normalizeProviderAccentColor(provider.accentColor),
        ...(provider.iconUrl ? { acpRegistryIconUrl: provider.iconUrl } : {}),
      },
      entries,
    ),
  });
}

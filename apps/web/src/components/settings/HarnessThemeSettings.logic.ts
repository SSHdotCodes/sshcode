import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  HARNESS_THEME_PRESETS,
  harnessThemeIdentity,
  harnessThemeKeys,
  type HarnessThemeSettings,
} from "@t3tools/shared/harnessThemes";

import { providerClients } from "./providerDriverMeta";

export type HarnessThemeRow = Readonly<{ driver: string; label: string }>;

function harnessLabel(driver: ProviderDriverKind): string {
  return providerClients.get(driver)?.label ?? PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

const PRESENTATION_ORDER = new Map(
  providerClients.definitions.map((definition, index) => [definition.driverKind as string, index]),
);

/**
 * One row per harness the user has: every enabled, installed provider's
 * identity, plus any harness already customized so it stays resettable. Until
 * the provider list arrives, real drivers with a built-in look stand in.
 */
export function harnessThemeRows(
  providers: ReadonlyArray<
    Pick<ServerProvider, "driver" | "enabled" | "installed"> & { readonly config?: unknown }
  >,
  settings: HarnessThemeSettings,
): ReadonlyArray<HarnessThemeRow> {
  return harnessThemeKeys(providers, settings)
    .flatMap((key) => {
      const { driver, agentId } = harnessThemeIdentity(key);
      if (!isProviderDriverKind(driver)) return [];
      const preset = HARNESS_THEME_PRESETS.find((candidate) => candidate.key === key);
      return [{ driver: key, label: preset?.agentLabel ?? agentId ?? harnessLabel(driver) }];
    })
    .toSorted(
      (left, right) =>
        (PRESENTATION_ORDER.get(left.driver) ?? Number.MAX_SAFE_INTEGER) -
          (PRESENTATION_ORDER.get(right.driver) ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label),
    );
}

import type { EnvironmentId, ServerConfig, ServerProvider } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export type ThreadListProvider = Pick<
  ServerProvider,
  | "instanceId"
  | "driver"
  | "displayName"
  | "accentColor"
  | "iconUrl"
  | "enabled"
  | "installed"
  | "continuation"
>;

const capabilityKeys = [
  "threadSettlement",
  "threadSnooze",
  "threadPinning",
  "threadPinReorder",
  "threadActiveReorder",
  "threadTitleRegeneration",
] as const;

function selectEnvironment(config: ServerConfig, isConnected: boolean) {
  return {
    isConnected,
    providers: config.providers.map(
      ({
        instanceId,
        driver,
        displayName,
        accentColor,
        iconUrl,
        enabled,
        installed,
        continuation,
      }) => ({
        instanceId,
        driver,
        displayName,
        accentColor,
        iconUrl,
        enabled,
        installed,
        continuation,
      }),
    ),
    capabilities: config.environment.capabilities,
  };
}

type ListEnvironment = ReturnType<typeof selectEnvironment>;

function sameProviders(
  left: ReadonlyArray<ThreadListProvider>,
  right: ReadonlyArray<ThreadListProvider>,
) {
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const other = right[index]!;
      return (
        provider.instanceId === other.instanceId &&
        provider.driver === other.driver &&
        provider.displayName === other.displayName &&
        provider.accentColor === other.accentColor &&
        provider.iconUrl === other.iconUrl &&
        provider.enabled === other.enabled &&
        provider.installed === other.installed &&
        provider.continuation?.groupKey === other.continuation?.groupKey
      );
    })
  );
}

function collectEnvironments(environments: ReadonlyMap<EnvironmentId, ListEnvironment>) {
  const providersByEnvironmentId = new Map<EnvironmentId, ReadonlyArray<ThreadListProvider>>();
  const settlementEnvironmentIds = new Set<EnvironmentId>();
  const snoozeEnvironmentIds = new Set<EnvironmentId>();
  const pinningEnvironmentIds = new Set<EnvironmentId>();
  const pinReorderEnvironmentIds = new Set<EnvironmentId>();
  const activeReorderEnvironmentIds = new Set<EnvironmentId>();
  const titleRegenerationEnvironmentIds = new Set<EnvironmentId>();
  for (const [id, { providers, capabilities, isConnected }] of environments) {
    providersByEnvironmentId.set(id, providers);
    if (capabilities.threadSettlement === true) settlementEnvironmentIds.add(id);
    if (capabilities.threadSnooze === true) snoozeEnvironmentIds.add(id);
    if (capabilities.threadPinning === true) pinningEnvironmentIds.add(id);
    if (isConnected && capabilities.threadPinReorder === true) pinReorderEnvironmentIds.add(id);
    if (isConnected && capabilities.threadActiveReorder === true)
      activeReorderEnvironmentIds.add(id);
    if (capabilities.threadTitleRegeneration === true) titleRegenerationEnvironmentIds.add(id);
  }
  return {
    providersByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinningEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  };
}

/** Provider freshness, model catalogs, and machine identity do not affect the
    navigation lists. */
export function createThreadListEnvironmentsAtom(
  configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
  connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>,
) {
  let previous = new Map<EnvironmentId, ListEnvironment>();
  let result = collectEnvironments(previous);
  return Atom.make((get) => {
    const configs = get(configsAtom);
    const connected = new Set(get(connectedEnvironmentIdsAtom));
    const next = new Map<EnvironmentId, ListEnvironment>();
    let changed = configs.size !== previous.size;
    for (const [id, config] of configs) {
      const selected = selectEnvironment(config, connected.has(id));
      const prior = previous.get(id);
      if (prior && sameProviders(prior.providers, selected.providers)) {
        selected.providers = prior.providers;
      }
      const unchanged =
        prior &&
        prior.providers === selected.providers &&
        prior.isConnected === selected.isConnected &&
        capabilityKeys.every(
          (key) => (prior.capabilities[key] === true) === (selected.capabilities[key] === true),
        );
      next.set(id, unchanged ? prior : selected);
      if (!unchanged) changed = true;
    }
    if (changed) {
      previous = next;
      result = collectEnvironments(next);
    }
    return result;
  }).pipe(Atom.withLabel("thread-list-environments"));
}

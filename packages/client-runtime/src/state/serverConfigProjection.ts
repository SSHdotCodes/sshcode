import type { ServerConfig, ServerConfigStreamEvent, ServerProvider } from "@t3tools/contracts";
import type {
  ServerConfigStreamWireEvent,
  ServerProviderWire,
} from "@t3tools/contracts/serverConfigWire";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes, usage-limit sources and storage are current machine state,
 * so a cache could restore a set the machine no longer reports. Replay sends
 * them as separate events.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (
    config.environmentThemes === undefined &&
    config.usageLimitSources === undefined &&
    config.storage === undefined
  ) {
    return config;
  }
  const {
    environmentThemes: _themes,
    usageLimitSources: _sources,
    storage: _storage,
    ...rest
  } = config;
  return rest;
}

function expandProvider(provider: ServerProviderWire, held?: ServerProvider): ServerProvider {
  if (provider.workspaceSnapshots === undefined) return provider as ServerProvider;
  return {
    ...provider,
    workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => {
      if ("inheritsPreviousCatalog" in snapshot) {
        const previous = held?.workspaceSnapshots?.find((entry) => entry.cwd === snapshot.cwd);
        if (previous === undefined)
          throw new Error("Missing workspace catalog base; resynchronization required.");
        const { inheritsPreviousCatalog: _previous, ...rest } = snapshot;
        return { ...rest, skills: previous.skills, slashCommands: previous.slashCommands };
      }
      if (!("inheritsProviderCatalog" in snapshot)) return snapshot;
      const { inheritsProviderCatalog: _inherited, ...rest } = snapshot;
      return { ...rest, skills: provider.skills, slashCommands: provider.slashCommands };
    }),
  };
}

/** Restore the catalogs the server left out because this subscription already holds them. */
function withHeldCatalogs(
  provider: ServerProviderWire,
  held: ServerProvider | undefined,
): ServerProviderWire {
  if (provider.unchangedCatalogs === undefined) return provider;
  const { unchangedCatalogs, ...rest } = provider;
  if (held === undefined) return rest;
  return {
    ...rest,
    ...(unchangedCatalogs.includes("models") ? { models: held.models } : {}),
    ...(unchangedCatalogs.includes("skills") ? { skills: held.skills } : {}),
    ...(unchangedCatalogs.includes("slashCommands") ? { slashCommands: held.slashCommands } : {}),
  };
}

/** Reuse equal catalogs and provider objects across decoded status pushes. */
function reuseUnchanged<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  ) {
    return next;
  }
  if (Array.isArray(next)) {
    const before = previous as ReadonlyArray<unknown>;
    let same = before.length === next.length;
    const merged = next.map((item, index) => {
      const reused = reuseUnchanged(before[index], item);
      if (reused !== before[index]) same = false;
      return reused;
    });
    return (same ? previous : merged) as T;
  }
  // Decoded settings carry Durations, which are fresh instances on every push.
  if (Equal.isEqual(next)) return (Equal.equals(previous, next) ? previous : next) as T;
  if (Object.getPrototypeOf(next) !== Object.prototype) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const reused = reuseUnchanged(before[key], after[key]);
    if (reused !== before[key] || !(key in before)) same = false;
    merged[key] = reused;
  }
  return (same ? previous : merged) as T;
}

function reuseProviderList(
  previous: ReadonlyArray<ServerProvider>,
  next: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return previous.length === next.length &&
    next.every((provider, index) => provider === previous[index])
    ? previous
    : next;
}

function expandServerConfigEvent(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamWireEvent,
  held: ReadonlyArray<ServerProvider>,
): ServerConfigStreamEvent {
  if (event.type === "snapshot") {
    const byId = new Map(
      (Option.isSome(current) ? current.value.config.providers : held).map((provider) => [
        provider.instanceId,
        provider,
      ]),
    );
    return {
      ...event,
      config: {
        ...event.config,
        providers: event.config.providers.map((provider) =>
          expandProvider(withHeldCatalogs(provider, byId.get(provider.instanceId))),
        ),
      },
    };
  }
  if (event.type !== "providerStatuses") return event;
  const previous = Option.isSome(current) ? current.value.config.providers : [];
  const byId = new Map(previous.map((provider) => [provider.instanceId, provider]));
  const expandAndReuse = (provider: ServerProviderWire) => {
    const held = byId.get(provider.instanceId);
    return reuseUnchanged(held, expandProvider(withHeldCatalogs(provider, held), held));
  };
  if (!("removedProviderIds" in event.payload)) {
    return {
      ...event,
      payload: {
        providers: reuseProviderList(previous, event.payload.providers.map(expandAndReuse)),
      },
    };
  }
  for (const id of event.payload.removedProviderIds) byId.delete(id);
  for (const provider of event.payload.providers) {
    byId.set(provider.instanceId, expandAndReuse(provider));
  }
  // Unknown future provider kinds are filtered by the wire schema, so their
  // ids can legitimately remain in the order without a decoded provider.
  const providers = event.payload.providerOrder.flatMap((id) => {
    const provider = byId.get(id);
    return provider === undefined ? [] : [provider];
  });
  return { ...event, payload: { providers: reuseProviderList(previous, providers) } };
}

/**
 * `held` lists the providers a new subscription reported as `heldCatalogs`; its
 * first snapshot leaves their unchanged catalogs out.
 */
export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  wireEvent: ServerConfigStreamWireEvent,
  held: ReadonlyArray<ServerProvider> = [],
): Option.Option<ServerConfigProjection> {
  const event = expandServerConfigEvent(current, wireEvent, held);
  switch (event.type) {
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until a capable server sends its authoritative theme event. A legacy
      // server cannot send a later removal, so a downgrade must clear the set.
      const capabilities = event.config.environment.capabilities;
      const carriedThemes =
        capabilities.environmentThemes === true && Option.isSome(current)
          ? current.value.config.environmentThemes
          : undefined;
      const carried =
        capabilities.usageLimitSources === true && Option.isSome(current)
          ? current.value.config
          : undefined;
      return Option.some({
        config: {
          ...event.config,
          ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
          ...(carried?.usageLimitSources === undefined
            ? {}
            : { usageLimitSources: carried.usageLimitSources }),
          ...(carried?.storage === undefined ? {} : { storage: carried.storage }),
        },
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "chatTabsUpdated":
      return Option.map(current, (projection) => ({
        config: { ...projection.config, chatTabs: event.payload.tabs },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => {
        const settings = reuseUnchanged(projection.config.settings, event.payload.settings);
        return {
          config:
            settings === projection.config.settings
              ? projection.config
              : { ...projection.config, settings },
          latestEvent: event,
          source: "live",
        };
      });
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          environmentThemes: event.payload.themes.length > 0 ? event.payload.themes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
    case "usageLimitSourcesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          usageLimitSources: event.payload.sources.length > 0 ? event.payload.sources : undefined,
          storage: event.payload.storage,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}

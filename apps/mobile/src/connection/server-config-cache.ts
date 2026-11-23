import {
  ForwardCompatibleArray,
  ServerConfig,
  ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import {
  ServerProviderWire,
  InheritedWorkspaceSnapshot,
} from "@t3tools/contracts/serverConfigWire";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const SERVER_CONFIG_CACHE_SCHEMA_VERSION = 1;
export const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(SERVER_CONFIG_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  config: ServerConfig,
});
export const encodeStoredServerConfig = Schema.encodeEffect(
  Schema.fromJsonString(StoredServerConfig),
);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCanonical = Schema.decodeUnknownEffect(StoredServerConfig);
const decodeConfig = Schema.decodeUnknownEffect(
  StoredServerConfig.mapFields((fields) => ({
    ...fields,
    config: ServerConfig.mapFields((config) => ({
      ...config,
      providers: ForwardCompatibleArray(
        ServerProviderWire.mapFields((provider) => ({
          ...provider,
          // A disk record has no previous subscription to inherit from.
          workspaceSnapshots: Schema.optionalKey(
            Schema.Array(
              Schema.Union([InheritedWorkspaceSnapshot, ServerProviderWorkspaceSnapshot]),
            ),
          ),
        })),
      ),
    })),
  })),
);

/** Validate repeated workspace catalogs once, without changing the on-disk format. */
function compactCatalogs(raw: unknown): unknown {
  if (
    !Predicate.isObject(raw) ||
    !Predicate.isObject(raw.config) ||
    !Array.isArray(raw.config.providers)
  )
    return raw;
  let compacted = false;
  const result = {
    ...raw,
    config: {
      ...raw.config,
      providers: raw.config.providers.map((provider: unknown) => {
        if (!Predicate.isObject(provider)) return provider;
        // Transport flags are not part of the canonical cache. Only our comparison
        // below may replace a fully specified workspace with an inherited catalog.
        const { unchangedCatalogs: _unchanged, ...rest } = provider;
        if (!Array.isArray(rest.workspaceSnapshots)) return rest;
        const providerSkills = rest.skills;
        const providerCommands = rest.slashCommands;
        let skills: string | undefined;
        let commands: string | undefined;
        return {
          ...rest,
          workspaceSnapshots: rest.workspaceSnapshots.map((snapshot: unknown) => {
            if (!Predicate.isObject(snapshot)) return snapshot;
            const {
              inheritsProviderCatalog: _inherited,
              inheritsPreviousCatalog: _previous,
              ...full
            } = snapshot;
            if (
              Array.isArray(providerSkills) &&
              Array.isArray(providerCommands) &&
              Array.isArray(full.skills) &&
              full.skills.length === providerSkills.length &&
              Array.isArray(full.slashCommands) &&
              full.slashCommands.length === providerCommands.length &&
              JSON.stringify(full.skills) === (skills ??= JSON.stringify(providerSkills)) &&
              JSON.stringify(full.slashCommands) === (commands ??= JSON.stringify(providerCommands))
            ) {
              compacted = true;
              const { skills: _skills, slashCommands: _commands, ...metadata } = full;
              return { ...metadata, inheritsProviderCatalog: true };
            }
            return full;
          }),
        };
      }),
    },
  };
  return compacted ? result : raw;
}

export const decodeStoredServerConfig = Effect.fnUntraced(function* (raw: string) {
  const parsed = yield* decodeJson(raw);
  const compact = compactCatalogs(parsed);
  if (compact === parsed) return yield* decodeCanonical(parsed);
  const stored = yield* decodeConfig(compact);
  return {
    ...stored,
    config: {
      ...stored.config,
      providers: stored.config.providers.map((provider) => {
        const { unchangedCatalogs: _unchanged, workspaceSnapshots, ...rest } = provider;
        if (workspaceSnapshots === undefined) return rest;
        return {
          ...rest,
          workspaceSnapshots: workspaceSnapshots.map((snapshot) => {
            if (!("inheritsProviderCatalog" in snapshot)) return snapshot;
            const { inheritsProviderCatalog: _inherited, ...metadata } = snapshot;
            return { ...metadata, skills: rest.skills, slashCommands: rest.slashCommands };
          }),
        };
      }),
    },
  };
});

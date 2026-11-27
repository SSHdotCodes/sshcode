import type {
  ProviderInstanceId,
  ServerConfigStreamEvent,
  ServerProvider,
  ServerProviderUpdatedPayload,
  ServerSettings,
} from "@t3tools/contracts";
import type {
  ReusableProviderCatalog,
  ServerConfigStreamWireEvent,
  ServerProviderWire,
} from "@t3tools/contracts/serverConfigWire";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside a pure stream mapping.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import { redactServerSettingsForClient } from "./serverSettings.ts";

export function providerRefreshReply(
  providers: ReadonlyArray<ServerProvider>,
  {
    instanceId,
    cwd,
    omitProviders,
    workspaceSnapshotOnly,
  }: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly cwd?: string | undefined;
    readonly omitProviders?: boolean | undefined;
    readonly workspaceSnapshotOnly?: boolean | undefined;
  },
): ServerProviderUpdatedPayload {
  if (instanceId === undefined || cwd === undefined) {
    return { providers: omitProviders ? [] : providers };
  }
  if (!workspaceSnapshotOnly) return { providers };
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined) return { providers: [] };
  return {
    providers: [
      {
        ...provider,
        models: [],
        skills: [],
        slashCommands: [],
        workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
          (snapshot) => snapshot.cwd === cwd,
        ),
      },
    ],
  };
}

export const serverSettingsConfigUpdates = (changes: Stream.Stream<ServerSettings>) =>
  changes.pipe(
    Stream.map((settings) => ({
      version: 1 as const,
      type: "settingsUpdated" as const,
      payload: { settings: redactServerSettingsForClient(settings) },
    })),
  );

function compactProvider(provider: ServerProvider, previous?: ServerProvider): ServerProviderWire {
  if (provider.workspaceSnapshots === undefined) return provider;
  return {
    ...provider,
    workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => {
      const held = previous?.workspaceSnapshots?.find((entry) => entry.cwd === snapshot.cwd);
      if (
        held !== undefined &&
        NodeUtil.isDeepStrictEqual(snapshot.skills, held.skills) &&
        NodeUtil.isDeepStrictEqual(snapshot.slashCommands, held.slashCommands)
      ) {
        const { skills: _skills, slashCommands: _commands, ...rest } = snapshot;
        return { ...rest, inheritsPreviousCatalog: true as const };
      }
      if (
        !NodeUtil.isDeepStrictEqual(snapshot.skills, provider.skills) ||
        !NodeUtil.isDeepStrictEqual(snapshot.slashCommands, provider.slashCommands)
      ) {
        return snapshot;
      }
      const { skills: _skills, slashCommands: _commands, ...rest } = snapshot;
      return { ...rest, inheritsProviderCatalog: true as const };
    }),
  };
}

const REUSABLE_CATALOGS: ReadonlyArray<ReusableProviderCatalog> = [
  "models",
  "skills",
  "slashCommands",
];

/**
 * A status refresh usually changes a timestamp, quota or workspace scan, while
 * the model catalog stays put. OpenCode's catalog alone is ~140 KB, so leaving
 * out catalogs the subscriber already holds keeps each refresh to a few KB.
 */
function withoutUnchangedCatalogs(
  provider: ServerProviderWire,
  sent: ServerProvider,
): ServerProviderWire {
  const unchanged = REUSABLE_CATALOGS.filter(
    (catalog) =>
      provider[catalog].length > 0 && NodeUtil.isDeepStrictEqual(provider[catalog], sent[catalog]),
  );
  if (unchanged.length === 0) return provider;
  return {
    ...provider,
    ...(unchanged.includes("models") ? { models: [] } : {}),
    ...(unchanged.includes("skills") ? { skills: [] } : {}),
    ...(unchanged.includes("slashCommands") ? { slashCommands: [] } : {}),
    unchangedCatalogs: unchanged,
  };
}

/** Stable across restarts, so a client's held catalogs match until they change. */
export function providerCatalogDigest(
  provider: Pick<ServerProvider, "models" | "skills" | "slashCommands">,
): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.models, provider.skills, provider.slashCommands]))
    .digest("hex")
    .slice(0, 16);
}

interface TransportState {
  readonly previous: ReadonlyArray<ServerProvider>;
  /** What the client holds: first what it reported, then what this subscription sent. */
  readonly digests: Map<string, string>;
}

/**
 * Apply after debounce and late-editor snapshots: the delta baseline must be
 * the last list actually sent, not a registry update the stream coalesced away.
 * State belongs to each subscription, including when a stream is run again.
 */
export function serverConfigTransport<E, R>(
  events: Stream.Stream<ServerConfigStreamEvent, E, R>,
  options: {
    readonly compactProviders?: boolean | undefined;
    readonly reuseProviderCatalogs?: boolean | undefined;
    readonly reuseWorkspaceCatalogs?: boolean | undefined;
    readonly heldCatalogs?:
      | ReadonlyArray<{ readonly instanceId: string; readonly catalogDigest: string }>
      | undefined;
  },
): Stream.Stream<ServerConfigStreamWireEvent, E, R> {
  if (options.compactProviders !== true) return events;
  const heldCatalogs = options.heldCatalogs;
  return events.pipe(
    Stream.mapAccum(
      (): TransportState => ({
        previous: [],
        digests: new Map(heldCatalogs?.map((held) => [held.instanceId, held.catalogDigest])),
      }),
      (state, event): readonly [TransportState, ReadonlyArray<ServerConfigStreamWireEvent>] => {
        const { previous, digests } = state;
        const withDigest = (provider: ServerProvider, wire: ServerProviderWire) => {
          if (heldCatalogs === undefined) return wire;
          const catalogDigest = providerCatalogDigest(provider);
          const held = digests.get(provider.instanceId) === catalogDigest;
          digests.set(provider.instanceId, catalogDigest);
          return held && event.type === "snapshot"
            ? {
                ...wire,
                models: [],
                skills: [],
                slashCommands: [],
                unchangedCatalogs: REUSABLE_CATALOGS,
                catalogDigest,
              }
            : { ...wire, catalogDigest };
        };
        if (event.type === "snapshot") {
          return [
            { previous: event.config.providers, digests },
            [
              {
                ...event,
                config: {
                  ...event.config,
                  providers: event.config.providers.map((provider) =>
                    withDigest(provider, compactProvider(provider)),
                  ),
                },
              },
            ],
          ];
        }
        if (event.type !== "providerStatuses") return [state, [event]];
        const providers = event.payload.providers;
        const before = new Map(previous.map((provider) => [provider.instanceId, provider]));
        const ids = new Set(providers.map((provider) => provider.instanceId));
        const changed = providers.filter(
          (provider) => !NodeUtil.isDeepStrictEqual(before.get(provider.instanceId), provider),
        );
        return [
          { previous: providers, digests },
          [
            {
              ...event,
              payload: {
                providers: changed.map((provider) => {
                  const sent = before.get(provider.instanceId);
                  const compact = compactProvider(
                    provider,
                    options.reuseWorkspaceCatalogs === true ? sent : undefined,
                  );
                  return withDigest(
                    provider,
                    options.reuseProviderCatalogs === true && sent !== undefined
                      ? withoutUnchangedCatalogs(compact, sent)
                      : compact,
                  );
                }),
                removedProviderIds: previous
                  .filter((provider) => !ids.has(provider.instanceId))
                  .map((provider) => provider.instanceId),
                providerOrder: providers.map((provider) => provider.instanceId),
              },
            },
          ],
        ];
      },
    ),
  );
}

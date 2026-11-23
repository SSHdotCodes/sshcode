import * as Schema from "effect/Schema";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ServerConfig,
  ServerConfigStreamChatTabsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
} from "./server.ts";

export const InheritedWorkspaceSnapshot = Schema.Struct({
  cwd: ServerProviderWorkspaceSnapshot.fields.cwd,
  checkedAt: ServerProviderWorkspaceSnapshot.fields.checkedAt,
  slashCommandsPending: ServerProviderWorkspaceSnapshot.fields.slashCommandsPending,
  inheritsProviderCatalog: Schema.Literal(true),
});
const PreviousWorkspaceSnapshot = Schema.Struct({
  cwd: ServerProviderWorkspaceSnapshot.fields.cwd,
  checkedAt: ServerProviderWorkspaceSnapshot.fields.checkedAt,
  slashCommandsPending: ServerProviderWorkspaceSnapshot.fields.slashCommandsPending,
  inheritsPreviousCatalog: Schema.Literal(true),
});

export const ReusableProviderCatalog = Schema.Literals(["models", "skills", "slashCommands"]);
export type ReusableProviderCatalog = typeof ReusableProviderCatalog.Type;

/** Transport-only shape. Consumers always receive expanded workspace catalogs. */
export const ServerProviderWire = Schema.Struct({
  ...ServerProvider.fields,
  workspaceSnapshots: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        InheritedWorkspaceSnapshot,
        PreviousWorkspaceSnapshot,
        ServerProviderWorkspaceSnapshot,
      ]),
    ),
  ),
  /**
   * Catalogs equal to the ones this subscription last received for the
   * provider. They arrive empty and the client keeps its copy. Sent only to
   * subscribers requesting `reuseProviderCatalogs`.
   */
  unchangedCatalogs: Schema.optionalKey(Schema.Array(ReusableProviderCatalog)),
});
export type ServerProviderWire = typeof ServerProviderWire.Type;

const ServerProvidersWire = ForwardCompatibleArray(ServerProviderWire);

const ServerConfigWire = Schema.Struct({
  ...ServerConfig.fields,
  providers: ServerProvidersWire,
});

const ProviderStatusesWirePayload = Schema.Union([
  Schema.Struct({
    providers: ServerProvidersWire,
    removedProviderIds: Schema.Array(ProviderInstanceId),
    /** Includes unchanged providers, and preserves insertions and reorder-only changes. */
    providerOrder: Schema.Array(ProviderInstanceId),
  }),
  Schema.Struct({ providers: ServerProvidersWire }),
]);

/** Only subscribers requesting `compactProviders` receive the compact members. */
export const ServerConfigStreamWireEvent = Schema.Union([
  ServerConfigStreamChatTabsUpdatedEvent,
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("snapshot"),
    config: ServerConfigWire,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("providerStatuses"),
    payload: ProviderStatusesWirePayload,
  }),
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type ServerConfigStreamWireEvent = typeof ServerConfigStreamWireEvent.Type;

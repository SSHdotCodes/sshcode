import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  ServerSettingsPatch,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { ServerConfigStreamWireEvent } from "@t3tools/contracts/serverConfigWire";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as ServerSettingsService from "./serverSettings.ts";
import * as ServerConfigService from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { syncedChatListTabsEnabled } from "../../../packages/client-runtime/src/state/chatTabs.ts";
import {
  providerCatalogDigest,
  serverConfigTransport,
  serverSettingsConfigUpdates,
} from "./serverConfigTransport.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
} from "../../../packages/client-runtime/src/state/serverConfigProjection.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-18T00:00:00.000Z",
  models: [],
  skills: [{ name: "review", path: "/skills/review", enabled: true }],
  slashCommands: [{ name: "help", description: "Show help" }],
};
const matchingSnapshot = {
  cwd: "/workspace/one",
  checkedAt: provider.checkedAt,
  // Different object identities and property order must still deduplicate.
  skills: [{ enabled: true, path: "/skills/review", name: "review" }],
  slashCommands: [{ description: "Show help", name: "help" }],
};
const withSnapshots: ServerProvider = {
  ...provider,
  workspaceSnapshots: [
    matchingSnapshot,
    { ...matchingSnapshot, cwd: "/workspace/two", slashCommandsPending: true },
    { ...matchingSnapshot, cwd: "/workspace/three", skills: [] },
    { ...matchingSnapshot, cwd: "/workspace/four", slashCommands: [] },
  ],
};
const config: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    platform: { os: "linux", arch: "x64", machine: "server" },
    orchestrationProtocolVersion: 2,
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: true },
  },
  cwd: "/workspace",
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  keybindingsConfigPath: "/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [withSnapshots],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};
const snapshot: ServerConfigStreamEvent = { version: 1, type: "snapshot", config };
const statuses = (providers: ReadonlyArray<ServerProvider>): ServerConfigStreamEvent => ({
  version: 1,
  type: "providerStatuses",
  payload: { providers },
});
const encodeLegacy = Schema.encodeSync(ServerConfigStreamEvent);
const encodeWire = Schema.encodeSync(ServerConfigStreamWireEvent);
const decodeWire = Schema.decodeSync(ServerConfigStreamWireEvent);
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeWireJson = Schema.decodeEffect(Schema.fromJsonString(ServerConfigStreamWireEvent));
const run = (
  events: ReadonlyArray<ServerConfigStreamEvent>,
  compactProviders?: boolean,
  reuseProviderCatalogs?: boolean,
  reuseWorkspaceCatalogs?: boolean,
) =>
  serverConfigTransport(Stream.fromIterable(events), {
    compactProviders,
    reuseProviderCatalogs,
    reuseWorkspaceCatalogs,
  }).pipe(Stream.runCollect);

it.effect(
  "streams a phone's tab change to an open Mac and the Mac's change back to the phone",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService.ServerSettingsService;
      const connect = Effect.gen(function* () {
        const changes = serverSettingsConfigUpdates(yield* service.subscribeChanges);
        const initial = { ...config, settings: yield* service.getSettings };
        let state = applyServerConfigProjection(
          Option.none(),
          decodeWire(
            encodeWire({
              version: 1,
              type: "snapshot",
              config: initial,
            }),
          ),
        );
        return {
          enabled: () =>
            syncedChatListTabsEnabled(new Map([["shared", Option.getOrThrow(state).config]])),
          setEnabled: (enabled: boolean) =>
            service.updateSettings(decodeSettingsPatch({ chatListTabsEnabled: enabled })),
          receive: changes.pipe(
            Stream.runHead,
            Effect.map((update) => {
              state = applyServerConfigProjection(
                state,
                decodeWire(encodeWire(Option.getOrThrow(update))),
              );
            }),
          ),
        };
      });
      const phone = yield* connect;
      const mac = yield* connect;
      expect(mac.enabled()).toBe(true);
      yield* phone.setEnabled(false);
      yield* mac.receive;
      yield* phone.receive;
      expect(mac.enabled()).toBe(false);
      expect((yield* connect).enabled()).toBe(false);
      const fs = yield* FileSystem.FileSystem;
      const server = yield* ServerConfigService.ServerConfig;
      expect(JSON.parse(yield* fs.readFileString(server.settingsPath))).toMatchObject({
        chatListTabsEnabled: false,
        chatListTabsChangedAt: expect.any(Number),
      });
      yield* mac.setEnabled(true);
      yield* phone.receive;
      expect(phone.enabled()).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettingsService.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            ServerConfigService.layerTest(process.cwd(), { prefix: "chat-list-tabs-sync-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it("preserves receipt-first replay support across config transport and older snapshots", () => {
  for (const advertised of [true, undefined]) {
    const wire = encodeWire({
      ...snapshot,
      config: {
        ...config,
        ...(advertised === undefined ? {} : { attachmentReceiptReplay: advertised }),
      },
    });
    const decoded = decodeWire(wire);
    expect(decoded.type === "snapshot" && decoded.config.attachmentReceiptReplay).toBe(advertised);
  }
});

it.effect(
  "reuses workspace catalogs across status refreshes without losing changes or removals",
  () =>
    Effect.gen(function* () {
      const populated = {
        ...provider,
        workspaceSnapshots: Array.from({ length: 12 }, (_, index) => ({
          cwd: `/workspace/${index}`,
          checkedAt: provider.checkedAt,
          skills: [],
          slashCommands: [
            {
              name: "workspace",
              description: "Workspace-specific command documentation. ".repeat(1000).trim(),
            },
          ],
        })),
      };
      const changed = {
        ...populated,
        checkedAt: "2026-10-18T00:01:00.000Z",
        workspaceSnapshots: populated.workspaceSnapshots.map((entry) => ({
          ...entry,
          checkedAt: "2026-10-18T00:01:00.000Z",
        })),
      };
      const edited = {
        ...changed,
        workspaceSnapshots: [
          { ...changed.workspaceSnapshots[1]!, skills: [], slashCommands: [] },
          ...changed.workspaceSnapshots.slice(2).reverse(),
        ],
      };
      const events: ServerConfigStreamEvent[] = [
        { ...snapshot, config: { ...config, providers: [populated] } },
        statuses([changed]),
        statuses([edited]),
        statuses([]),
        { ...snapshot, config: { ...config, providers: [populated] } },
        statuses([changed]),
      ];
      const legacy = yield* run(events, true, true, false);
      const compact = yield* run(events, true, true, true);
      expect(JSON.stringify(legacy)).not.toContain("inheritsPreviousCatalog");
      expect(JSON.stringify(compact[1]).length).toBeLessThan(JSON.stringify(legacy[1]).length / 5);
      let state = Option.none<ServerConfigProjection>();
      for (const [index, event] of compact.entries()) {
        state = applyServerConfigProjection(state, decodeWire(encodeWire(event)));
        const original = events[index]!;
        expect(Option.getOrThrow(state).config.providers).toEqual(
          original.type === "snapshot"
            ? original.config.providers
            : original.type === "providerStatuses"
              ? original.payload.providers
              : [],
        );
      }
    }),
);

describe("server config transport", () => {
  it.effect.each([false, true])(
    "round-trips full configs and subsequent provider lists through the client (compact: %s)",
    (compactProviders) =>
      Effect.gen(function* () {
        const second = { ...provider, instanceId: ProviderInstanceId.make("second") };
        const changed = { ...withSnapshots, checkedAt: "2026-10-18T00:01:00.000Z" };
        const events: ReadonlyArray<ServerConfigStreamEvent> = [
          snapshot,
          statuses([second, changed]),
          statuses([changed, second]),
          statuses([second]),
          { ...snapshot, config: { ...config, availableEditors: ["vscode"] } },
          statuses([]),
        ];
        const sent = yield* run(events, compactProviders);
        let projected = Option.none<ServerConfigProjection>();
        let expected = config;
        for (const [index, wireEvent] of sent.entries()) {
          // Exercise the actual transport codec, not shared object identities.
          const decoded = yield* decodeWireJson(JSON.stringify(encodeWire(wireEvent)));
          projected = applyServerConfigProjection(projected, decoded);
          const original = events[index]!;
          if (original.type === "snapshot") expected = original.config;
          if (original.type === "providerStatuses")
            expected = { ...expected, providers: original.payload.providers };
          expect(Option.getOrThrow(projected).config).toEqual(expected);
          expect(Option.getOrThrow(projected).latestEvent).toEqual(original);
        }
      }),
  );

  it.effect.each([undefined, false])("preserves legacy bytes with opt-in %s", (optIn) =>
    Effect.gen(function* () {
      const events = [snapshot, statuses([withSnapshots]), statuses([])];
      const actual = yield* run(events, optIn);
      expect(actual).toEqual(events);
      for (const [index, event] of actual.entries()) {
        expect(event).toBe(events[index]);
        expect(JSON.stringify(encodeWire(event))).toBe(
          JSON.stringify(encodeLegacy(events[index]!)),
        );
      }
    }),
  );

  it.effect("deduplicates only identical catalogs, preserving each workspace's metadata", () =>
    Effect.gen(function* () {
      const events = yield* run([snapshot], true);
      const event = decodeWire(encodeWire(events[0]!));
      expect(event.type).toBe("snapshot");
      if (event.type !== "snapshot") throw new Error("Expected snapshot");
      expect(event.config.providers[0]?.workspaceSnapshots).toEqual([
        {
          cwd: "/workspace/one",
          checkedAt: provider.checkedAt,
          inheritsProviderCatalog: true,
        },
        {
          cwd: "/workspace/two",
          checkedAt: provider.checkedAt,
          slashCommandsPending: true,
          inheritsProviderCatalog: true,
        },
        withSnapshots.workspaceSnapshots![2],
        withSnapshots.workspaceSnapshots![3],
      ]);
      expect(withSnapshots.workspaceSnapshots![0]).toHaveProperty("skills");
    }),
  );

  it.effect("leaves out catalogs the subscriber holds, and the client restores them", () =>
    Effect.gen(function* () {
      const model = { slug: "big", name: "Big model", isCustom: false, capabilities: null };
      const withModels: ServerProvider = { ...withSnapshots, models: [model] };
      const refreshed = { ...withModels, checkedAt: "2026-10-18T00:01:00.000Z" };
      const newModel = { ...refreshed, models: [model, { ...model, slug: "bigger" }] };
      const events: ReadonlyArray<ServerConfigStreamEvent> = [
        { ...snapshot, config: { ...config, providers: [withModels] } },
        statuses([refreshed]),
        statuses([newModel]),
      ];
      const sent = yield* run(events, true, true);
      const sentProviders = sent.map((event) =>
        event.type === "providerStatuses" ? event.payload.providers : [],
      );
      expect(sentProviders[1]).toMatchObject([
        {
          models: [],
          skills: [],
          slashCommands: [],
          unchangedCatalogs: ["models", "skills", "slashCommands"],
        },
      ]);
      expect(sentProviders[2]).toMatchObject([
        { models: newModel.models, skills: [], unchangedCatalogs: ["skills", "slashCommands"] },
      ]);
      let projected = Option.none<ServerConfigProjection>();
      for (const [index, wireEvent] of sent.entries()) {
        const decoded = yield* decodeWireJson(JSON.stringify(encodeWire(wireEvent)));
        projected = applyServerConfigProjection(projected, decoded);
        const original = events[index]!;
        if (original.type === "snapshot")
          expect(Option.getOrThrow(projected).config.providers).toEqual(original.config.providers);
        if (original.type === "providerStatuses")
          expect(Option.getOrThrow(projected).config.providers).toEqual(original.payload.providers);
      }
    }),
  );

  it.effect("leaves catalogs a reconnecting client holds out of its first snapshot", () =>
    Effect.gen(function* () {
      const second = { ...provider, instanceId: ProviderInstanceId.make("second"), skills: [] };
      const digest = providerCatalogDigest(withSnapshots);
      const held: ServerProvider = { ...withSnapshots, catalogDigest: digest };
      const refreshed = { ...withSnapshots, checkedAt: "2026-10-18T00:01:00.000Z" };
      const events: ReadonlyArray<ServerConfigStreamEvent> = [
        { ...snapshot, config: { ...config, providers: [withSnapshots, second] } },
        statuses([refreshed, second]),
      ];
      const sent = yield* serverConfigTransport(Stream.fromIterable(events), {
        compactProviders: true,
        reuseProviderCatalogs: true,
        heldCatalogs: [
          { instanceId: withSnapshots.instanceId, catalogDigest: digest },
          // A stale digest gets the full catalogs.
          { instanceId: second.instanceId, catalogDigest: "stale" },
        ],
      }).pipe(Stream.runCollect);
      const first = sent[0]!;
      if (first.type !== "snapshot") throw new Error("Expected snapshot");
      expect(first.config.providers).toMatchObject([
        {
          skills: [],
          slashCommands: [],
          unchangedCatalogs: ["models", "skills", "slashCommands"],
          catalogDigest: digest,
        },
        { slashCommands: second.slashCommands, catalogDigest: providerCatalogDigest(second) },
      ]);
      expect(first.config.providers[1]).not.toHaveProperty("unchangedCatalogs");
      const update = sent[1]!;
      if (update.type !== "providerStatuses") throw new Error("Expected provider statuses");
      expect(update.payload.providers).toMatchObject([{ catalogDigest: digest }]);

      let projected = Option.none<ServerConfigProjection>();
      const expected = [
        [
          { ...withSnapshots, catalogDigest: digest },
          { ...second, catalogDigest: providerCatalogDigest(second) },
        ],
        [
          { ...refreshed, catalogDigest: digest },
          { ...second, catalogDigest: providerCatalogDigest(second) },
        ],
      ];
      for (const [index, wireEvent] of sent.entries()) {
        const decoded = yield* decodeWireJson(JSON.stringify(encodeWire(wireEvent)));
        projected = applyServerConfigProjection(projected, decoded, [held]);
        expect(Option.getOrThrow(projected).config.providers).toEqual(expected[index]);
      }
    }),
  );

  it.effect("compares with the last sent list and resets on a later snapshot", () =>
    Effect.gen(function* () {
      const second = { ...provider, instanceId: ProviderInstanceId.make("second") };
      const changed = { ...withSnapshots, status: "warning" as const };
      const events = yield* run(
        [
          snapshot,
          statuses([second, changed]),
          statuses([changed, second]),
          statuses([second]),
          { ...snapshot, config: { ...config, providers: [changed, second] } },
          statuses([changed, second]),
          statuses([]),
        ],
        true,
      );
      const payloads = events.map((event) => event.type === "providerStatuses" && event.payload);
      expect(payloads[1]).toMatchObject({
        providers: [
          { instanceId: second.instanceId },
          { instanceId: provider.instanceId, status: "warning" },
        ],
        removedProviderIds: [],
        providerOrder: [second.instanceId, provider.instanceId],
      });
      expect(payloads[2]).toEqual({
        providers: [],
        removedProviderIds: [],
        providerOrder: [provider.instanceId, second.instanceId],
      });
      expect(payloads[3]).toEqual({
        providers: [],
        removedProviderIds: [provider.instanceId],
        providerOrder: [second.instanceId],
      });
      expect(payloads[5]).toEqual({
        providers: [],
        removedProviderIds: [],
        providerOrder: [provider.instanceId, second.instanceId],
      });
      expect(payloads[6]).toEqual({
        providers: [],
        removedProviderIds: [provider.instanceId, second.instanceId],
        providerOrder: [],
      });
    }),
  );

  it.effect("keeps independent baselines for subscriptions and repeated stream runs", () =>
    Effect.gen(function* () {
      const update = statuses([withSnapshots]);
      const stream = serverConfigTransport(Stream.fromIterable([update, update]), {
        compactProviders: true,
      });
      const first = yield* Stream.runCollect(stream);
      const second = yield* Stream.runCollect(stream);
      expect(second).toEqual(first);
      expect(first[0]).toMatchObject({
        payload: { providers: [{ instanceId: provider.instanceId }] },
      });
      expect(first[1]).toMatchObject({ payload: { providers: [] } });
    }),
  );
});

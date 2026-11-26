import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { ServerConfigStreamWireEvent } from "@t3tools/contracts/serverConfigWire";
import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  applyServerConfigProjection,
  restoreCachedServerConfig,
} from "./serverConfigProjection.ts";
import {
  hasCompleteProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "../providerSkills.ts";

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
const snapshots = [
  { cwd: "/one", checkedAt: provider.checkedAt },
  { cwd: "/two", checkedAt: "2026-10-18T00:01:00.000Z", slashCommandsPending: true },
];
const withSnapshots = {
  ...provider,
  workspaceSnapshots: [
    ...snapshots.map((snapshot) => ({
      ...snapshot,
      skills: provider.skills,
      slashCommands: provider.slashCommands,
    })),
    { cwd: "/different", checkedAt: provider.checkedAt, skills: [], slashCommands: [] },
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
  keybindingsConfigPath: "/workspace/keybindings.json",
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
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
const fullSnapshot: ServerConfigStreamEvent = { version: 1, type: "snapshot", config };
const compactSnapshot: ServerConfigStreamWireEvent = {
  ...fullSnapshot,
  config: {
    ...config,
    providers: [
      {
        ...provider,
        workspaceSnapshots: [
          ...snapshots.map((snapshot) => ({ ...snapshot, inheritsProviderCatalog: true as const })),
          withSnapshots.workspaceSnapshots[2]!,
        ],
      },
    ],
  },
};
const decodeWire = Schema.decodeSync(ServerConfigStreamWireEvent);
const encodeWire = Schema.encodeSync(ServerConfigStreamWireEvent);
const encodeCanonical = Schema.encodeSync(ServerConfigStreamEvent);
const wireRoundTrip = (event: ServerConfigStreamWireEvent) => decodeWire(encodeWire(event));

const initial = () => applyServerConfigProjection(Option.none(), wireRoundTrip(compactSnapshot));

it("restores a cached Google model catalog without last version's quota windows", () => {
  const google = {
    ...provider,
    driver: ProviderDriverKind.make("antigravity"),
    auth: { status: "authenticated", type: "oauth-personal" },
    models: [{ slug: "gemini", name: "Gemini", isCustom: false, capabilities: null }],
    usageLimits: {
      checkedAt: provider.checkedAt,
      windows: [{ id: "old", label: "Weekly", kind: "weekly", usedPercent: 100 }],
    },
  } satisfies ServerProvider;
  const restored = restoreCachedServerConfig({ ...config, providers: [google, provider] });
  expect(restored.providers[0]).toMatchObject({
    models: google.models,
    usageLimits: {
      windows: [],
      unavailable: { reason: "unsupported", message: "Google doesn't share limits with apps yet" },
    },
  });
  expect(restored.providers[1]).toBe(provider);
});

describe("server config projection transport expansion", () => {
  it.each([fullSnapshot, compactSnapshot])("round-trips a full config through $type", (event) => {
    const projection = Option.getOrThrow(
      applyServerConfigProjection(Option.none(), wireRoundTrip(event)),
    );
    expect(projection.config).toEqual(config);
    expect(projection.latestEvent).toEqual(fullSnapshot);
    expect(encodeCanonical(projection.latestEvent)).toEqual(encodeCanonical(fullSnapshot));
    const expanded = projection.config.providers[0]!;
    expect(hasCompleteProviderWorkspaceSnapshot(expanded, "/one")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(expanded, "/two")).toBe(false);
    expect(resolveProviderSkillsForCwd(expanded, "/one")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(expanded, "/two")).toEqual(provider.slashCommands);
    expect(resolveProviderSkillsForCwd(expanded, "/different")).toEqual([]);
    expect(resolveProviderSlashCommandsForCwd(expanded, "/different")).toEqual([]);
  });

  it("merges changes, insertions, removals, reorder-only changes, and an empty list", () => {
    const second = { ...provider, instanceId: ProviderInstanceId.make("second") };
    const changed = {
      ...withSnapshots,
      skills: [], // Inherited catalogs must use this update, not the old provider.
      workspaceSnapshots: [{ ...snapshots[0]!, skills: [], slashCommands: provider.slashCommands }],
    };
    let state = initial();
    const delta = (
      providers: ReadonlyArray<typeof provider>,
      removedProviderIds: ProviderInstanceId[],
      providerOrder: ProviderInstanceId[],
    ) => {
      state = applyServerConfigProjection(
        state,
        wireRoundTrip({
          version: 1,
          type: "providerStatuses",
          payload: { providers, removedProviderIds, providerOrder },
        }),
      );
      return Option.getOrThrow(state);
    };
    const before = Option.getOrThrow(state).config.providers[0];
    const added = delta([second], [], [second.instanceId, provider.instanceId]);
    expect(added.config.providers).toEqual([second, withSnapshots]);
    expect(added.config.providers[1]).toBe(before);
    const reordered = delta([], [], [provider.instanceId, second.instanceId]);
    expect(reordered.config.providers).toEqual([withSnapshots, second]);
    expect(reordered.config.providers[0]).toBe(before);
    const next = applyServerConfigProjection(
      state,
      wireRoundTrip({
        version: 1,
        type: "providerStatuses",
        payload: {
          providers: [
            {
              ...changed,
              workspaceSnapshots: [{ ...snapshots[0]!, inheritsProviderCatalog: true }],
            },
          ],
          removedProviderIds: [],
          providerOrder: [provider.instanceId, second.instanceId],
        },
      }),
    );
    state = next;
    expect(Option.getOrThrow(next).config.providers).toEqual([changed, second]);
    expect(Option.getOrThrow(next).config.providers[1]).toBe(reordered.config.providers[1]);
    expect(delta([], [provider.instanceId], [second.instanceId]).config.providers).toEqual([
      second,
    ]);
    expect(delta([], [second.instanceId], []).config.providers).toEqual([]);
  });

  it("keeps equal provider catalogs identical even on legacy full-list pushes", () => {
    const state = initial();
    const before = Option.getOrThrow(state).config.providers[0]!;
    const unchanged = Option.getOrThrow(
      applyServerConfigProjection(
        state,
        wireRoundTrip({
          version: 1,
          type: "providerStatuses",
          payload: { providers: [withSnapshots] },
        }),
      ),
    );
    expect(unchanged.config.providers[0]).toBe(before);
    expect(unchanged.config.providers).toBe(Option.getOrThrow(state).config.providers);
    const updated = Option.getOrThrow(
      applyServerConfigProjection(
        state,
        wireRoundTrip({
          version: 1,
          type: "providerStatuses",
          payload: { providers: [{ ...withSnapshots, checkedAt: "2026-10-18T00:05:00.000Z" }] },
        }),
      ),
    );
    expect(updated.config.providers[0]).not.toBe(before);
    expect(updated.config.providers[0]!.skills).toBe(before.skills);
    expect(updated.config.providers[0]!.slashCommands).toBe(before.slashCommands);
    expect(updated.config.providers[0]!.workspaceSnapshots).toBe(before.workspaceSnapshots);
  });

  it("ignores delta events before the initial snapshot", () => {
    expect(
      Option.isNone(
        applyServerConfigProjection(Option.none(), {
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: [provider],
            removedProviderIds: [],
            providerOrder: [provider.instanceId],
          },
        }),
      ),
    ).toBe(true);
  });
});

it("projects owner tab updates and clears a removed server without changing provider catalogs", () => {
  const initial = applyServerConfigProjection(Option.none(), {
    version: 1,
    type: "snapshot",
    config,
  });
  const next = applyServerConfigProjection(initial, {
    version: 1,
    type: "chatTabsUpdated",
    payload: {
      tabs: [{ name: "Build", position: 0, keepEmpty: true, icon: { kind: "emoji", emoji: "🔧" } }],
    },
  });
  expect(Option.getOrThrow(next).config.chatTabs?.[0]?.name).toBe("Build");
  expect(Option.getOrThrow(next).config.providers).toBe(
    Option.getOrThrow(initial).config.providers,
  );
  const removed = applyServerConfigProjection(next, {
    version: 1,
    type: "chatTabsUpdated",
    payload: { tabs: [] },
  });
  expect(Option.getOrThrow(removed).config.chatTabs).toEqual([]);
});

const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });

  it("keeps the settings object when an update repeats the current settings", () => {
    const wire = encodeSettings(DEFAULT_SERVER_SETTINGS);
    const decode = () => decodeSettings(structuredClone(wire));
    const settings = decode();
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: { settings: decode() },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(next).config).toBe(Option.getOrThrow(current).config);
  });
});

describe("applyServerConfigProjection storage", () => {
  const storage = {
    label: "Google Drive",
    totalBytes: 21990232555520,
    usedBytes: 1319413953331,
    trashedBytes: 0,
    checkedAt: "2026-11-19T12:00:00.000Z",
  };
  const capable: ServerConfig = {
    ...config,
    environment: {
      ...config.environment,
      capabilities: { ...config.environment.capabilities, usageLimitSources: true },
    },
  };
  const sourcesEvent = (payload: { sources: []; storage?: typeof storage }) =>
    decodeWire(encodeWire({ version: 1, type: "usageLimitSourcesUpdated", payload }));

  it("arrives with the sources event, survives a reconnect, and leaves when the server drops it", () => {
    const connected = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: capable,
    });
    const withStorage = applyServerConfigProjection(
      connected,
      sourcesEvent({ sources: [], storage }),
    );
    expect(Option.getOrThrow(withStorage).config.storage).toEqual(storage);

    // A reconnect snapshot never carries it; the held reading stays until the stream replays.
    const reconnected = applyServerConfigProjection(withStorage, {
      version: 1,
      type: "snapshot",
      config: capable,
    });
    expect(Option.getOrThrow(reconnected).config.storage).toEqual(storage);

    const dropped = applyServerConfigProjection(reconnected, sourcesEvent({ sources: [] }));
    expect(Option.getOrThrow(dropped).config.storage).toBeUndefined();
  });

  it("clears it on a server that cannot send storage", () => {
    const withStorage = applyServerConfigProjection(
      applyServerConfigProjection(Option.none(), { version: 1, type: "snapshot", config: capable }),
      sourcesEvent({ sources: [], storage }),
    );
    const downgraded = applyServerConfigProjection(withStorage, fullSnapshot);
    expect(Option.getOrThrow(downgraded).config.storage).toBeUndefined();
  });
});

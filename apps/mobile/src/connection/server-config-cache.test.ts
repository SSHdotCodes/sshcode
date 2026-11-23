import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { cachedConfigFixture } from "./server-config-cache.test-fixtures";
import {
  decodeStoredServerConfig,
  encodeStoredServerConfig,
  StoredServerConfig,
} from "./server-config-cache";

const legacyDecode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredServerConfig));
const encodeLegacy = Schema.encodeEffect(StoredServerConfig);

it.effect("keeps the canonical cache format and restores complete workspace catalogs", () =>
  Effect.gen(function* () {
    const config = cachedConfigFixture(3, 10);
    const provider = config.providers[0]!;
    const stored = {
      schemaVersion: 1 as const,
      environmentId: "cache-fixture",
      config: {
        ...config,
        providers: [
          {
            ...provider,
            workspaceSnapshots: [
              ...provider.workspaceSnapshots!,
              { ...provider.workspaceSnapshots![0]!, cwd: "/different", skills: [] },
              { ...provider.workspaceSnapshots![0]!, cwd: "/pending", slashCommandsPending: true },
              { ...provider.workspaceSnapshots![0]!, cwd: "/no-commands", slashCommands: [] },
            ],
          },
          ...config.providers.slice(1),
        ],
      },
    };
    const raw = yield* encodeStoredServerConfig(stored);
    const legacy = yield* legacyDecode(raw);
    const current = yield* decodeStoredServerConfig(raw);
    expect(current).toEqual(legacy);
    expect(yield* encodeStoredServerConfig(current)).toBe(raw);
    expect(raw).not.toContain("inheritsProviderCatalog");
  }),
);

it.effect(
  "preserves validation and forward-compatible provider filtering for old cache records",
  () =>
    Effect.gen(function* () {
      const config = cachedConfigFixture();
      const provider = config.providers[0]!;
      const encoded = yield* encodeLegacy({
        schemaVersion: 1,
        environmentId: "cache-fixture",
        config,
      });
      const cases = [
        {
          ...provider,
          workspaceSnapshots: [
            { cwd: "/bad", checkedAt: provider.checkedAt, inheritsProviderCatalog: true },
          ],
        },
        { ...provider, skills: [{ name: 123 }], workspaceSnapshots: [] },
        { ...provider, models: [{ id: 123 }] },
        {
          ...provider,
          workspaceSnapshots: [{ ...provider.workspaceSnapshots![0]!, checkedAt: "invalid" }],
        },
        { ...provider, unchangedCatalogs: ["models"], workspaceSnapshots: undefined },
      ];
      for (const invalid of cases) {
        const raw = JSON.stringify({
          schemaVersion: 1,
          environmentId: "cache-fixture",
          config: {
            ...encoded.config,
            providers: [invalid, provider],
          },
        });
        expect(yield* decodeStoredServerConfig(raw)).toEqual(yield* legacyDecode(raw));
      }
      for (const raw of [
        "{",
        "{}",
        JSON.stringify({ schemaVersion: 2, environmentId: "cache-fixture", config }),
      ]) {
        expect((yield* Effect.result(decodeStoredServerConfig(raw)))._tag).toBe("Failure");
      }
    }),
);

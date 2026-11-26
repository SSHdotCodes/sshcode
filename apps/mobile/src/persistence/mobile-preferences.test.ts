import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-sqlite", () => ({}));
vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function preferencesStorage(payload: string, fallbackPayload?: string) {
  let fallback =
    fallbackPayload === undefined
      ? null
      : JSON.stringify({ payload: fallbackPayload, updatedAt: 2 });
  let stored: MobileDatabase.StoredPreferencesJson = { payload, updatedAt: 1 };
  const unused = Effect.die("Unexpected cache operation");
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => unused,
    listCache: () => unused,
    saveCache: () => unused,
    removeCache: () => unused,
    clearCacheKind: () => unused,
    clearEnvironmentCache: () => unused,
    clearAllCaches: unused,
    inspectCaches: unused,
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (next, updatedAt) =>
      Effect.sync(() => {
        stored = { payload: next, updatedAt };
      }),
  });
  const secure = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.succeed(key === "t3code.preferences.fallback" ? fallback : null),
    setItem: () => Effect.void,
    removeItem: () =>
      Effect.sync(() => {
        fallback = null;
      }),
  });
  return MobilePreferences.make().pipe(
    Effect.provideService(MobileDatabase.MobileDatabase, database),
    Effect.provideService(MobileSecureStorage.MobileSecureStorage, secure),
  );
}

describe("harness theme preferences", () => {
  it.effect(
    "round-trips device choices across store instances and retains unrelated preferences",
    () =>
      Effect.gen(function* () {
        const storage = preferencesStorage(
          JSON.stringify({ themeMode: "light", baseFontSize: 18 }),
        );
        const first = yield* storage;
        expect((yield* first.load).harnessThemes).toBeUndefined();
        const harnessThemes = {
          enabled: false,
          choices: { codex: "default", claudeAgent: "preset:muse", grok: "theme:t3-chat" },
        };
        yield* first.savePatch({ harnessThemes });
        const relaunched = yield* storage;
        expect(yield* relaunched.load).toEqual({
          themeMode: "light",
          baseFontSize: 18,
          harnessThemes,
        });
        yield* relaunched.savePatch({ harnessThemes: { enabled: true, choices: {} } });
        const reset = yield* storage;
        expect((yield* reset.load).harnessThemes).toEqual({ enabled: true, choices: {} });
      }),
  );

  it.effect("sanitizes old or corrupt theme settings without dropping valid app preferences", () =>
    Effect.gen(function* () {
      const store = yield* preferencesStorage(
        JSON.stringify({
          themeMode: "dark",
          harnessThemes: { enabled: false, choices: { codex: "preset:claude", muse: null } },
        }),
      );
      expect(yield* store.load).toEqual({
        themeMode: "dark",
        harnessThemes: { enabled: false, choices: { codex: "preset:claude" } },
      });
    }),
  );
});

describe("thread header preferences", () => {
  it.effect(
    "round-trips enabled shortcuts and an empty selection without resetting appearance",
    () =>
      Effect.gen(function* () {
        const storage = preferencesStorage(JSON.stringify({ themeMode: "dark", baseFontSize: 18 }));
        const first = yield* storage;
        expect((yield* first.load).threadHeaderItems).toBeUndefined();
        yield* first.savePatch({ threadHeaderItems: ["sideChat", "files", "terminal"] });
        const relaunched = yield* storage;
        expect(yield* relaunched.load).toEqual({
          themeMode: "dark",
          baseFontSize: 18,
          threadHeaderItems: ["sideChat", "files", "terminal"],
        });
        yield* relaunched.savePatch({ threadHeaderItems: [] });
        const empty = yield* storage;
        expect((yield* empty.load).threadHeaderItems).toEqual([]);
      }),
  );

  it.effect("sanitizes unknown shortcuts without dropping valid preferences", () =>
    Effect.gen(function* () {
      const store = yield* preferencesStorage(
        JSON.stringify({
          themeMode: "dark",
          threadHeaderItems: ["files", "files", "terminal", "mergeBack", false],
        }),
      );
      expect(yield* store.load).toEqual({
        themeMode: "dark",
        threadHeaderItems: ["files", "terminal"],
      });
    }),
  );
});

describe("chat list layout preference", () => {
  it.effect("ignores retired device-local tab visibility while keeping the selected folder", () =>
    Effect.gen(function* () {
      const store = yield* preferencesStorage(
        '{"chatListTabsEnabled":false,"threadListChatTab":"work"}',
      );
      expect(yield* store.load).toEqual({ threadListChatTab: "work" });
    }),
  );

  it.effect("ignores the old boxes-by-default layout and keeps an explicit boxes choice", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage(
        JSON.stringify({ themeMode: "dark", threadListLayout: "boxes" }),
      );
      const first = yield* storage;
      // The classic list is the default again, even for devices that saved the old layout.
      expect((yield* first.load).threadListBoxes).toBeUndefined();
      yield* first.savePatch({ threadListBoxes: true });
      const relaunched = yield* storage;
      expect((yield* relaunched.load).threadListBoxes).toBe(true);
    }),
  );

  it.effect("ignores the retired shelf key and keeps other shelf preferences", () =>
    Effect.gen(function* () {
      const store = yield* preferencesStorage(
        JSON.stringify({
          threadListLongRunningShelfExpanded: false,
          threadListSnoozedShelfExpanded: true,
        }),
      );

      expect(yield* store.load).toEqual({ threadListSnoozedShelfExpanded: true });
    }),
  );
});

describe("UI mode preference", () => {
  it.effect("defaults to unset and persists the device choice without changing the theme", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark","themeId":"grove"}');
      const store = yield* storage;
      expect((yield* store.load).uiMode).toBeUndefined();
      yield* store.savePatch({ uiMode: "discord" });
      const reopened = yield* storage;
      expect(yield* reopened.load).toEqual({
        themeMode: "dark",
        themeId: "grove",
        uiMode: "discord",
      });
      yield* reopened.savePatch({ uiMode: "default" });
      expect((yield* reopened.load).uiMode).toBe("default");
    }),
  );
  it.effect("discards an unknown UI mode while retaining valid preferences", () =>
    Effect.gen(function* () {
      const store = yield* preferencesStorage('{"themeMode":"light","uiMode":"unknown"}');
      expect(yield* store.load).toEqual({ themeMode: "light" });
    }),
  );
});

describe("casual voice", () => {
  it.effect("stays unset until this phone turns it on", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark"}');
      const store = yield* storage;
      expect((yield* store.load).casualVoice).toBeUndefined();
      yield* store.savePatch({ casualVoice: true });
      expect((yield* (yield* storage).load).casualVoice).toBe(true);
      yield* (yield* storage).savePatch({ casualVoice: false });
      expect((yield* (yield* storage).load).casualVoice).toBe(false);
    }),
  );
});

describe("Discord profile preferences", () => {
  it.effect("stores and removes a bounded local picture across launches", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark"}');
      const first = yield* storage;
      const image = "data:image/jpeg;base64,aGVsbG8=";
      yield* first.savePatch({ discordProfileImage: image });
      expect((yield* (yield* storage).load).discordProfileImage).toBe(image);
      yield* first.savePatch({ discordProfileImage: null });
      expect((yield* (yield* storage).load).discordProfileImage).toBeNull();
    }),
  );
  it.effect("rejects remote and oversized images without losing preferences", () =>
    Effect.gen(function* () {
      const storage = yield* preferencesStorage(
        JSON.stringify({
          themeMode: "dark",
          discordProfileImage: "https://example.test/avatar.png",
        }),
      );
      expect(yield* storage.load).toEqual({ themeMode: "dark", discordProfileImage: null });
      yield* storage.savePatch({
        discordProfileImage: "data:image/png;base64," + "a".repeat(96_001),
      });
      expect((yield* storage.load).discordProfileImage).toBeNull();
    }),
  );
});

it.effect("persists screen recording privacy per device and retains other preferences", () =>
  Effect.gen(function* () {
    const storage = preferencesStorage(JSON.stringify({ themeMode: "dark" }));
    const first = yield* storage;
    expect((yield* first.load).screenRecordingPrivacy).toBeUndefined();
    yield* first.savePatch({ screenRecordingPrivacy: true });
    const relaunched = yield* storage;
    expect(yield* relaunched.load).toMatchObject({
      themeMode: "dark",
      screenRecordingPrivacy: true,
    });
    yield* relaunched.savePatch({ screenRecordingPrivacy: false });
    expect((yield* (yield* storage).load).screenRecordingPrivacy).toBe(false);
  }),
);

describe("workflows beta", () => {
  it.effect("stays off until this phone opts in and persists both directions", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark"}');
      const store = yield* storage;
      expect((yield* store.load).workflowsBeta).toBeUndefined();
      yield* store.savePatch({ workflowsBeta: true });
      expect((yield* (yield* storage).load).workflowsBeta).toBe(true);
      yield* (yield* storage).savePatch({ workflowsBeta: false });
      expect((yield* (yield* storage).load).workflowsBeta).toBe(false);
    }),
  );
});

describe("new chat dashboard preference", () => {
  it.effect("defaults to on and keeps explicit off and on choices across launches", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark"}');
      const initial = yield* storage;
      expect((yield* initial.load).newChatDashboardEnabled).toBeUndefined();
      yield* initial.savePatch({ newChatDashboardEnabled: false });
      const reopened = yield* storage;
      expect(yield* reopened.load).toEqual({
        themeMode: "dark",
        newChatDashboardEnabled: false,
      });
      yield* reopened.savePatch({ newChatDashboardEnabled: true });
      expect((yield* (yield* storage).load).newChatDashboardEnabled).toBe(true);
    }),
  );

  it.effect("ignores invalid values while retaining unrelated preferences", () =>
    Effect.gen(function* () {
      for (const value of [null, 0, "false", {}]) {
        const store = yield* preferencesStorage(
          JSON.stringify({ themeMode: "light", newChatDashboardEnabled: value }),
        );
        expect(yield* store.load).toEqual({ themeMode: "light" });
      }
    }),
  );

  it.effect("restores an explicit off choice from newer fallback storage", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage(
        '{"themeMode":"light","newChatDashboardEnabled":true}',
        '{"themeMode":"dark","newChatDashboardEnabled":false}',
      );
      const restored = yield* storage;
      expect(yield* restored.load).toEqual({
        themeMode: "dark",
        newChatDashboardEnabled: false,
      });
      expect((yield* (yield* storage).load).newChatDashboardEnabled).toBe(false);
    }),
  );
});

describe("chat backdrop preference", () => {
  it.effect("stays opt-in and retains both choices independently of dashboard cards", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark","newChatDashboardEnabled":false}');
      const initial = yield* storage;
      expect((yield* initial.load).chatBackdropEnabled).toBeUndefined();
      for (const enabled of [true, false]) {
        yield* (yield* storage).savePatch({ chatBackdropEnabled: enabled });
        expect(yield* (yield* storage).load).toEqual({
          themeMode: "dark",
          newChatDashboardEnabled: false,
          chatBackdropEnabled: enabled,
        });
      }
    }),
  );
  it.effect("discards malformed values without changing other preferences", () =>
    Effect.gen(function* () {
      for (const chatBackdropEnabled of [null, 1, "true", {}]) {
        const store = yield* preferencesStorage(
          JSON.stringify({ themeMode: "light", chatBackdropEnabled }),
        );
        expect(yield* store.load).toEqual({ themeMode: "light" });
      }
    }),
  );
});

describe("bedside screen preference", () => {
  it.effect("is unset by default and keeps an explicit choice", () =>
    Effect.gen(function* () {
      const storage = preferencesStorage('{"themeMode":"dark"}');
      expect((yield* (yield* storage).load).bedsideScreenEnabled).toBeUndefined();
      for (const enabled of [false, true]) {
        yield* (yield* storage).savePatch({ bedsideScreenEnabled: enabled });
        expect(yield* (yield* storage).load).toEqual({
          themeMode: "dark",
          bedsideScreenEnabled: enabled,
        });
      }
    }),
  );
  it.effect("discards malformed values", () =>
    Effect.gen(function* () {
      for (const bedsideScreenEnabled of [null, 0, "false", []]) {
        const store = yield* preferencesStorage(
          JSON.stringify({ themeMode: "light", bedsideScreenEnabled }),
        );
        expect(yield* store.load).toEqual({ themeMode: "light" });
      }
    }),
  );
});

describe("MobilePreferences.load concurrency", () => {
  it.effect("reads SQLite preferences and the secure-store fallback concurrently on launch", () =>
    Effect.gen(function* () {
      const dbStarted = yield* Deferred.make<void>();
      const releaseDb = yield* Deferred.make<void>();
      const fallbackStarted = yield* Deferred.make<void>();
      const unused = Effect.die("Unexpected cache operation");
      const database = MobileDatabase.MobileDatabase.of({
        loadCache: () => unused,
        listCache: () => unused,
        saveCache: () => unused,
        removeCache: () => unused,
        clearCacheKind: () => unused,
        clearEnvironmentCache: () => unused,
        clearAllCaches: unused,
        inspectCaches: unused,
        loadPreferencesJson: Deferred.succeed(dbStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDb)),
          Effect.as(Option.some({ payload: '{"themeMode":"dark"}', updatedAt: 1 })),
        ),
        savePreferencesJson: () => Effect.void,
      });
      const secure = MobileSecureStorage.MobileSecureStorage.of({
        getItem: () => Deferred.succeed(fallbackStarted, undefined).pipe(Effect.as(null)),
        setItem: () => Effect.void,
        removeItem: () => Effect.void,
      });
      const store = yield* MobilePreferences.make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, database),
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, secure),
      );
      const loading = yield* store.load.pipe(Effect.forkChild);
      yield* Deferred.await(dbStarted);
      // Must reach secureStorage.getItem before SQLite finishes (proves parallel execution).
      yield* Deferred.await(fallbackStarted);
      yield* Deferred.succeed(releaseDb, undefined);
      expect(yield* Fiber.join(loading)).toEqual({ themeMode: "dark" });
    }),
  );
});

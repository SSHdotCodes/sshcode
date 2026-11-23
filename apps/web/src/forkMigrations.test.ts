import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import { migrateFollowUpBehaviorToSteer, STEER_DEFAULT_MIGRATION_KEY } from "./forkMigrations";
import { __resetClientSettingsPersistenceForTests, getClientSettings } from "./hooks/useSettings";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  persistenceMocks.getClientSettings
    .mockReset()
    .mockResolvedValue({ ...DEFAULT_CLIENT_SETTINGS, followUpBehavior: "queue" });
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

describe("migrateFollowUpBehaviorToSteer", () => {
  it("switches a saved queue default to steer once", async () => {
    const storage = memoryStorage();

    await migrateFollowUpBehaviorToSteer(storage);

    expect(getClientSettings().followUpBehavior).toBe("steer");
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledWith(
      expect.objectContaining({ followUpBehavior: "steer" }),
    );
    expect(storage.getItem(STEER_DEFAULT_MIGRATION_KEY)).not.toBeNull();
  });

  it("leaves a later choice of queue alone", async () => {
    const storage = memoryStorage();
    storage.setItem(STEER_DEFAULT_MIGRATION_KEY, "done");

    await migrateFollowUpBehaviorToSteer(storage);

    expect(persistenceMocks.getClientSettings).not.toHaveBeenCalled();
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("retries on the next launch when the settings write fails", async () => {
    const storage = memoryStorage();
    persistenceMocks.setClientSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(migrateFollowUpBehaviorToSteer(storage)).rejects.toThrow("disk full");

    expect(storage.getItem(STEER_DEFAULT_MIGRATION_KEY)).toBeNull();
  });
});

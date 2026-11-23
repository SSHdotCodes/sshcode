import type { ClientSettings } from "@t3tools/contracts/settings";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";

export const STEER_DEFAULT_MIGRATION_KEY = "t3code-fork:migration:steer-default-v1";

type MarkerStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Follow-ups used to default to "queue", and that default was persisted with
 * every other client setting. Steer is the default now, so flip a saved
 * "queue" to "steer" once per app profile. The marker is written only after
 * the settings write succeeds, and choosing "queue" again later sticks.
 */
export async function migrateFollowUpBehaviorToSteer(
  storage: MarkerStorage | undefined = readMarkerStorage(),
  persist?: (settings: ClientSettings) => Promise<void>,
): Promise<void> {
  if (!storage || storage.getItem(STEER_DEFAULT_MIGRATION_KEY) !== null) return;
  await persistClientSettingsUpdate(
    (current) =>
      current.followUpBehavior === "queue" ? { ...current, followUpBehavior: "steer" } : current,
    persist,
  );
  storage.setItem(STEER_DEFAULT_MIGRATION_KEY, new Date().toISOString());
}

function readMarkerStorage(): MarkerStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

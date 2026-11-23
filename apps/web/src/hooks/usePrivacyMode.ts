import { useCallback } from "react";
import { privacyLabel } from "@t3tools/client-runtime/privacy";
import { useClientSettings, useClientSettingsHydrated } from "./useSettings";

export function usePrivacyMode() {
  const enabled = useClientSettings((settings) => settings.screenRecordingPrivacy);
  // Do not flash real names while a saved privacy preference is loading.
  return !useClientSettingsHydrated() || enabled;
}

export function usePrivacyLabel() {
  const enabled = usePrivacyMode();
  return useCallback(
    (kind: Parameters<typeof privacyLabel>[1], identity: string, label: string) =>
      privacyLabel(enabled, kind, identity, label),
    [enabled],
  );
}

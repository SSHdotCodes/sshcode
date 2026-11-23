import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { privacyLabel } from "@t3tools/client-runtime/privacy";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

export function usePrivacySetting() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const enabled = ready && preferences.value.screenRecordingPrivacy === true;
  const setEnabled = useCallback(
    (screenRecordingPrivacy: boolean) => save({ screenRecordingPrivacy }),
    [save],
  );
  return { ready, enabled, setEnabled };
}

export function usePrivacyMode() {
  const { ready, enabled } = usePrivacySetting();
  return !ready || enabled;
}

export function usePrivacyLabel() {
  const enabled = usePrivacyMode();
  return useCallback(
    (kind: Parameters<typeof privacyLabel>[1], identity: string, label: string) =>
      privacyLabel(enabled, kind, identity, label),
    [enabled],
  );
}

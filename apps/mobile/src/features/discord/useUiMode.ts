import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { casualVoiceActive } from "@t3tools/shared/casualVoice";
import { DEFAULT_UI_MODE, type UiMode } from "@t3tools/shared/harnessThemes";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useUiMode() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const mode = AsyncResult.isSuccess(preferences)
    ? (preferences.value.uiMode ?? DEFAULT_UI_MODE)
    : DEFAULT_UI_MODE;
  const setMode = useCallback((uiMode: UiMode) => save({ uiMode }), [save]);
  return [mode, setMode] as const;
}

/** Off until this phone turns the preview on. Discord mode does not turn it on. */
export function useCasualVoiceSetting() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled = AsyncResult.isSuccess(preferences) && preferences.value.casualVoice === true;
  const setEnabled = useCallback((casualVoice: boolean) => save({ casualVoice }), [save]);
  return [enabled, setEnabled] as const;
}

export function useCasualVoiceActive() {
  const [enabled] = useCasualVoiceSetting();
  return casualVoiceActive(enabled);
}

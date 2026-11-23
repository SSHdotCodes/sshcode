import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** On unless this device switched it off; wait for preferences before displaying it. */
export function useNewChatDashboardEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.newChatDashboardEnabled !== false;
  const setEnabled = useCallback(
    (value: boolean) => save({ newChatDashboardEnabled: value }),
    [save],
  );
  return [enabled, setEnabled];
}

/** Independent of the empty-chat cards, and opt-in on each device. */
export function useChatBackdropEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.chatBackdropEnabled === true;
  const setEnabled = useCallback((value: boolean) => save({ chatBackdropEnabled: value }), [save]);
  return [enabled, setEnabled];
}

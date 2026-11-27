import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { WEBSITE_ICONS_DEFAULT } from "@t3tools/contracts";
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

/**
 * Whether tool activity loads site icons from the network on this device. Unset
 * follows `WEBSITE_ICONS_DEFAULT`; until preferences load it is off, so a device
 * that turned icons off never fetches one during startup.
 */
export function useWebsiteIconsEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) &&
    (preferences.value.websiteIconsEnabled ?? WEBSITE_ICONS_DEFAULT);
  const setEnabled = useCallback((value: boolean) => save({ websiteIconsEnabled: value }), [save]);
  return [enabled, setEnabled];
}

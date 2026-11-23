import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Shared persisted shelf state for the compact Home list and iPad sidebar.
 * The ref advances before persistence starts so consecutive presses always
 * toggle the latest value, even if React has not rendered the optimistic patch
 * yet.
 */
export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  // Working section beta: off until the preference loads and is enabled. Only
  // the arrangement sheet still reads it.
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const settledShelfExpandedRef = useRef(settledShelfExpanded);
  useEffect(() => {
    settledShelfExpandedRef.current = settledShelfExpanded;
  }, [settledShelfExpanded]);
  const snoozedShelfExpandedRef = useRef(snoozedShelfExpanded);
  snoozedShelfExpandedRef.current = snoozedShelfExpanded;

  const toggleSnoozedShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !snoozedShelfExpandedRef.current;
    snoozedShelfExpandedRef.current = expanded;
    savePreferences({ threadListSnoozedShelfExpanded: expanded });
  }, [loaded, savePreferences]);

  const toggleSettledShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !settledShelfExpandedRef.current;
    settledShelfExpandedRef.current = expanded;
    savePreferences({ threadListSettledShelfExpanded: expanded });
  }, [loaded, savePreferences]);

  return {
    loaded,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    workingShelfEnabled,
    toggleSnoozedShelf,
  } as const;
}

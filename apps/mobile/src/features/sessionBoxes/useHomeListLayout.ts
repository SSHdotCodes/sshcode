import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** The classic rows unless this device turned on session boxes in Settings. */
export function useHomeListLayout() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const layout =
    AsyncResult.isSuccess(preferences) && preferences.value.threadListBoxes === true
      ? ("boxes" as const)
      : ("list" as const);
  const setLayout = useCallback(
    (next: "boxes" | "list") => save({ threadListBoxes: next === "boxes" }),
    [save],
  );
  return [layout, setLayout] as const;
}

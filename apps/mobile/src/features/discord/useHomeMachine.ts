import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useHomeMachine() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadListFilters?.environmentId ?? null)
    : null;
  const select = useCallback(
    (id: string | null) =>
      save({
        threadListFilters: {
          environmentId: id === null ? null : EnvironmentId.make(id),
          projectKey: null,
        },
      }),
    [save],
  );
  return [selected, select] as const;
}

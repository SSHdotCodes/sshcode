import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useMemo } from "react";
import { mobilePreferencesAtom } from "../../state/preferences";

export function useModelMentionCatalog(settings: ServerSettings | undefined) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return useMemo(
    () => ({
      providerInstances: settings?.providerInstances,
      favorites: resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
        favorites: AsyncResult.isSuccess(preferences)
          ? (preferences.value.modelFavorites ?? [])
          : [],
      }).favorites.map((favorite) => ({ instanceId: favorite.provider, slug: favorite.model })),
    }),
    [settings, preferences],
  );
}

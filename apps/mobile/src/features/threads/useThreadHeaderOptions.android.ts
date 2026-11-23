import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export function useThreadHeaderOptions(
  props: Parameters<typeof useIosThreadHeaderOptions>[0],
): ReturnType<typeof useIosThreadHeaderOptions> {
  const { threadHeaderItems: visibleHeaderItems } = useAppearancePreferences();
  return {
    options: { contentStyle: { backgroundColor: props.headerColor } },
    // ThreadHeader filters Android's rendered actions with the same device preferences.
    visibleHeaderItems,
    optionsVersion: [],
    sidebar: true,
    fallback: null,
  };
}

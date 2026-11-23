import { useMemo } from "react";
import { Platform } from "react-native";

import { mobileHarnessProseStyle } from "../../../lib/harnessThemes";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export function useHarnessProseStyle() {
  const { appearance, harnessThemePreset } = useAppearancePreferences();
  return useMemo(
    () => mobileHarnessProseStyle(harnessThemePreset, appearance.baseFontSize, Platform.OS),
    [appearance.baseFontSize, harnessThemePreset],
  );
}

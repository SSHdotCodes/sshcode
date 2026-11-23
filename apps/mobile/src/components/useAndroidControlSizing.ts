import { Platform, useWindowDimensions } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { DEFAULT_BASE_FONT_SIZE } from "../lib/appearancePreferences";
import { resolveAndroidControlSizing } from "../lib/androidControlSizing";
import { resolveComposerControlLayout } from "../lib/composerControlLayout";

/** Shared layouts keep their existing dimensions on iOS. */
export function useAndroidControlSizing() {
  const { appearance } = useAppearancePreferences();
  return resolveAndroidControlSizing(
    Platform.OS === "android" ? appearance.baseFontSize : DEFAULT_BASE_FONT_SIZE,
  );
}

/** Text controls follow both the app's font size and system Dynamic Type. */
export function useComposerControlLayout() {
  const { fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  return resolveComposerControlLayout(appearance.baseFontSize, fontScale);
}

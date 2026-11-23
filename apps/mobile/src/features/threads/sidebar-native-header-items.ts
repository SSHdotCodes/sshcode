import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

/**
 * Right-side UINavigationBar items for the sidebar column: the settings
 * button in a glass capsule — the Messages-style header button. The embedded
 * sidebar keeps it beside its title; only the detail column uses the Duo's
 * vertical bar.
 */
export function createSidebarHeaderItems(input: {
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      axisBehavior: "horizontalOnly",
      label: "Settings",
      accessibilityLabel: "Open settings",
      icon: { type: "sfSymbol", name: "gearshape" } as const,
      onPress: input.onOpenSettings,
    }),
  ];
}

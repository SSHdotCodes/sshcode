import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
// oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- SVG extracts Stop children; wrapping them loses their theme color.
import { useUniwindTheme } from "../../lib/useUniwindTheme";

/** Soften the transcript-list edge above UIKit's floating bottom controls. */
export function HomeControlsFade({ clearance }: { readonly clearance: number }) {
  const color = String(useUniwindTheme()["--color-screen"]);
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 bottom-0"
      style={{ height: clearance + 32 }}
    >
      <Svg width="100%" height={32}>
        <Defs>
          <LinearGradient id="home-controls-fade" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={color} stopOpacity={0} />
            <Stop offset="100%" stopColor={color} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#home-controls-fade)" />
      </Svg>
      <View className="flex-1 bg-screen" />
    </View>
  );
}

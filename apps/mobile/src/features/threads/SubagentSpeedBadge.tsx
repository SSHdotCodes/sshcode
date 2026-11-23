import {
  type SubagentSpeed,
  ULTRAFAST_BOLTS,
} from "@t3tools/client-runtime/state/subagent-display";
import { View } from "react-native";
import { Path, Svg } from "react-native-svg";

import { SymbolView } from "../../components/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** A subagent started at Fast or Ultrafast: the composer's speed mark on its avatar's corner. */
export function SubagentSpeedBadge(props: { readonly speed: SubagentSpeed }) {
  const { themeAppearance } = useAppearancePreferences();
  const color = themeAppearance === "dark" ? "#e5e5e5" : "#171717";
  return (
    <View
      accessible={false}
      className="absolute -right-1 -top-1 h-[15px] w-[15px] items-center justify-center rounded-full border border-border bg-screen"
    >
      {props.speed === "ultrafast" ? (
        <Svg width={10} height={10} viewBox="0 0 24 24">
          <Path d={ULTRAFAST_BOLTS.back} fill={color} opacity={0.4} />
          <Path d={ULTRAFAST_BOLTS.front} fill={color} />
        </Svg>
      ) : (
        <SymbolView name="bolt.fill" size={8} tintColorClassName="accent-icon" type="monochrome" />
      )}
    </View>
  );
}

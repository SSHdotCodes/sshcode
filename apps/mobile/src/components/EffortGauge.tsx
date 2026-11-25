import { type EffortDisplay, effortGauge } from "@t3tools/client-runtime/composer-model-display";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

// Drawn a touch larger than its shared geometry so it sits level with the phone's bigger label.
const SCALE = 1.15;

/**
 * The composer's effort dial, in the slider's colours: the theme colour sweeping a half ring,
 * glowing from Max up and burning coral at Ultracode.
 */
export function EffortGauge(props: { readonly effort: EffortDisplay }) {
  const { effort } = props;
  const gauge = effortGauge(effort);
  // The text-weight accent: a thin line in the solid action colour reads too red in warm looks.
  const primary = StyleSheet.flatten(useResolveClassNames("text-primary-text"))?.color;
  const muted = StyleSheet.flatten(useResolveClassNames("bg-foreground-muted"))?.backgroundColor;
  const tone = effort.accent ?? (typeof primary === "string" ? primary : "#346BF1");
  const glow = effort.fx >= 3;
  return (
    <View
      accessible={false}
      className="shrink-0"
      style={
        glow
          ? {
              shadowColor: tone,
              shadowOpacity: effort.fx >= 4 ? 0.9 : 0.6,
              shadowRadius: effort.fx >= 4 ? 4 : 3,
              shadowOffset: { width: 0, height: 0 },
            }
          : undefined
      }
    >
      <Svg
        width={gauge.width * SCALE}
        height={gauge.height * SCALE}
        viewBox={`0 0 ${gauge.width} ${gauge.height}`}
      >
        <Path
          d={gauge.track}
          stroke={typeof muted === "string" ? muted : "#8E8E93"}
          strokeOpacity={0.35}
          strokeWidth={gauge.stroke}
          strokeLinecap="round"
          fill="none"
        />
        {gauge.fill ? (
          <Path
            d={gauge.fill}
            stroke={tone}
            strokeWidth={gauge.stroke}
            strokeLinecap="round"
            fill="none"
          />
        ) : null}
      </Svg>
    </View>
  );
}

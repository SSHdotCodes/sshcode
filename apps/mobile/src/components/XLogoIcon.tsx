import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

/** The X (Twitter) mark for X tool rows. Inset so it sits at the weight of the line icons. */
export function XLogoIcon(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox="-3 -3 30 30"
      fill="currentColor"
      color={props.color}
      colorClassName={props.colorClassName}
      accessible={false}
    >
      <Path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </ThemedSvg>
  );
}

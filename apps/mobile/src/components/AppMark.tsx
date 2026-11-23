import type { ColorValue } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const ThemedRect = withUniwind(Rect);

/**
 * SSHCode's mark, matching the desktop's AppMark (apps/web/src/components/AppMark.tsx).
 * Width derives from the viewBox aspect ratio.
 */
export function AppMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 80.5 / 74.5;
  return (
    <Svg
      accessibilityLabel="SSHCode"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="22.75 26.75 80.5 74.5"
    >
      <ThemedPath
        d="M62.34 41.05A17.5 15 0 1 0 47.50 64.00A17.5 15 0 1 1 32.66 86.95"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={14.5}
        strokeLinecap="round"
      />
      <ThemedRect
        x={79.25}
        y={91.75}
        width={24}
        height={9.5}
        rx={2.5}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}

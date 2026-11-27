import type { IconProps } from "@tabler/icons-react-native/types";
import { BOT_AVATAR_GEOMETRY as G } from "@t3tools/client-runtime/state/bots";
import { forwardRef } from "react";
import Svg, { Circle, Rect } from "react-native-svg";

// The face fills the glyph's 18-unit circle inside Tabler's 24-unit grid.
const R = 9;
const X0 = 12 - R;
const D = R * 2;

/** The Bots face as an outline glyph (circle stroke, two filled eyes), drawn like Tabler icons. */
export const BotGlyph = forwardRef<Svg, IconProps>(function BotGlyph(
  { size = 24, color = "currentColor", strokeWidth = 2, ...rest },
  ref,
) {
  const eyeWidth = G.eyeWidth * D + 0.6;
  const eyeHeight = G.eyeHeight * D + 0.6;
  return (
    <Svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <Circle cx={12} cy={12} r={R} stroke={color} strokeWidth={strokeWidth} />
      {G.eyeCentersX.map((centerX) => (
        <Rect
          key={centerX}
          x={X0 + centerX * D - eyeWidth / 2}
          y={X0 + G.eyeCenterY * D - eyeHeight / 2}
          width={eyeWidth}
          height={eyeHeight}
          rx={eyeWidth / 2}
          fill={color}
        />
      ))}
    </Svg>
  );
});

import type { WorkflowMark } from "@t3tools/contracts";
import {
  MARK_HEX,
  MARK_TEXT_SIZES,
  MARK_WEIGHTS,
  markStrokePath,
} from "@t3tools/shared/workflowSketch";
import { useFonts } from "expo-font";
import { Path, Text as SvgText } from "react-native-svg";

import { useUniwindTheme } from "../../lib/useUniwindTheme";

// Same family name and file as WorkflowSketch's font, so it loads once.
const HAND = "Excalifont";

/**
 * The Mac editor's marker strokes and canvas text, read-only, drawn inside the
 * phone canvas's SVG in canvas units.
 */
export function WorkflowMarks({ marks }: { readonly marks: ReadonlyArray<WorkflowMark> }) {
  const theme = useUniwindTheme();
  const [loaded] = useFonts({ [HAND]: require("../../../assets/fonts/Excalifont-Latin.ttf") });
  const ink = theme["--color-foreground"];
  return marks.map((mark) => {
    const color = mark.color === "ink" ? ink : MARK_HEX[mark.color];
    if (mark.kind === "stroke") {
      return (
        <Path
          key={mark.id}
          d={markStrokePath(mark.points)}
          transform={`translate(${mark.x} ${mark.y})`}
          fill="none"
          stroke={color}
          strokeWidth={MARK_WEIGHTS[mark.weight]}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    const size = MARK_TEXT_SIZES[mark.size];
    return mark.text.split("\n").map((line, index) => (
      <SvgText
        key={`${mark.id}:${index}`}
        x={mark.x + 4}
        y={mark.y + 2 + size * (0.95 + 1.2 * index)}
        fill={color}
        fontSize={size}
        fontFamily={loaded ? HAND : undefined}
      >
        {line}
      </SvgText>
    ));
  });
}

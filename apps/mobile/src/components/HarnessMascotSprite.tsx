import { useIsFocused } from "@react-navigation/native";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, AppState, PixelRatio, useColorScheme, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Path } from "react-native-svg";
import {
  createHarnessMascotPlayer,
  resolveHarnessMascotPosterFrame,
  type HarnessMascotId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";
import { NativeWorkspaceTabActivityContext } from "../native/v5-workspace-context";
import { HarnessMascotTurnDuration } from "./harnessMascotContext";
import type { HarnessMascotAssetData } from "./harnessMascotAssets";

export function MascotSprite({
  id,
  state,
  size,
  still,
  visible,
  assets,
}: {
  readonly id: HarnessMascotId;
  readonly state: HarnessMascotState;
  readonly size: number;
  readonly still: boolean;
  readonly visible: boolean;
  readonly assets: HarnessMascotAssetData;
}) {
  const completedTurnMs = use(HarnessMascotTurnDuration);
  // A flat pet has a second sheet in light ink for dark themes. The appearance setting
  // drives the system scheme (a forced theme sets it), so this needs nothing from features.
  const dark = useColorScheme() === "dark";
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  // Start still until the accessibility preference has resolved.
  const [reduced, setReduced] = useState(true);
  const elapsed = useRef(0);
  const [player] = useState(() => createHarnessMascotPlayer(id));
  const [frame, setFrame] = useState(() => player.frame(state, 0, completedTurnMs));
  useEffect(() => {
    if (still) return;
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    const app = AppState.addEventListener("change", (value) => setForeground(value === "active"));
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
    };
  }, [still]);
  useEffect(() => {
    if (still || reduced || !visible || !focused || !tabActive || !foreground) return;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const next = player.frame(
        state,
        elapsed.current + performance.now() - started,
        completedTurnMs,
      );
      setFrame(next);
      timer = setTimeout(tick, next.nextMs);
    };
    tick();
    return () => {
      clearTimeout(timer);
      elapsed.current += performance.now() - started;
    };
  }, [state, still, reduced, visible, focused, tabActive, foreground, player, completedTurnMs]);
  const displayed = still || reduced ? resolveHarnessMascotPosterFrame(id, state) : frame;
  const pixelPaths = useMemo(
    () =>
      assets.pixels?.[displayed.file]?.[displayed.index]?.map(([fill = "", runs = ""]) => {
        // Three printable characters encode each horizontal source-pixel run: x, y, width.
        let d = "";
        for (let i = 0; i < runs.length; i += 3) {
          const x = runs.charCodeAt(i) - 33;
          const y = runs.charCodeAt(i + 1) - 33;
          const width = runs.charCodeAt(i + 2) - 33;
          d += `M${x} ${y}h${width}v1h${-width}Z`;
        }
        return { fill, d };
      }),
    [assets.pixels, displayed.file, displayed.index],
  );
  const spriteSize = displayed.pixelSize
    ? (Math.max(1, Math.floor((size * PixelRatio.get()) / displayed.pixelSize)) *
        displayed.pixelSize) /
      PixelRatio.get()
    : size;
  const inset = Math.round(((size - spriteSize) / 2) * PixelRatio.get()) / PixelRatio.get();
  const file = (dark && displayed.darkFile) || displayed.file;
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size, overflow: "hidden", flexShrink: 0 }}
    >
      {id === "claude" ? (
        <Svg
          width={spriteSize}
          height={spriteSize}
          viewBox={`0 0 ${displayed.pixelSize} ${displayed.pixelSize}`}
          style={{ position: "absolute", left: inset, top: inset }}
        >
          {pixelPaths?.map(({ fill, d }) => (
            <Path key={fill} fill={fill} d={d} />
          ))}
        </Svg>
      ) : (
        <Image
          key={file}
          source={assets.sprites[file]}
          contentFit="fill"
          allowDownscaling={false}
          transition={0}
          style={{
            position: "absolute",
            width: displayed.columns * spriteSize,
            height: displayed.rows * spriteSize,
            left: inset - displayed.column * spriteSize,
            top: inset - displayed.row * spriteSize,
          }}
        />
      )}
    </View>
  );
}

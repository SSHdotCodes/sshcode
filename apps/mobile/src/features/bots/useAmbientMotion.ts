import { useIsFocused } from "@react-navigation/native";
import { use, useEffect, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";

/**
 * Whether a looping decoration may move: its screen is in front, the app is in the
 * foreground and Reduce Motion is off. Looping work stops the moment any of these changes.
 */
export function useAmbientMotion(): boolean {
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => {
      motion.remove();
      app.remove();
    };
  }, []);
  return focused && tabActive && foreground && !reducedMotion;
}

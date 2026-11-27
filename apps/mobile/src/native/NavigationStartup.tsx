import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState, type ReactNode } from "react";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

export function NavigationStartup(props: {
  readonly appearanceReady: boolean;
  readonly children: ReactNode;
}) {
  const [started, setStarted] = useState(!NATIVE_LIQUID_GLASS_SUPPORTED);

  useEffect(() => {
    if (!props.appearanceReady) return;
    if (!started) {
      // The appearance provider applies the saved window style in a layout effect.
      // Mount UIKit's bars after that commit so they start with the settled traits.
      setStarted(true);
      return;
    }
    void SplashScreen.hide();
  }, [props.appearanceReady, started]);

  return started ? props.children : null;
}

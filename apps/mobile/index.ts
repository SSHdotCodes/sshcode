import "./src/lib/startup-clock";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";
import { installLoadMarks } from "./src/lib/loadMarks";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

// Timing marks for loading, readable off the phone (see src/lib/loadMarks.ts).
installLoadMarks();

registerRootComponent(App);

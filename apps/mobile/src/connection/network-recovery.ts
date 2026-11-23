import * as Network from "expo-network";
import { AppState } from "react-native";

/** Retry queued writes immediately when iOS wakes or reports a usable path. */
export function subscribeNetworkRecovery(retry: () => void): () => void {
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected === true) retry();
  });
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") retry();
  });
  return () => {
    network.remove();
    app.remove();
  };
}

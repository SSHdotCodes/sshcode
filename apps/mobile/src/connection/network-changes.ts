import type { NetworkState } from "expo-network";

/** A restored Wi-Fi path needs the same probe as moving from Wi-Fi to cellular. */
export function mobileNetworkChanged(
  previous: NetworkState | undefined,
  next: NetworkState,
): boolean {
  return (
    previous !== undefined &&
    next.isConnected === true &&
    (previous.isConnected === false || previous.type !== next.type)
  );
}

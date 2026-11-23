import { expect, it } from "vite-plus/test";
import type { NetworkState } from "expo-network";
import { mobileNetworkChanged } from "./network-changes";

const wifi = { type: "WIFI", isConnected: true } as NetworkState;
it("wakes when the same Wi-Fi returns and when Wi-Fi changes to cellular", () => {
  expect(mobileNetworkChanged({ ...wifi, isConnected: false }, wifi)).toBe(true);
  expect(mobileNetworkChanged(wifi, { ...wifi, type: "CELLULAR" } as NetworkState)).toBe(true);
});
it("does not wake for initial state, repeated reports, or going offline", () => {
  expect(mobileNetworkChanged(undefined, wifi)).toBe(false);
  expect(mobileNetworkChanged(wifi, wifi)).toBe(false);
  expect(mobileNetworkChanged(wifi, { ...wifi, isConnected: false })).toBe(false);
});

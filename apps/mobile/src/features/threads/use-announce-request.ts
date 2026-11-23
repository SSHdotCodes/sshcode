import { useEffect, useRef } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/** Announce the arrival of a request, without moving focus or repeating live updates. */
export function useAnnounceRequest(requestId: string, message: string) {
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (Platform.OS !== "ios" || announced.current.has(requestId)) return;
    announced.current.add(requestId);
    AccessibilityInfo.announceForAccessibility(message);
  }, [requestId, message]);
}

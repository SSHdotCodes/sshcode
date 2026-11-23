import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { requireOptionalNativeModule } from "expo";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Keyboard } from "react-native";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  BEDSIDE_IDLE_MS,
  BEDSIDE_UNPLUG_GRACE_MS,
  bedsideCanIdle,
  bedsideLeaveReason,
  localeUses24Hour,
} from "./bedsideModel";

interface BedsideNative {
  // Async on iOS, synchronous on Android.
  readonly isCharging?: () => boolean | Promise<boolean>;
  readonly is24HourFormat?: () => boolean;
}

const native = () => requireOptionalNativeModule<BedsideNative>("T3NativeControls");

async function readCharging(): Promise<boolean> {
  try {
    return (await native()?.isCharging?.()) === true;
  } catch {
    return false;
  }
}

/** The phone's 12/24-hour switch, falling back to the locale's hour cycle. */
export function deviceUses24Hour(): boolean {
  try {
    const value = native()?.is24HourFormat?.();
    if (typeof value === "boolean") return value;
  } catch {}
  return localeUses24Hour();
}

/** On unless this device switched it off. */
export function useBedsideScreenEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.bedsideScreenEnabled !== false;
  const setEnabled = useCallback((value: boolean) => save({ bedsideScreenEnabled: value }), [save]);
  return [enabled, setEnabled];
}

const CHARGING_POLL_MS = 20_000;
// While shown, ask often enough to leave about three seconds after unplugging.
const SHOWN_CHARGING_POLL_MS = 1_000;

/**
 * Owns Home's idle timer. Pass whether Home's chat list is the visible screen,
 * and put `onTouchStart` on a view around the list: every touch restarts the
 * minute. Polls charging only while the app is active and the setting is on.
 */
export function useBedsideIdle(homeVisible: boolean) {
  const [enabled] = useBedsideScreenEnabled();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  const [charging, setCharging] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!enabled || !appActive) {
      setCharging(false);
      return;
    }
    let cancelled = false;
    const check = () =>
      void readCharging().then((value) => {
        if (!cancelled) setCharging(value);
      });
    check();
    const interval = setInterval(check, shown ? SHOWN_CHARGING_POLL_MS : CHARGING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, appActive, shown]);

  const conditions = { enabled, charging, appActive, homeVisible };
  const canIdle = bedsideCanIdle({ ...conditions, keyboardVisible: false });
  const canIdleRef = useRef(canIdle);
  canIdleRef.current = canIdle;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Restart the minute; a keyboard on screen (search) counts as activity.
  const arm = useMemo(() => {
    const restart = (): void => {
      clearTimeout(timer.current);
      if (!canIdleRef.current) return;
      timer.current = setTimeout(() => {
        if (Keyboard.isVisible()) restart();
        else if (canIdleRef.current) setShown(true);
      }, BEDSIDE_IDLE_MS);
    };
    return restart;
  }, []);

  useEffect(() => {
    if (canIdle && !shown) arm();
    else clearTimeout(timer.current);
  }, [arm, canIdle, shown]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const leaveReason = shown ? bedsideLeaveReason("idle", conditions) : null;
  useEffect(() => {
    if (leaveReason === null) return;
    if (leaveReason !== "unplugged") {
      setShown(false);
      return;
    }
    const grace = setTimeout(() => setShown(false), BEDSIDE_UNPLUG_GRACE_MS);
    return () => clearTimeout(grace);
  }, [leaveReason]);

  const exit = useCallback(() => setShown(false), []);
  return { shown, exit, onTouchStart: arm };
}

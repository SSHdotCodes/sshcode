import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { Pressable, StyleSheet } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** On unless this device switched it off. */
export function useAutoModelEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.autoModelEnabled !== false;
  const setEnabled = useCallback((value: boolean) => save({ autoModelEnabled: value }), [save]);
  return [enabled, setEnabled];
}

/** The model picker's compact switch for first-prompt suggestions. */
export function AutoModelToggle() {
  const [enabled, setEnabled] = useAutoModelEnabled();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Auto: suggest a model for a new chat's first message"
      accessibilityState={{ checked: enabled }}
      hitSlop={8}
      className={cn(
        "h-7 shrink-0 flex-row items-center gap-1 rounded-full px-2.5",
        enabled ? "border-primary/40 bg-primary/12" : "border-border bg-transparent",
      )}
      style={{ borderWidth: StyleSheet.hairlineWidth }}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        setEnabled(!enabled);
      }}
    >
      <SymbolView
        name="sparkles"
        size={12}
        tintColorClassName={enabled ? "accent-primary" : "accent-icon-muted"}
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className={cn(
          "text-[13px] font-t3-medium",
          enabled ? "text-primary" : "text-foreground-muted",
        )}
      >
        Auto
      </Text>
    </Pressable>
  );
}

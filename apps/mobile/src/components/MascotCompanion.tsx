import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import {
  createMascotPetting,
  MASCOT_PET_MS,
  pettedMascotState,
  type MascotPetReaction,
} from "@t3tools/client-runtime/mascot-moments";
import type { HarnessMascotState } from "@t3tools/shared/harnessMascots";
import { AppText } from "./AppText";

const ENTER = FadeIn.duration(120).reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

export function MascotCompanion({
  children,
  state = "idle",
  size,
  visible = true,
}: {
  readonly children: (state: HarnessMascotState) => ReactNode;
  readonly state?: HarnessMascotState;
  readonly size: number;
  readonly visible?: boolean;
}) {
  const [petting] = useState(createMascotPetting);
  const [reaction, setReaction] = useState<MascotPetReaction | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const reset = () => {
      clearTimeout(timer.current);
      setReaction(null);
    };
    if (!visible) reset();
    const subscription = AppState.addEventListener("change", (value) => {
      if (value !== "active") reset();
    });
    return () => {
      clearTimeout(timer.current);
      subscription.remove();
    };
  }, [visible]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Pet your companion"
      disabled={!visible}
      style={{ width: size, height: size }}
      className="items-center justify-center rounded-2xl"
      onPress={() => {
        const next = petting.pet(Date.now());
        if (!next) return;
        clearTimeout(timer.current);
        setReaction(next);
        timer.current = setTimeout(() => setReaction(null), MASCOT_PET_MS);
      }}
    >
      {children(pettedMascotState(state, reaction))}
      {reaction ? (
        <Animated.View
          key={reaction.hearts}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="absolute inset-x-0 top-0 items-center"
          entering={ENTER}
          exiting={EXIT}
        >
          <View className="flex-row gap-1">
            {Array.from({ length: reaction.hearts }, (_, index) => (
              <AppText key={index} className="text-sm text-primary">
                ♥
              </AppText>
            ))}
          </View>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

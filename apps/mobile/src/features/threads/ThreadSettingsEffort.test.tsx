// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ThreadSettingsEffort } from "./ThreadSettingsEffort";

const haptic = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("expo-haptics", () => ({
  selectionAsync: haptic,
  impactAsync: haptic,
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: { children: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "#4b7cf3" }) }));
vi.mock("react-native", () => ({
  StyleSheet: { flatten: (style: unknown) => style },
  View: (props: {
    children: ReactNode;
    accessibilityRole?: string;
    accessibilityValue?: { text?: string };
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) =>
    props.accessibilityRole === "adjustable" ? (
      <div role="slider" aria-valuetext={props.accessibilityValue?.text}>
        {props.children}
        <button
          onClick={() =>
            props.onAccessibilityAction?.({ nativeEvent: { actionName: "increment" } })
          }
        >
          Increase
        </button>
      </div>
    ) : (
      <div>{props.children}</div>
    ),
}));
vi.mock("./ThreadSettingsRows", () => ({
  ChoiceRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const value = (initial: number) => {
    let current = initial;
    return { get: () => current, set: (next: number) => (current = next), value: initial };
  };
  return {
    default: { View: (props: { children?: ReactNode }) => <div>{props.children}</div> },
    Easing: { inOut: () => () => 0, out: () => () => 0, quad: () => 0, sin: () => 0 },
    ReduceMotion: { System: "system" },
    cancelAnimation: () => {},
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: value,
    withRepeat: (next: number) => next,
    withSequence: (next: number) => next,
    withDelay: (_delay: number, next: number) => next,
    withSpring: (next: number) => next,
    withTiming: (next: number) => next,
  };
});
vi.mock("react-native-svg", () => {
  const Empty = () => null;
  return { default: Empty, Defs: Empty, LinearGradient: Empty, Rect: Empty, Stop: Empty };
});
vi.mock("react-native-gesture-handler", () => {
  const gesture = {
    enabled: () => gesture,
    runOnJS: () => gesture,
    activeOffsetX: () => gesture,
    failOffsetY: () => gesture,
    onBegin: () => gesture,
    onUpdate: () => gesture,
    onEnd: () => gesture,
    onFinalize: () => gesture,
  };
  return {
    Gesture: { Pan: () => gesture, Tap: () => gesture, Race: () => gesture },
    GestureDetector: (props: { children: ReactNode }) => props.children,
  };
});

it("puts Ultracode at the top of the slider, leaves Ultrathink out, and steps between stops", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  haptic.mockClear();
  const onPick = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  const options = [
    { id: "high", label: "High" },
    { id: "ultracode", label: "Ultracode" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "extra_high", label: "Extra High" },
    { id: "low", label: "Low" },
  ];
  try {
    act(() =>
      root.render(
        <ThreadSettingsEffort
          label="Reasoning"
          options={options}
          value="high"
          onPick={onPick}
          isLast
        />,
      ),
    );
    const slider = host.querySelector("[role=slider]")!;
    expect(slider.textContent).toBe("LowHighXHighUltraIncrease");
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    expect(host.textContent).not.toContain("Ultrathink");
    act(() => slider.querySelector("button")!.click());
    expect(onPick).toHaveBeenLastCalledWith("extra_high");

    act(() =>
      root.render(
        <ThreadSettingsEffort
          label="Reasoning"
          options={options}
          value="ultracode"
          onPick={onPick}
          isLast
        />,
      ),
    );
    expect(host.querySelector("[role=slider]")!.getAttribute("aria-valuetext")).toBe("Ultracode");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

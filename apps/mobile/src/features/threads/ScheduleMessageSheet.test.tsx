// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "schedule-message" }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div data-scroll>{children}</div>,
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children, numberOfLines }: { children: ReactNode; numberOfLines?: number }) => (
    <span>
      {typeof children === "string" && numberOfLines
        ? children.split("\n").slice(0, numberOfLines).join("\n")
        : children}
    </span>
  ),
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
import { ScheduleMessageSheet } from "./ScheduleMessageSheet";

it("keeps Cancel in the header and lets the user expand and collapse a long prompt", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const close = vi.fn();
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
  try {
    act(() =>
      root.render(
        <ScheduleMessageSheet
          prompt={"one\ntwo\nthree\nfour\nfive"}
          disabledReason={null}
          onClose={close}
          onSchedule={async () => {}}
        />,
      ),
    );
    expect(host.textContent).toContain("three");
    expect(host.textContent).not.toContain("five");
    act(() => button("Show full message").click());
    expect(host.textContent).toContain("five");
    act(() => button("Show less").click());
    expect(host.textContent).not.toContain("five");
    expect(button("Cancel").closest("[data-scroll]")).toBeNull();
    act(() => button("Cancel").click());
    expect(close).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

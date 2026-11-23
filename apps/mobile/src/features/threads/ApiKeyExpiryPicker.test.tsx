// @vitest-environment jsdom
import type { DateTimePickerProps } from "@expo/ui/community/datetime-picker";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ picker: null as DateTimePickerProps | null }));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: (props: DateTimePickerProps) => {
    native.picker = props;
    return <input aria-label="Custom expiry" disabled={props.disabled} />;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: (props: { children: ReactNode; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ApiKeyExpiryPicker } from "./ApiKeyExpiryPicker";

let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn();

function render(disabled = false) {
  act(() =>
    root.render(<ApiKeyExpiryPicker value={null} onChange={onChange} disabled={disabled} />),
  );
}

function selectDate(date: Date) {
  act(() =>
    native.picker?.onValueChange?.(
      { nativeEvent: { timestamp: date.getTime(), utcOffset: 0 } },
      date,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
  native.picker = null;
  onChange.mockClear();
  render();
  const custom = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Custom date",
  );
  act(() => custom!.click());
});

afterEach(() => act(() => root.unmount()));

describe("custom API key expiry", () => {
  it("uses the end of the selected local calendar day", () => {
    const selected = new Date(2026, 10, 15, 12, 30);
    selectDate(selected);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(new Date(2026, 10, 15, 23, 59, 59).getTime());
    expect(selected.getHours()).toBe(12);
  });

  it("locks the open wheel and ignores late native changes while saving", () => {
    render(true);
    selectDate(new Date(2026, 10, 15));
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector("input")?.disabled).toBe(true);
  });

  it("allows another date after saving finishes", () => {
    render(true);
    render(false);
    selectDate(new Date(2026, 10, 16));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(new Date(2026, 10, 16, 23, 59, 59).getTime());
    expect(host.querySelector("input")?.disabled).toBe(false);
  });
});

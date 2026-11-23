// @vitest-environment jsdom
import { act, startTransition, Suspense, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { FontFamilySettingsRow } from "./SettingsPanels";

vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));

it("commits the pending font edit if an external replacement never commits", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const save = vi.fn();
  const pending = new Promise<never>(() => {});
  let suspended = false;
  function Pending(): never {
    suspended = true;
    throw pending;
  }
  const view = (value: string, loading: boolean) => (
    <Suspense fallback={null}>
      <FontFamilySettingsRow
        title="Interface"
        description=""
        defaultFamily="sans-serif"
        defaultValue=""
        value={value}
        onValueChange={save}
        onReset={() => {}}
        size={{ label: "Size", min: 12, max: 14, value: 12, defaultValue: 12, onChange: () => {} }}
      />
      {loading && <Pending />}
    </Suspense>
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = create(view("Serif", false));
    });
    const input = renderer!.root.findByProps({ "aria-label": "Interface family" });
    await act(() => input.props.onChange({ currentTarget: { value: "" } }));
    await act(() => startTransition(() => renderer!.update(view("Mono", true))));
    expect(suspended).toBe(true);
    await act(() => vi.advanceTimersByTime(400));
    expect(save).toHaveBeenCalledExactlyOnceWith("");
  } finally {
    await act(() => renderer?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

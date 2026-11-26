// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ChatTabSelectionSync } from "./ChatTabSelectionSync";

const visibility = Atom.make<boolean | null>(null);
const preferences = Atom.make(AsyncResult.success({ threadListChatTab: "work" }));

vi.mock("../../state/server", () => ({
  get chatListTabsEnabledAtom() {
    return visibility;
  },
}));
vi.mock("../../state/preferences", () => ({
  get mobilePreferencesAtom() {
    return preferences;
  },
  updateMobilePreferencesAtom: Atom.writable(
    () => undefined,
    (ctx, patch: { threadListChatTab: string }) => ctx.set(preferences, AsyncResult.success(patch)),
  ),
}));
vi.mock("react-native", () => ({
  LayoutAnimation: { configureNext: vi.fn(), Presets: { easeInEaseOut: {} } },
}));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => false }));

it("clears the saved folder when a remote change hides tabs while Home is unmounted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ChatTabSelectionSync />
        </RegistryContext.Provider>,
      ),
    );
    const selected = () => registry.get(preferences).value.threadListChatTab;
    expect(selected()).toBe("work");
    await act(() => registry.set(visibility, true));
    expect(selected()).toBe("work");
    await act(() => registry.set(visibility, false));
    expect(selected()).toBe("");
    await act(() => registry.set(visibility, true));
    expect(selected()).toBe("");
  } finally {
    await act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});

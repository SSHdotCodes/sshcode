// @vitest-environment jsdom
import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { setOptions } = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ setOptions }) }));
vi.mock("./NativeHeaderToolbar", () => ({ NativeHeaderToolbar: () => null }));
vi.mock("./v5-workspace-context", async () => {
  const { createContext } = await import("react");
  return { NativeWorkspaceTabActivityContext: createContext(null) };
});
import { NativeStackScreenOptions } from "./StackHeader";

const Context = createContext({
  get navigationState(): never {
    throw new Error("No navigation context outside render");
  },
});
const containerState = { navigationState: undefined as never };
const root = createRoot(document.createElement("div"));
afterEach(() => {
  act(() => root.render(null));
  setOptions.mockClear();
});
function Header({ label }: { label: string }) {
  return (
    <NativeStackScreenOptions
      options={{
        headerTitle: label,
        unstable_headerCenterItems: [{ element: <span>{label}</span>, context: Context }],
      }}
    />
  );
}
it("keeps React internals opaque and updates changed header content", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = (label: string) =>
    act(() =>
      root.render(
        <Context value={containerState}>
          <Header label={label} />
        </Context>,
      ),
    );
  render("Connecting");
  expect(setOptions).toHaveBeenCalledTimes(1);
  render("Connecting");
  expect(setOptions).toHaveBeenCalledTimes(1);
  render("Connected");
  expect(setOptions).toHaveBeenCalledTimes(2);
});

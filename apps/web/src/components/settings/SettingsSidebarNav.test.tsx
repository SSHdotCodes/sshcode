// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: ({ select }: { select: (location: { hash: string; search: object }) => unknown }) =>
    select({ hash: "", search: {} }),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("./useAvailableSettingsSearchItems", async () => ({
  useAvailableSettingsSearchItems: () => [
    {
      id: "first",
      title: "Theme first",
      description: "Theme",
      keywords: [],
      to: "/settings/appearance",
    },
    {
      id: "second",
      title: "Theme second",
      description: "Theme",
      keywords: [],
      to: "/settings/general",
    },
  ],
}));
vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectSidebarSignIn: () => null,
  T3ConnectSidebarAvatar: () => null,
}));
vi.mock("./settingsLayout", () => ({ scrollToSettingsTarget: vi.fn() }));
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarUtilityMenu: () => null }));
vi.mock("../ui/sidebar", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    SidebarContent: Container,
    SidebarFooter: Container,
    SidebarGroup: Container,
    SidebarGroupLabel: Container,
    SidebarMenu: Container,
    SidebarMenuItem: Container,
    SidebarMenuButton: ({
      isActive: _isActive,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { isActive?: boolean; size?: string }) => <button {...props} />,
    SidebarInput: ({
      nativeInput: _nativeInput,
      ...props
    }: ComponentProps<"input"> & { nativeInput?: boolean }) => <input {...props} />,
    useSidebar: () => ({ isMobile: false, open: true, setOpen: () => {}, setOpenMobile: () => {} }),
  };
});
import { SettingsSidebarNav } from "./SettingsSidebarNav";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  navigate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SettingsSidebarNav pathname="/settings/general" />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["Enter", "ArrowDown", "ArrowUp", "Escape"])(
  "ignores %s during IME composition and keyCode 229",
  (key) => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "theme",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const active = input.getAttribute("aria-activedescendant");
      const event = new KeyboardEvent("keydown", { key, ...init, bubbles: true, cancelable: true });
      act(() => input.dispatchEvent(event));
      expect(navigate).not.toHaveBeenCalled();
      expect(input.value).toBe("theme");
      expect(input.getAttribute("aria-activedescendant")).toBe(active);
      expect(event.defaultPrevented).toBe(false);
    }
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(navigate).toHaveBeenCalledOnce();
  },
);

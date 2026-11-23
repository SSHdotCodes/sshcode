// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));
vi.mock("~/lib/observeResize", () => ({ observeResize: () => () => {} }));

import { SidebarChatTabs } from "./SidebarChatTabs";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";

afterEach(() => {
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("masks saved names before hydration, persists the toggle, and keeps navigation identities", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  let finishRead!: (settings: ClientSettings) => void;
  persistence.getClientSettings.mockReturnValue(
    new Promise((resolve) => {
      finishRead = resolve;
    }),
  );
  persistence.setClientSettings.mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const tabs = [
    {
      key: "opaque-tab-id",
      name: "Private customer project",
      threadKeys: new Set<string>(),
      attention: false,
      working: false,
    },
  ];
  await act(() =>
    root.render(
      <SidebarChatTabs
        ref={createRef()}
        tabs={tabs}
        selected=""
        dropTarget={null}
        renaming={null}
        onSelect={onSelect}
        onContextMenu={() => {}}
        onRename={() => {}}
        onRenameEnd={() => {}}
      />,
    ),
  );
  expect(container.textContent).not.toContain(tabs[0]!.name);
  await act(async () => {
    finishRead({ ...DEFAULT_CLIENT_SETTINGS, screenRecordingPrivacy: true });
    await ensureClientSettingsHydrated();
  });
  const alias = container.querySelectorAll('[role="tab"]')[1]!.textContent;
  expect(alias).toMatch(/^Tab [a-z0-9]+$/);
  expect(container.textContent).not.toContain(tabs[0]!.name);
  await act(() => (container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click());
  expect(onSelect).toHaveBeenCalledWith(tabs[0]!.key);
  await act(() => persistClientSettingsPatch({ screenRecordingPrivacy: false }));
  expect(container.textContent).toContain(tabs[0]!.name);
  await act(() => persistClientSettingsPatch({ screenRecordingPrivacy: true }));
  expect(container.querySelectorAll('[role="tab"]')[1]!.textContent).toBe(alias);
  expect(container.textContent).not.toContain(tabs[0]!.name);
  expect(persistence.setClientSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ screenRecordingPrivacy: true }),
  );
  expect(tabs[0]!.name).toBe("Private customer project");
  await act(() => root.unmount());
  container.remove();
});

it("defaults privacy off for existing clients", () => {
  expect(DEFAULT_CLIENT_SETTINGS.screenRecordingPrivacy).toBe(false);
});

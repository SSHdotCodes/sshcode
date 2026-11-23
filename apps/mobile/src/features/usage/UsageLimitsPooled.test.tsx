// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { formatAsOf, type LimitAccount } from "@t3tools/shared/usageLimits";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ accounts: [] as LimitAccount[], navigate: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./UsageLimitsSection", () => ({ ResetCredits: () => null }));
vi.mock("../threads/use-visible-second-clock", () => ({ useVisibleMinuteClock: () => Date.now() }));
vi.mock("../../state/environment-labels", () => ({
  useEnvironmentDisplayLabels: () => new Map(),
  useEnvironmentDisplayLabel: () => null,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("@t3tools/shared/usageLimits", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/usageLimits")>()),
  collectLimitAccounts: () => state.accounts,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  Linking: {},
}));
import { UsageLimitsSection } from "./UsageLimitsPooled";

it("shows the recent run-out sentence in the phone's pooled limits", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = Date.parse("2026-11-10T12:00:00Z");
  state.accounts = [
    {
      key: "personal",
      sourceKeys: [],
      driver: ProviderDriverKind.make("codex"),
      displayName: "Personal",
      primary: true,
      email: undefined,
      plan: undefined,
      accentColor: undefined,
      environments: [],
      sourceLabel: null,
      redeem: null,
      limits: {
        checkedAt: "2026-11-10T12:00:00Z",
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 87,
            resetsAt: "2026-11-10T22:00:00Z",
            recentPercentPerHour: 12,
          },
        ],
      },
    },
  ];
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    act(() =>
      root.render(<UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />),
    );
    expect(host.textContent).toContain("At the last hour's pace you'll run out");
    expect(host.textContent).not.toContain("On pace to make it to");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("opens each pool member's own account instead of always choosing the busiest one", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = Date.now();
  state.accounts = ["Personal", "Work"].map((displayName, index) => ({
    key: displayName,
    sourceKeys: [],
    driver: ProviderDriverKind.make("codex"),
    displayName,
    primary: false,
    email: undefined,
    plan: "Pro",
    accentColor: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    limits: {
      checkedAt: new Date(now).toISOString(),
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: index === 0 ? 95 : 10,
          resetsAt: new Date(now + 60_000).toISOString(),
        },
      ],
    },
  }));
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    act(() =>
      root.render(<UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />),
    );
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    act(() => buttons.find((button) => button.textContent?.includes("Work"))!.click());
    expect(state.navigate).toHaveBeenLastCalledWith(
      "SettingsSheet",
      expect.objectContaining({
        params: expect.objectContaining({
          params: expect.objectContaining({ accountKey: "Work", windowId: "session" }),
        }),
      }),
    );
    act(() => buttons.find((button) => button.textContent?.includes("Personal"))!.click());
    expect(state.navigate).toHaveBeenLastCalledWith(
      "SettingsSheet",
      expect.objectContaining({
        params: expect.objectContaining({
          params: expect.objectContaining({ accountKey: "Personal" }),
        }),
      }),
    );
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps a plan whose probe read nothing as its own row, and dates an older reading", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = Date.parse("2026-11-20T23:40:00Z");
  const mac = [{ environmentId: EnvironmentId.make("mac"), label: "Mac" }];
  const plan = (
    displayName: string,
    primary: boolean,
    extra: Partial<LimitAccount>,
  ): LimitAccount => ({
    key: displayName,
    sourceKeys: [],
    driver: ProviderDriverKind.make("antigravity"),
    displayName,
    primary,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: mac,
    sourceLabel: null,
    redeem: null,
    limits: {
      checkedAt: "2026-11-20T23:36:00Z",
      windows: [
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini · Weekly",
          usedPercent: 79,
          resetsAt: "2026-11-25T23:08:11Z",
        },
      ],
    },
    ...extra,
  });
  const notice = "Antigravity's limits show again the next time it runs.";
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(<UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />),
    );
  try {
    state.accounts = [
      plan("Google Ultra", true, {
        notice,
        limits: {
          checkedAt: "2026-11-21T00:36:26Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: notice },
        },
      }),
      plan("Google Pro", false, {}),
    ];
    render();
    expect(host.textContent).toContain("Google Ultra");
    expect(host.textContent).toContain(notice);
    expect(host.textContent).toContain("Google Pro");
    expect(host.textContent).toContain("79% used");

    const readAt = Date.parse("2026-11-20T22:23:25Z");
    state.accounts = [
      plan("Google Ultra", true, {
        asOf: readAt,
        limits: {
          checkedAt: "2026-11-20T22:23:25Z",
          windows: [
            {
              id: "gemini-weekly",
              kind: "weekly",
              label: "Gemini · Weekly",
              usedPercent: 52,
              resetsAt: "2026-11-26T07:23:00Z",
            },
          ],
          unavailable: { reason: "probeFailed", message: notice },
        },
      }),
      plan("Google Pro", false, {}),
    ];
    render();
    expect(host.textContent).toContain("52% used");
    expect(host.textContent).toContain(formatAsOf(readAt, now));
    expect(host.textContent).not.toContain(notice);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

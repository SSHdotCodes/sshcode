// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
  }) => (
    <button
      onClick={onPress}
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState.expanded}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => false }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
import { UsageRow, ThreadLimitRow } from "./ThreadUsageRows";

it("reveals row details on tap and hides them on another tap", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <UsageRow label="Tokens" value="4.2M" details={["4,200,000 tokens", "Today 1.1M"]} />,
      ),
    );
    const button = host.querySelector("button")!;
    expect(host.textContent).not.toContain("Today");
    await act(async () => button.click());
    expect(host.textContent).toContain("Today 1.1M");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(host.textContent).not.toContain("Today");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it("shows a run-out row only when consumption will exhaust a window early", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const now = Date.parse("2026-11-09T15:00:00Z");
  const window = {
    id: "weekly",
    label: "Weekly",
    kind: "weekly" as const,
    windowDurationMins: 100,
    resetsAt: "2026-11-09T15:50:00Z",
    usedPercent: 75,
  };
  try {
    await act(async () => root.render(<ThreadLimitRow window={window} now={now} />));
    expect(host.textContent).toContain("Runs out");
    await act(async () =>
      root.render(<ThreadLimitRow window={{ ...window, usedPercent: 25 }} now={now} />),
    );
    expect(host.textContent).not.toContain("Runs out");
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("On pace to make it to");
    await act(async () =>
      root.render(
        <ThreadLimitRow
          window={{
            ...window,
            usedPercent: 87,
            windowDurationMins: 10080,
            resetsAt: "2026-11-10T01:00:00Z",
            recentPercentPerHour: 12,
          }}
          now={now}
        />,
      ),
    );
    expect(host.textContent).toContain("Runs out");
    // The forecast is available through the same row details on the phone.
    expect(host.textContent).toContain("At the last hour's pace you'll run out");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

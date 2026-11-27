import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useCanGoBack: () => testState.canGoBack,
}));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", async () => {
  const React = await import("react");
  return {
    ToggleGroup: ({ children, onValueChange, ...props }: any) =>
      React.createElement(
        "div",
        props,
        React.Children.map(children, (child: any) =>
          React.isValidElement(child)
            ? React.cloneElement(child, {
                onClick: () => onValueChange?.([(child.props as any).value]),
              } as any)
            : child,
        ),
      ),
    Toggle: ({ value, ...props }: any) =>
      React.createElement("button", { type: "button", "data-value": value, ...props }),
  };
});
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
  WorkspaceBreadcrumbText: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_ORDER: ["codex", "claude"],
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import { saveUsagePagePreferences } from "./usagePagePreferences";
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh" as const, source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments,
    selectedEnvironments: environments,
    isPending: false,
    shown: null,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage Escape navigation", () => {
  let renderer: Root;
  let container: HTMLDivElement;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    testState.canGoBack = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(<UsagePage />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    back.mockRestore();
    vi.unstubAllGlobals();
  });

  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", () => {
    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    testState.canGoBack = false;
    await act(() => renderer.render(<UsagePage />));

    document.body.dispatchEvent(escape());
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await act(() => trigger.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(() => {
      document.activeElement!.dispatchEvent(escape());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Escape with %j", (properties) => {
    document.body.dispatchEvent(escape(properties));
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });
});

describe("UsagePage named instances", () => {
  let renderer: Root;
  let container: HTMLDivElement;

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    window.localStorage.removeItem("t3code:usage-page-preferences:v1");
    vi.unstubAllGlobals();
  });

  it.each(["cost", "tokens"] as const)(
    "shows separate instance sessions and same-model rows in %s",
    async (metric) => {
      const summary = {
        ...environments[0]!.summary,
        buckets: [
          { path: "/personal", tokens: 100, cost: 5, unpriced: false },
          { path: "/work", tokens: 200, cost: 0, unpriced: true },
        ].map(({ path, tokens, cost, unpriced }) => ({
          provider: "claude" as const,
          model: "shared-model",
          sourcePath: path,
          day: UsageDay.make("2026-08-11"),
          totals: {
            uncachedInputTokens: tokens,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd: cost,
          cacheSavingsUsd: 0,
          costSource: unpriced ? ("unpriced" as const) : ("modelPriced" as const),
          records: 1,
          unpricedRecords: unpriced ? 1 : 0,
          sessions: 1,
        })),
        sources: [
          { id: "personal", name: "Personal", sessions: 2 },
          { id: "work", name: "Work", sessions: 3 },
        ].map(({ id, name, sessions }) => ({
          fingerprint: {
            hostId: "test",
            provider: "claude" as const,
            resolvedHomePath: `/${id}`,
            volumeId: "test",
          },
          instanceId: id,
          displayName: name,
          status: "ok" as const,
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: sessions,
          message: null,
        })),
      };
      const namedEnvironments = [{ ...environments[0]!, summary }];
      const merged = mergeUsage(namedEnvironments, USAGE_CONTRACT_VERSION);
      testState.useUsage.mockImplementation((window: UsageSummaryInput) => ({
        merged,
        environments: namedEnvironments,
        selectedEnvironments: namedEnvironments,
        shown: { merged, window },
        isPartial: false,
        refresh: vi.fn(),
      }));
      saveUsagePagePreferences({ metric, windowDays: 30 });
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      container = document.createElement("div");
      document.body.append(container);
      renderer = createRoot(container);
      await act(() => renderer.render(<UsagePage />));

      const summaryText = container.querySelector("section")!.textContent;
      expect(summaryText).toContain("Personal");
      expect(summaryText).toContain("2 sessions");
      expect(summaryText).toContain("Work");
      expect(summaryText).toContain("3 sessions");
      const modelRows = [...container.querySelectorAll("tbody tr")];
      expect(modelRows).toHaveLength(2);
      expect(modelRows.every((row) => row.textContent?.includes("shared-model"))).toBe(true);
      expect(modelRows.find((row) => row.textContent?.includes("Personal"))?.textContent).toContain(
        "$5.00",
      );
      const workRow = modelRows.find((row) => row.textContent?.includes("Work"))!;
      expect(workRow.textContent).toContain("Unpriced");
      expect(workRow.textContent).toContain("200");
    },
  );

  it("folds instances under one percent behind one line once the list is long", async () => {
    const sizes = [600_000, 380_000, 4_000, 4_000, 4_000, 4_000, 2_000, 2_000];
    const summary = {
      ...environments[0]!.summary,
      buckets: sizes.map((tokens, index) => ({
        provider: "claude" as const,
        model: "shared-model",
        sourcePath: `/home-${index}`,
        day: UsageDay.make("2026-08-11"),
        totals: {
          uncachedInputTokens: tokens,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: tokens / 100_000,
        cacheSavingsUsd: 0,
        costSource: "modelPriced" as const,
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      })),
      sources: sizes.map((_, index) => ({
        fingerprint: {
          hostId: "test",
          provider: "claude" as const,
          resolvedHomePath: `/home-${index}`,
          volumeId: "test",
        },
        instanceId: `home-${index}`,
        displayName: `Account ${index}`,
        status: "ok" as const,
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      })),
    };
    const manyEnvironments = [{ ...environments[0]!, summary }];
    const merged = mergeUsage(manyEnvironments, USAGE_CONTRACT_VERSION);
    testState.useUsage.mockImplementation((window: UsageSummaryInput) => ({
      merged,
      environments: manyEnvironments,
      selectedEnvironments: manyEnvironments,
      shown: { merged, window },
      isPartial: false,
      refresh: vi.fn(),
    }));
    saveUsagePagePreferences({ metric: "tokens", windowDays: 30 });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => renderer.render(<UsagePage />));

    const summary$ = () => container.querySelector("section")!.textContent ?? "";
    const fold = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("smaller providers"),
    )!;
    expect(fold.textContent).toContain("6 smaller providers");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(summary$()).toContain("Account 0");
    expect(summary$()).toContain("Account 1");
    expect(summary$()).not.toContain("Account 2");

    await act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(summary$()).toContain("Account 2");
    expect(summary$()).toContain("Account 7");
    expect(fold.textContent).toContain("Hide smaller providers");
  });
});

describe("UsagePage partial totals", () => {
  let renderer: Root;
  let container: HTMLDivElement;

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    window.localStorage.removeItem("t3code:usage-page-preferences:v1");
    vi.unstubAllGlobals();
  });

  it("says the total is partial until an environment still connecting has answered", async () => {
    const studio = { ...environments[0]!, label: "Studio", isConnected: true };
    // Its server just restarted: reconnecting, with no usage for this view yet.
    const mac = {
      ...environments[0]!,
      environmentId: EnvironmentId.make("mac"),
      label: "Mac",
      isConnected: false,
      isPending: true,
      summary: null,
    };
    let statuses: readonly (typeof studio | typeof mac)[] = [studio, mac];
    testState.useUsage.mockImplementation((window: UsageSummaryInput) => {
      const merged = mergeUsage(
        statuses.flatMap(({ environmentId, label, summary }) =>
          summary === null ? [] : [{ environmentId, label, summary }],
        ),
        USAGE_CONTRACT_VERSION,
      );
      return {
        merged,
        environments: statuses,
        selectedEnvironments: statuses,
        shown: { merged, window },
        isPartial: statuses.some((status) => status.summary === null),
        refresh: vi.fn(),
      };
    });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 90 });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => renderer.render(<UsagePage />));
    const headline = () => container.querySelector("section")!.textContent ?? "";
    expect(headline()).toContain("partial, waiting for Mac");

    statuses = [studio, { ...mac, isConnected: true, isPending: false, summary: studio.summary }];
    await act(() => renderer.render(<UsagePage />));
    expect(headline()).not.toContain("partial");
  });
});

// @vitest-environment jsdom

describe("UsagePage time breakdown costs", () => {
  it("shows a dash for a day whose usage is entirely unpriced", async () => {
    const summary = {
      ...environments[0]!.summary,
      buckets: [
        {
          provider: "claude" as const,
          model: "unpriced-model",
          day: UsageDay.make("2026-11-26"),
          totals: {
            uncachedInputTokens: 200,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd: 0,
          cacheSavingsUsd: 0,
          costSource: "unpriced" as const,
          records: 1,
          unpricedRecords: 1,
          sessions: 1,
        },
      ],
      sources: [
        {
          fingerprint: {
            hostId: "test",
            provider: "claude" as const,
            resolvedHomePath: "/work",
            volumeId: "test",
          },
          status: "ok" as const,
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 1,
          message: null,
        },
      ],
    };
    const usageEnvironments = [{ ...environments[0]!, summary }];
    const merged = mergeUsage(usageEnvironments, USAGE_CONTRACT_VERSION);
    testState.useUsage.mockImplementation((window: UsageSummaryInput) => ({
      merged,
      environments: usageEnvironments,
      selectedEnvironments: usageEnvironments,
      shown: { merged, window },
      isPartial: false,
      refresh: vi.fn(),
    }));
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const renderer = createRoot(container);
    await act(() => renderer.render(<UsagePage />));

    const dayToggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Day",
    )!;
    await act(() => dayToggle.click());

    const dayRow = [...container.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("Nov 26"),
    )!;
    expect(dayRow.textContent).toContain("–");
    expect(dayRow.textContent).not.toContain("$0.00");

    await act(() => renderer.unmount());
    container.remove();
    window.localStorage.removeItem("t3code:usage-page-preferences:v1");
    vi.unstubAllGlobals();
  });
});

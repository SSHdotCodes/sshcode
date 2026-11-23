// @vitest-environment jsdom
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.clear }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: { permissionAtom: () => true } },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "locale" }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-03T20:00" }));

import { ThreadDetailsUsage } from "./ThreadDetailsUsage";
import { EnvironmentId } from "@t3tools/contracts";

it("shows the shared recent forecast in the limit row details", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T20:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-03T20:00:00.000Z",
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 87,
          recentPercentPerHour: 12,
          resetsAt: "2026-11-04T06:00:00.000Z",
        },
      ],
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ThreadDetailsUsage
          environmentId={EnvironmentId.make("qa")}
          providerInstanceId={provider.instanceId}
          providers={[provider]}
          sources={[]}
        />,
      ),
    );
    expect(container.textContent).toContain("Runs out");
    const trigger = container.querySelector<HTMLElement>('[aria-label^="Runs out:"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.focus());
    expect(document.body.textContent).toContain("At the last hour's pace you'll run out");

    for (const usedPercent of [99.6, 100]) {
      await act(async () =>
        root.render(
          <ThreadDetailsUsage
            environmentId={EnvironmentId.make("qa")}
            providerInstanceId={provider.instanceId}
            providers={[
              {
                ...provider,
                usageLimits: {
                  ...provider.usageLimits!,
                  windows: [{ ...provider.usageLimits!.windows[0]!, usedPercent, limited: false }],
                },
              },
            ]}
            sources={[]}
          />,
        ),
      );
      expect(container.textContent).toContain("<1% left");
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows and clears remembered credit exhaustion without quota windows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("muse"),
    driver: ProviderDriverKind.make("muse"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T20:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    recentFailure: {
      kind: "billing_error",
      outOfCredit: true,
      occurredAt: "2026-11-03T19:00:00.000Z",
      message: "Budget exhausted.",
    },
  };
  function Probe() {
    const [current, setCurrent] = useState(provider);
    state.clear.mockImplementation(async () => {
      const { recentFailure: _failure, ...healthy } = provider;
      setCurrent(healthy);
    });
    return (
      <ThreadDetailsUsage
        environmentId={EnvironmentId.make("qa")}
        providerInstanceId={provider.instanceId}
        providers={[current]}
        sources={[]}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<Probe />));
    expect(container.textContent).toContain("Out of credit since");
    expect(container.textContent).toContain(": Budget exhausted.");
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear",
    )!;
    await act(async () => clear.click());
    expect(container.textContent).not.toContain("Out of credit");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({
  connected: true,
  effects: [] as Array<() => void | undefined>,
  hydrated: true,
  report: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    // The reporter's whole behavior lives in its effect; capture it so the
    // test can run it the way React would after mounting.
    useEffect: (effect: () => void | undefined) => {
      state.effects.push(effect);
      return undefined;
    },
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      browserProfiles: [{ id: "profile", name: "Profile" }],
      browserDefaultProfileId: "profile",
    }),
  useClientSettingsHydrated: () => state.hydrated,
}));

vi.mock("../state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      ["environment-studio", { environment: { capabilities: { serverBrowser: true } } }],
      ["environment-no-browser", { environment: { capabilities: { serverBrowser: false } } }],
    ]),
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => {
    const presentation = {
      environmentId: "environment-studio",
      connection: { phase: state.connected ? "connected" : "offline" },
    };
    return {
      environments: [presentation],
      presentationById: new Map([["environment-studio", presentation]]),
    };
  },
}));

vi.mock("../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(["environment-studio", "environment-no-browser"]),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => state.report,
}));

import { BrowserProfileReporter } from "./BrowserProfileReporter";

/** Renders the reporter and runs the effect React would have run. */
function renderReporter() {
  state.effects.length = 0;
  hooks.beginRender();
  BrowserProfileReporter();
  expect(state.effects.length).toBe(1);
  state.effects[0]?.();
}

describe("BrowserProfileReporter", () => {
  beforeEach(() => {
    hooks.reset();
    state.connected = true;
    state.effects.length = 0;
    state.hydrated = true;
    state.report.mockReset();
  });

  it("reports profiles to connected server-browser environments", () => {
    renderReporter();
    expect(state.report).toHaveBeenCalledWith({
      environmentId: "environment-studio",
      input: {
        profiles: [{ id: "profile", name: "Profile" }],
        defaultProfileId: "profile",
      },
    });
    expect(state.report).toHaveBeenCalledTimes(1);
  });

  it("skips environments that are not connected instead of failing every report", () => {
    state.connected = false;
    renderReporter();
    expect(state.report).not.toHaveBeenCalled();
  });

  it("waits for the client settings to hydrate", () => {
    state.hydrated = false;
    renderReporter();
    expect(state.report).not.toHaveBeenCalled();
  });
});

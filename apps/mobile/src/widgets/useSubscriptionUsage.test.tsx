// @vitest-environment jsdom
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    state: "active",
    refreshProviders: vi.fn(async () => ({ _tag: "Success" as const, value: { providers: [] } })),
    registry: null as AtomRegistry.AtomRegistry | null,
    presentationsAtom: null as Atom.Writable<Map<EnvironmentId, any>> | null,
    shellStatusAtoms: new Map<EnvironmentId, Atom.Writable<{ readonly status: string }>>(),
    change(state: string) {
      this.state = state;
      for (const listener of listeners) listener(state);
    },
  };
});

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.listeners.add(listener);
      return { remove: () => harness.listeners.delete(listener) };
    },
  },
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => harness.registry!.get(atom),
  },
}));

vi.mock("../state/presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return harness.presentationsAtom!;
    },
  },
}));

vi.mock("../state/shell", () => ({
  environmentShell: {
    stateValueAtom: (id: EnvironmentId) => {
      let atom = harness.shellStatusAtoms.get(id);
      if (!atom) {
        atom = Atom.make({ status: "synchronizing" });
        harness.shellStatusAtoms.set(id, atom);
      }
      return atom;
    },
  },
}));

vi.mock("../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => harness.refreshProviders,
}));

import {
  USAGE_STALE_AFTER_MS,
  WIDGET_REFRESH_INTERVAL,
  WIDGET_REFRESH_SETTLE_MS,
} from "./subscriptionUsageSnapshot";
import { useSubscriptionUsage } from "./useSubscriptionUsage";

function Harness() {
  useSubscriptionUsage(true);
  return null;
}

const ENV_ID = EnvironmentId.make("mac");
const BASE_TIME = Date.parse("2026-11-20T03:30:00.000Z");

function provider(checkedAtMs: number) {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(checkedAtMs).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(checkedAtMs).toISOString(),
      windows: [],
    },
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  harness.state = "active";
  harness.listeners.clear();
  harness.refreshProviders.mockClear();
  harness.shellStatusAtoms.clear();
  harness.registry = AtomRegistry.make();
  harness.presentationsAtom = Atom.make(new Map<EnvironmentId, any>());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  vi.useRealTimers();
});

function mount() {
  root = createRoot(document.createElement("div"));
  act(() => {
    root!.render(
      <RegistryContext.Provider value={harness.registry!}>
        <Harness />
      </RegistryContext.Provider>,
    );
  });
}

describe("useSubscriptionUsage", () => {
  it("waits for a live shell and settle delay before refreshing stale usage limits, and skips fresh ones", async () => {
    const staleCheckedAt = BASE_TIME - USAGE_STALE_AFTER_MS - 60_000;
    harness.registry!.set(
      harness.presentationsAtom!,
      new Map([
        [
          ENV_ID,
          {
            connection: { phase: "connected" },
            serverConfig: { providers: [provider(staleCheckedAt)] },
          },
        ],
      ]),
    );
    mount();

    // Shell is still synchronizing: never fire refreshProviders during initial connect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_SETTLE_MS * 2);
    });
    expect(harness.refreshProviders).not.toHaveBeenCalled();

    // Shell becomes live, but usage limits are fresh (checked 1 min ago): still skip.
    harness.registry!.set(
      harness.presentationsAtom!,
      new Map([
        [
          ENV_ID,
          {
            connection: { phase: "connected" },
            serverConfig: { providers: [provider(BASE_TIME - 60_000)] },
          },
        ],
      ]),
    );
    act(() => {
      harness.registry!.set(harness.shellStatusAtoms.get(ENV_ID)!, { status: "live" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_SETTLE_MS);
    });
    expect(harness.refreshProviders).not.toHaveBeenCalled();

    // One interval later the limits are 6 minutes old: the server is still keeping up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_INTERVAL);
    });
    expect(harness.refreshProviders).not.toHaveBeenCalled();

    // Another interval and they are past USAGE_STALE_AFTER_MS: refresh runs once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_INTERVAL);
    });
    expect(harness.refreshProviders).toHaveBeenCalledTimes(1);
    expect(harness.refreshProviders).toHaveBeenCalledWith({ environmentId: ENV_ID, input: {} });
  });

  it("defers stale usage refreshes until WIDGET_REFRESH_SETTLE_MS after the shell goes live", async () => {
    const staleCheckedAt = BASE_TIME - USAGE_STALE_AFTER_MS - 60_000;
    harness.registry!.set(
      harness.presentationsAtom!,
      new Map([
        [
          ENV_ID,
          {
            connection: { phase: "connected" },
            serverConfig: { providers: [provider(staleCheckedAt)] },
          },
        ],
      ]),
    );
    const shellAtom = Atom.make({ status: "live" });
    harness.shellStatusAtoms.set(ENV_ID, shellAtom);
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_SETTLE_MS - 1);
    });
    expect(harness.refreshProviders).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(harness.refreshProviders).toHaveBeenCalledTimes(1);
  });
});

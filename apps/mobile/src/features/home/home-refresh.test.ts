import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "@t3tools/client-runtime/state/shell";

const harness = vi.hoisted(() => ({
  states: new Map<string, EnvironmentShellState>(),
  listeners: new Map<string, (state: EnvironmentShellState) => void>(),
  refresh: vi.fn(),
}));
vi.mock("../../state/shell", () => ({
  environmentShell: {
    stateValueAtom: (id: string) => `value:${id}`,
    stateAtom: (id: string) => `stream:${id}`,
  },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (key: string) => harness.states.get(key),
    subscribe(key: string, listener: (state: EnvironmentShellState) => void) {
      harness.listeners.set(key, listener);
      return () => harness.listeners.delete(key);
    },
    refresh: harness.refresh,
  },
}));

import { refreshHomeThreads } from "./home-refresh";

const environmentId = EnvironmentId.make("server");
function shell(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return { ...EMPTY_SHELL_STATE, status, error: Option.none(), snapshot: Option.none() };
}
function emit(state: EnvironmentShellState) {
  harness.states.set("value:server", state);
  harness.listeners.get("value:server")?.(state);
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.states.clear();
  harness.states.set("value:server", shell("live"));
  harness.listeners.clear();
  harness.refresh.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("home pull to refresh", () => {
  it("waits for an authoritative live catalog, then removes the listener", async () => {
    const finished = vi.fn();
    const refresh = refreshHomeThreads([environmentId, environmentId]).then(finished);
    expect(harness.refresh).toHaveBeenCalledExactlyOnceWith("stream:server");
    emit(shell("cached"));
    emit(shell("synchronizing"));
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    emit(shell("live"));
    await refresh;
    expect(finished).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the refresh spinner with the actual catalog error", async () => {
    const refresh = refreshHomeThreads([environmentId]);
    const rejected = expect(refresh).rejects.toThrow("Server unavailable");
    emit({ ...shell("cached"), error: Option.some("Server unavailable") });
    await rejected;
    expect(harness.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out and cleans up when the server never finishes", async () => {
    const rejected = expect(refreshHomeThreads([environmentId])).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(harness.listeners.size).toBe(0);
  });

  it("does not contact a server for an empty connected-environment list", async () => {
    await refreshHomeThreads([]);
    expect(harness.refresh).not.toHaveBeenCalled();
  });
});

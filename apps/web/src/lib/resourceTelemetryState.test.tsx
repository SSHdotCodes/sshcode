import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "test-environment" }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { resourceTelemetry: () => telemetryAtom },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { useResourceTelemetry, type ResourceTelemetryState } from "./resourceTelemetryState";

const telemetryAtom = Atom.make<
  AsyncResult.AsyncResult<{ readonly sampleIntervalMs: number }, Error>
>(AsyncResult.initial(true));
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let latest: ResourceTelemetryState;

function Probe() {
  const telemetry = useResourceTelemetry();
  useLayoutEffect(() => {
    latest = telemetry;
  }, [telemetry]);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("stops loading after the first snapshot even while the subscription keeps waiting", async () => {
  expect(latest.isPending).toBe(true);
  const snapshot = { sampleIntervalMs: 1_000 };
  await act(async () => {
    registry.set(telemetryAtom, AsyncResult.waiting(AsyncResult.success(snapshot)));
  });
  expect(latest.data).toEqual(snapshot);
  expect(latest.isPending).toBe(false);

  await act(async () => {
    registry.set(
      telemetryAtom,
      AsyncResult.waiting(AsyncResult.success({ sampleIntervalMs: 2_000 })),
    );
  });
  expect(latest.data?.sampleIntervalMs).toBe(2_000);
  expect(latest.isPending).toBe(false);
});

it("does not keep spinning after a subscription error", async () => {
  await act(async () => {
    registry.set(
      telemetryAtom,
      AsyncResult.waiting(AsyncResult.fail(new Error("Monitor unavailable"))),
    );
  });
  expect(latest.error).toBe("Monitor unavailable");
  expect(latest.isPending).toBe(false);
});

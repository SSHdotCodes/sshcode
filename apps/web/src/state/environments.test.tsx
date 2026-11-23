// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const discovery = vi.hoisted(() => ({ shouldFail: true }));

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  const Stream = await import("effect/Stream");
  return {
    environmentCatalog: {
      catalogAtom: Atom.make(
        Stream.suspend(() =>
          discovery.shouldFail
            ? Stream.fail(new Error("Registry stream failed."))
            : Stream.succeed({ isReady: true, entries: new Map() }),
        ),
      ),
      networkStatusValueAtom: Atom.make("online"),
    },
  };
});
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: { presentationsAtom: Atom.make(new Map()) },
    environmentSummaries: {},
    useEnvironmentPresentation: vi.fn(),
  };
});
vi.mock("./primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("./relay", () => ({ relayEnvironmentDiscovery: {} }));
vi.mock("./session", () => ({ usePreparedConnection: vi.fn() }));

import { useEnvironments } from "./environments";

function Probe() {
  const { isReady, error, refresh } = useEnvironments();
  return (
    <div>
      {isReady ? "Settled" : "Loading"}
      {error}
      <button onClick={refresh}>Retry</button>
    </div>
  );
}

it("settles a failed registry stream and starts it again on retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  discovery.shouldFail = true;
  const registry = AtomRegistry.make();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    expect(host.textContent).toContain("SettledRegistry stream failed.");
    expect(host.textContent).not.toContain("Loading");
    discovery.shouldFail = false;
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toBe("SettledRetry");
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    host.remove();
    vi.unstubAllGlobals();
  }
});

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadDetailToShell } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../test-fixtures";
import { useThreadBootstrap, useThreadVisibleTurnItems } from "./entities";

const state = vi.hoisted(() => ({
  loads: 0,
  shell: undefined as unknown as Atom.Writable<EnvironmentThreadShell | null>,
  remote: undefined as unknown as Atom.Writable<EnvironmentThread | null>,
}));

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const shell = Atom.make<EnvironmentThreadShell | null>(null);
  const remote = Atom.make<EnvironmentThread | null>(null);
  Object.assign(state, { shell, remote });
  const detail = Atom.make((get) => {
    state.loads += 1;
    // A missing cold snapshot cannot produce a live subscription. It remains
    // missing for this mount, just like a definitive HTTP 404 in the runtime.
    if (get.once(remote) === null) return null;
    return get(remote);
  }).pipe(Atom.keepAlive);
  const visible = Atom.make((get) => get(detail)?.projection.visibleTurnItems ?? []);
  return {
    environmentThreadShells: { threadShellAtom: () => shell },
    environmentThreadDetails: { threadAtom: () => detail, visibleTurnItemsAtom: () => visible },
  };
});

const environmentId = EnvironmentId.make("environment-1");
const fixture = makeStreamingTimelineFixture("Hello from the agent");
const ref = scopeThreadRef(environmentId, fixture.threadId);
const projection = {
  ...makeThreadProjectionFixture(),
  thread: { ...makeThreadProjectionFixture().thread, id: fixture.threadId },
  turnItems: fixture.visibleTurnItems.map((row) => row.item),
  visibleTurnItems: fixture.visibleTurnItems,
};
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

function Probe({ waitForShell }: { waitForShell: boolean }) {
  const { detailRef } = useThreadBootstrap(ref, { waitForShell });
  const items = useThreadVisibleTurnItems(detailRef);
  return (
    <div>
      {items
        .flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : []))
        .join(" ")}
    </div>
  );
}

async function mount(waitForShell: boolean) {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe waitForShell={waitForShell} />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.loads = 0;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("thread bootstrap", () => {
  it("receives first and follow-up replies after a reserved draft is created without reopening", async () => {
    await mount(true);
    expect(state.loads).toBe(0);
    const first = { ...projection, visibleTurnItems: [] };
    await act(async () => {
      registry.set(state.remote, { environmentId, projection: first });
      registry.set(state.shell, threadDetailToShell(environmentId, first));
    });
    expect(state.loads).toBe(1);
    await act(async () => registry.set(state.remote, { environmentId, projection }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("Hello from the agent");
    const next = {
      ...projection,
      visibleTurnItems: projection.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message"
          ? { ...row, item: { ...row.item, text: "A follow-up reply" } }
          : row,
      ),
    };
    await act(async () => registry.set(state.remote, { environmentId, projection: next }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("A follow-up reply");
  });

  it("loads an existing deep-linked thread even before its shell arrives", async () => {
    registry.set(state.remote, { environmentId, projection });
    await mount(false);
    expect(state.loads).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Hello from the agent");
  });

  it("does not repeatedly load a genuinely missing server thread", async () => {
    await mount(false);
    expect(state.loads).toBe(1);
    await act(async () => registry.set(state.remote, { environmentId, projection }));
    expect(state.loads).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Hello from the agent");
  });
});

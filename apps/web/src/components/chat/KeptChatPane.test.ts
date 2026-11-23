import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createPaneRegistry } from "./KeptChatPane";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const registry = AtomRegistry.make();
  const source = Atom.make(1).pipe(Atom.keepAlive);
  const derived = Atom.make((get) => ({ value: get(source) })).pipe(Atom.setIdleTTL(0));
  const pane = createPaneRegistry(registry);
  const seen: number[] = [];
  const subscribe = () => pane.registry.subscribe(derived, (next) => seen.push(next.value));
  const mounted = () => registry.getNodes().has(derived);
  return { registry, source, derived, pane, seen, subscribe, mounted };
}

describe("kept chat pane registry", () => {
  it("holds a hidden view's atoms, by identity and silently, until it is shown again", async () => {
    const { registry, source, derived, pane, seen, subscribe, mounted } = fixture();
    const release = subscribe();
    const shown = registry.get(derived);
    seen.length = 0;

    pane.setHidden(true);
    release();
    await settle();
    expect(mounted()).toBe(true);
    expect(registry.get(derived)).toBe(shown);

    registry.set(source, 2);
    expect(seen).toEqual([]);

    pane.setHidden(false);
    const releaseShown = subscribe();
    pane.releaseHeld();
    await settle();
    expect(registry.get(derived).value).toBe(2);
    registry.set(source, 3);
    expect(seen).toEqual([3]);

    releaseShown();
    await settle();
    expect(mounted()).toBe(false);
  });

  it("releases at once while shown, and everything held once the pane is dropped", async () => {
    const { pane, subscribe, mounted } = fixture();
    subscribe()();
    await settle();
    expect(mounted()).toBe(false);

    const release = subscribe();
    pane.setHidden(true);
    release();
    pane.releaseHeld();
    await settle();
    expect(mounted()).toBe(false);
  });
});

import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import {
  Activity,
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

const KeptChatPaneHiddenContext = createContext(false);

export function useKeptChatPaneHidden() {
  return use(KeptChatPaneHiddenContext);
}

/**
 * A chat view that stays mounted after it leaves the screen. <Activity> hides it:
 * its DOM and state stay and its effects stop. Stopping an effect releases its atom
 * subscriptions, and most thread atoms are disposed as soon as nobody reads them, so
 * a revealed view would read rebuilt values and render again, or fall back to
 * loading. The pane holds those subscriptions while hidden, dropping their
 * notifications, so a revealed view re-renders only for data that really changed.
 */
export function KeptChatPane(props: { hidden: boolean; children: ReactNode }) {
  const appRegistry = use(RegistryContext);
  const [pane] = useState(() => createPaneRegistry(appRegistry));
  // Layout effects run before the passive cleanups that release subscriptions.
  useLayoutEffect(() => pane.setHidden(props.hidden), [pane, props.hidden]);
  // Parent effects run after the children's, so a revealed view has subscribed
  // again before the held subscriptions go.
  useEffect(() => {
    if (!props.hidden) pane.releaseHeld();
  }, [pane, props.hidden]);
  useEffect(() => pane.releaseHeld, [pane]);
  return (
    <RegistryContext value={pane.registry}>
      <KeptChatPaneHiddenContext value={props.hidden}>
        <Activity mode={props.hidden ? "hidden" : "visible"}>{props.children}</Activity>
      </KeptChatPaneHiddenContext>
    </RegistryContext>
  );
}

/** The registry a kept pane gives its view; exported for tests. */
export function createPaneRegistry(base: AtomRegistry.AtomRegistry) {
  let hidden = false;
  const held = new Set<() => void>();
  const hold = (release: () => void) => () => {
    if (hidden) held.add(release);
    else release();
  };
  const subscribe: AtomRegistry.AtomRegistry["subscribe"] = (atom, f, options) =>
    hold(
      base.subscribe(
        atom,
        (value) => {
          if (!hidden) f(value);
        },
        options,
      ),
    );
  const mount: AtomRegistry.AtomRegistry["mount"] = (atom) => hold(base.mount(atom));
  const registry = new Proxy(base, {
    get(target, key) {
      if (key === "subscribe") return subscribe;
      if (key === "mount") return mount;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    registry,
    setHidden(next: boolean) {
      hidden = next;
    },
    releaseHeld() {
      for (const release of held) release();
      held.clear();
    },
  };
}

import { Suspense, use, useEffect, useState, type ComponentProps } from "react";
import { View } from "react-native";
import {
  harnessMascotForDriver,
  loadHarnessMascotAnimations,
  type HarnessMascotId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";
import { loadHarnessMascotAssets } from "./harnessMascotAssets";
import {
  HarnessMascotAgentId,
  HarnessMascotDriver,
  HarnessMascotTurnDuration,
} from "./harnessMascotContext";
import type { MascotSprite } from "./HarnessMascotSprite";

type SpriteProps = Omit<ComponentProps<typeof MascotSprite>, "assets">;
type SpriteModule = { default: (props: SpriteProps) => React.JSX.Element };
const components = new Map<
  HarnessMascotId,
  {
    component: SpriteModule["default"];
    load: () => Promise<SpriteModule>;
    readonly resolved: SpriteModule["default"] | undefined;
  }
>();
function mascotComponent(id: HarnessMascotId) {
  let entry = components.get(id);
  if (!entry) {
    let pending: Promise<SpriteModule> | undefined;
    let resolved: SpriteModule["default"] | undefined;
    const load = () =>
      (pending ??= Promise.all([
        loadHarnessMascotAnimations(id),
        loadHarnessMascotAssets(id),
        import("./HarnessMascotSprite"),
      ]).then(([, assets, module]) => {
        resolved = (props: SpriteProps) => <module.MascotSprite {...props} assets={assets} />;
        return { default: resolved };
      }));
    entry = {
      component: (props: SpriteProps) => {
        const Sprite = resolved ?? use(load()).default;
        return <Sprite {...props} />;
      },
      load,
      get resolved() {
        return resolved;
      },
    };
    components.set(id, entry);
  }
  return entry;
}

export async function preloadHarnessMascot(id: HarnessMascotId) {
  await mascotComponent(id).load();
}

/** Plain result capsules wait for a drawable pet rather than showing a blank slot. */
export function useHarnessMascotReady(id: HarnessMascotId | null) {
  const [loaded, setLoaded] = useState<HarnessMascotId | null>(null);
  const ready = id !== null && (components.get(id)?.resolved !== undefined || loaded === id);
  useEffect(() => {
    if (id === null || ready) return;
    let active = true;
    void preloadHarnessMascot(id)
      .then(() => {
        if (active) setLoaded(id);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, ready]);
  return ready;
}

export { HarnessMascotAgentId, HarnessMascotDriver, HarnessMascotTurnDuration };

export function HarnessMascot({
  driver,
  agentId,
  state = "idle",
  size = 24,
  still = false,
  visible = true,
}: {
  readonly driver?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly state?: HarnessMascotState;
  readonly size?: number;
  readonly still?: boolean;
  readonly visible?: boolean;
}) {
  const inherited = use(HarnessMascotDriver);
  const inheritedAgentId = use(HarnessMascotAgentId);
  const mascot = harnessMascotForDriver(
    driver === undefined ? inherited : driver,
    agentId === undefined && driver === undefined ? inheritedAgentId : agentId,
  );
  if (!mascot) return null;
  // An explicitly hidden, never-shown pet should not initialize its assets.
  if (!visible && !components.has(mascot.id)) return <View style={{ width: size, height: size }} />;
  const entry = mascotComponent(mascot.id);
  const Sprite = entry.component;
  return (
    <Suspense fallback={<View accessible={false} style={{ width: size, height: size }} />}>
      <Sprite
        key={mascot.id}
        id={mascot.id}
        state={state}
        size={size}
        still={still}
        visible={visible}
      />
    </Suspense>
  );
}

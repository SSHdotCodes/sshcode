import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useMemo,
  type LazyExoticComponent,
} from "react";
import {
  harnessMascotForDriver,
  loadHarnessMascotAnimations,
  type HarnessMascotId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";
import type { MascotSprite } from "./HarnessMascotSprite";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

type SpriteModule = { default: typeof MascotSprite };
const components = new Map<
  HarnessMascotId,
  {
    component: LazyExoticComponent<typeof MascotSprite>;
    load: () => Promise<SpriteModule>;
  }
>();
function mascotComponent(id: HarnessMascotId) {
  let entry = components.get(id);
  if (!entry) {
    let pending: Promise<SpriteModule> | undefined;
    const load = () =>
      (pending ??= Promise.all([loadHarnessMascotAnimations(id), import("./HarnessMascotSprite")])
        .then(([, module]) => ({ default: module.MascotSprite }))
        .catch((error: unknown) => {
          pending = undefined;
          // React.lazy also caches rejections. A later mount needs a fresh wrapper.
          if (components.get(id) === entry) components.delete(id);
          throw error;
        }));
    entry = { component: lazy(load), load };
    components.set(id, entry);
  }
  return entry;
}

export async function preloadHarnessMascot(id: HarnessMascotId) {
  await mascotComponent(id).load();
}

export const HarnessMascotTurnDuration = createContext(0);
export const HarnessMascotDriver = createContext<string | null>(null);
export const HarnessMascotAgentId = createContext<string | null>(null);

export function HarnessMascot({
  driver,
  agentId,
  state = "idle",
  size = 24,
  still = false,
}: {
  readonly driver?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly state?: HarnessMascotState;
  readonly size?: number;
  readonly still?: boolean;
}) {
  const inherited = useContext(HarnessMascotDriver);
  const inheritedAgentId = useContext(HarnessMascotAgentId);
  const mascot = harnessMascotForDriver(
    driver === undefined ? inherited : driver,
    agentId === undefined && driver === undefined ? inheritedAgentId : agentId,
  );
  const Sprite = useMemo(() => (mascot ? mascotComponent(mascot.id).component : null), [mascot]);
  if (!mascot || !Sprite) return null;
  const placeholder = (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", width: size, height: size, flexShrink: 0 }}
    />
  );
  return (
    <RenderErrorBoundary key={mascot.id} fallback={placeholder}>
      <Suspense fallback={placeholder}>
        <Sprite
          key={mascot.id}
          id={mascot.id}
          state={state}
          size={size}
          still={still}
          pixelArt={mascot.pixelArt}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
}

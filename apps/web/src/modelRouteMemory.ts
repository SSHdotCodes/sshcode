import {
  type MakerModel,
  type ModelRoute,
  type ModelRouteRef,
  type ModelRouteSource,
  parseModelRouteMemory,
  rememberChosenModelRoute,
  stickyModelRerouter,
} from "@t3tools/client-runtime/model-makers";

/**
 * The route chosen over a model's default, on this device. v1 recorded every pick, so
 * a model picked while its own harness could not run stayed pinned to the route that
 * could; v2 starts clean and holds only routes chosen over the default.
 */
const STORAGE_KEY = "t3code:model-picker-routes:v2";

export function readModelRouteMemory() {
  try {
    return parseModelRouteMemory(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveModelRoute<T extends ModelRouteSource>(
  model: MakerModel<T>,
  route: ModelRouteRef,
  isAvailable?: (route: ModelRoute<T>) => boolean,
  sameAccount?: (left: ModelRouteRef, right: ModelRouteRef) => boolean,
): void {
  try {
    const memory = readModelRouteMemory();
    const next = rememberChosenModelRoute(memory, model, route, isAvailable, sameAccount);
    if (next !== memory) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the picker falls back to its default route.
  }
}

/**
 * For the new-chat resolver: a model this device remembers on a gateway starts on its
 * maker's own harness once that offers it, unless the gateway was picked over that harness.
 */
export const rerouteStickyModel = (
  preferences: Parameters<typeof stickyModelRerouter>[0]["preferences"],
) => stickyModelRerouter({ memory: readModelRouteMemory, preferences });

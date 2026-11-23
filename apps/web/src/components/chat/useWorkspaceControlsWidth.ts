import { useCallback, useRef } from "react";
import { observeResize } from "~/lib/observeResize";

/**
 * The window's own buttons (side chat, panel toggles) sit fixed at the top right, over
 * whichever chat header is there. How wide they are depends on the focused chat, so a header
 * under them reads the width from this variable instead of assuming three buttons.
 */
export const WORKSPACE_CONTROLS_WIDTH = "--workspace-controls-width";

/** Room to leave at the end of a header that sits under the window's buttons. */
export const WORKSPACE_CONTROLS_ROOM = `calc(var(${WORKSPACE_CONTROLS_WIDTH}, 5.5rem) + 0.5rem)`;

/** A ref for the buttons' container: keeps the variable equal to its width. */
export function useWorkspaceControlsWidthRef() {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((element: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    if (!element) return;
    const write = () =>
      document.documentElement.style.setProperty(
        WORKSPACE_CONTROLS_WIDTH,
        `${Math.ceil(element.getBoundingClientRect().width)}px`,
      );
    write();
    stop.current = observeResize(element, write);
  }, []);
}

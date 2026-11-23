import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** How long the pointer rests on the window edge before the sidebar slides out. */
export const SIDEBAR_PEEK_OPEN_DELAY_MS = 80;
/** How long after the pointer leaves until the sidebar slides away; a held peek is rechecked this often. */
export const SIDEBAR_PEEK_CLOSE_DELAY_MS = 260;

export interface SidebarPeekController {
  edgeEnter(): void;
  edgeLeave(): void;
  sidebarEnter(): void;
  sidebarLeave(buttonDown: boolean): void;
  pointerReleased(): void;
  dispose(): void;
}

/**
 * Decides when a collapsed sidebar peeks out: it opens once the pointer rests on the window edge
 * and closes shortly after the pointer leaves, unless something still holds it.
 */
export function createSidebarPeekController(options: {
  onChange: (peeking: boolean) => void;
  /** True while the sidebar is in use: the pointer over it, a menu open from it, a field being typed in. */
  isHeld: () => boolean;
}): SidebarPeekController {
  let peeking = false;
  let dragging = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const setPeeking = (next: boolean) => {
    if (peeking === next) return;
    peeking = next;
    options.onChange(next);
  };
  const cancelOpen = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  const cancelClose = () => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const scheduleClose = () => {
    if (!peeking || closeTimer !== undefined) return;
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (dragging || options.isHeld()) scheduleClose();
      else setPeeking(false);
    }, SIDEBAR_PEEK_CLOSE_DELAY_MS);
  };

  return {
    edgeEnter() {
      if (peeking || openTimer !== undefined) return;
      openTimer = setTimeout(() => {
        openTimer = undefined;
        setPeeking(true);
      }, SIDEBAR_PEEK_OPEN_DELAY_MS);
    },
    edgeLeave() {
      cancelOpen();
      scheduleClose();
    },
    sidebarEnter() {
      cancelClose();
    },
    sidebarLeave(buttonDown) {
      // A row dragged out of the sidebar keeps it open until the drop.
      if (buttonDown) dragging = true;
      scheduleClose();
    },
    pointerReleased() {
      dragging = false;
    },
    dispose() {
      cancelOpen();
      cancelClose();
      dragging = false;
      setPeeking(false);
    },
  };
}

/** Whether the peeked app sidebar is still in use and must stay out. */
export function sidebarPeekIsHeld(): boolean {
  if (document.querySelector("[data-app-sidebar]:hover, [data-sidebar-control]:hover")) return true;
  // A menu opened from a sidebar row, or the dialog it led to, must not lose its sidebar.
  if (
    document.querySelector(
      '[data-app-sidebar] [data-popup-open], [role="dialog"][aria-modal="true"], [role="alertdialog"]',
    )
  ) {
    return true;
  }
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.closest("[data-app-sidebar]") !== null &&
    active.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')
  );
}

/** Peek state for the app sidebar, plus the pointer handlers for the window-edge strip and the sidebar. */
export function useSidebarPeek(enabled: boolean) {
  const [peeking, setPeeking] = useState(false);
  const controllerRef = useRef<SidebarPeekController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = createSidebarPeekController({
      onChange: setPeeking,
      isHeld: sidebarPeekIsHeld,
    });
    controllerRef.current = controller;
    const release = () => controller.pointerReleased();
    document.addEventListener("pointerup", release, true);
    document.addEventListener("dragend", release, true);
    return () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("dragend", release, true);
      controllerRef.current = null;
      controller.dispose();
    };
  }, [enabled]);

  // Touch has no hover; a finger on the edge must not open anything.
  const fromMouse =
    (run: (controller: SidebarPeekController, event: ReactPointerEvent) => void) =>
    (event: ReactPointerEvent) => {
      const controller = controllerRef.current;
      if (controller && event.pointerType === "mouse") run(controller, event);
    };

  return {
    peeking: enabled && peeking,
    edgeHandlers: {
      onPointerEnter: fromMouse((controller) => controller.edgeEnter()),
      onPointerLeave: fromMouse((controller) => controller.edgeLeave()),
    },
    sidebarHandlers: {
      onPointerEnter: fromMouse((controller) => controller.sidebarEnter()),
      onPointerLeave: fromMouse((controller, event) =>
        controller.sidebarLeave(event.buttons !== 0),
      ),
    },
  };
}

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useSyncExternalStore } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * Dragging a sidebar thread past the list edge turns the sort gesture into a context drop.
 * Targets mark themselves (a composer mentions the chat, a chat pane opens it in split
 * view); the sidebar hit-tests the pointer against them and hands over the dragged thread
 * refs through a DOM event, so neither side imports the other. Ghost position lives here rather than in Sidebar state so pointer moves only
 * re-render the ghost.
 */

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  // Not useEffectEvent: React 19.2 never refreshes it in memo() components, and the
  // composer is one, so drops kept landing in the first thread it rendered.
  const handleDrop = useStableCallback(onDrop);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [environmentId, handleDrop, targetKey, targetRef]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";
const DROP_LABEL_ATTRIBUTE = "data-thread-context-drop-label";

/** A composer mentions dropped chats; a chat pane opens them in split view. */
export type ThreadContextDropKind = "composer" | "split";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
  /** What releasing here does, when over a target. */
  readonly action: string | null;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

/** Tracks the ghost and the highlighted drop target while the pointer is outside the list. */
export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    // The kind as value, so a composer inside a chat pane lights only for its own drops.
    target?.setAttribute(DROP_OVER_ATTRIBUTE, target.getAttribute(DROP_TARGET_ATTRIBUTE) ?? "");
    overTarget = target;
  }
  setGhost({
    x: point.x,
    y: point.y,
    ...label,
    action: target?.getAttribute(DROP_LABEL_ATTRIBUTE) ?? null,
  });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

/** True when a composer accepted the drop. */
export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps(
  kind: ThreadContextDropKind = "composer",
  label = kind === "composer" ? "Mention" : "Open in split view",
) {
  return { [DROP_TARGET_ATTRIBUTE]: kind, [DROP_LABEL_ATTRIBUTE]: label } as const;
}

/** The drop's target kind, for a listener that also sees drops on nested targets. */
export function threadContextDropKind(target: EventTarget | null): ThreadContextDropKind | null {
  const kind =
    target !== null && "getAttribute" in target
      ? (target as Element).getAttribute(DROP_TARGET_ATTRIBUTE)
      : null;
  return kind === "composer" || kind === "split" ? kind : null;
}

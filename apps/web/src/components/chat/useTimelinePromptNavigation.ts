import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { resolveTimelinePromptJump, type TimelineMinimapItem } from "./timelineMinimapItems";

export type TimelinePromptNavigation = (direction: -1 | 1) => void;

export function useTimelinePromptNavigation({
  navigationRef,
  listRef,
  items,
  threadKey,
  pageKey,
  onManualNavigation,
  historyControls,
}: {
  navigationRef: RefObject<TimelinePromptNavigation | null> | undefined;
  listRef: RefObject<LegendListRef | null>;
  items: ReadonlyArray<TimelineMinimapItem>;
  threadKey: string;
  pageKey: string;
  onManualNavigation: () => void;
  historyControls?:
    | {
        hasMoreHistory: boolean;
        loading: boolean;
        error: string | null;
        onLoadEarlier: () => void;
      }
    | undefined;
}) {
  const pending = useRef<{ threadKey: string; beforeId: string | null } | null>(null);
  const requestedBefore = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState<{
    threadKey: string;
    text: string;
    sequence: number;
  } | null>(null);
  if (announcement !== null && announcement.threadKey !== threadKey) {
    setAnnouncement(null);
  }
  const select = useCallback(
    (item: TimelineMinimapItem) => {
      onManualNavigation();
      // Snap keyboard jumps so another keypress starts from the new prompt.
      void listRef.current?.scrollToIndex({
        index: item.rowIndex,
        animated: false,
        viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      });
      const index = items.indexOf(item);
      const preview = item.userText?.replace(/\s+/g, " ").trim() || "User message";
      setAnnouncement((previous) => ({
        threadKey,
        text: `Prompt ${index + 1} of ${items.length}: ${preview.slice(0, 80).trimEnd()}${preview.length > 80 ? "…" : ""}`,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
    },
    [items, listRef, onManualNavigation, threadKey],
  );
  const navigate = useCallback<TimelinePromptNavigation>(
    (direction) => {
      if (historyControls?.loading && pending.current) return;
      pending.current = null;
      requestedBefore.current = null;
      const state = listRef.current?.getState();
      if (!state) return;
      const viewport = listRef.current?.getScrollableNode();
      const viewportTop = viewport?.getBoundingClientRect().top;
      const item =
        direction === -1 && state.scroll <= 1
          ? null
          : resolveTimelinePromptJump(
              items,
              (index) => {
                const element = state.elementAtIndex?.(index);
                return element && viewportTop !== undefined
                  ? element.getBoundingClientRect().top - viewportTop + state.scroll
                  : state.positionAtIndex(index);
              },
              state.scroll + CHAT_TIMELINE_ANCHOR_OFFSET,
              direction,
            );
      if (item) {
        select(item);
      } else if (direction === -1 && historyControls?.hasMoreHistory) {
        onManualNavigation();
        const beforeId = items[0]?.id ?? null;
        pending.current = { threadKey, beforeId };
        requestedBefore.current = pageKey;
        historyControls.onLoadEarlier();
      }
    },
    [historyControls, items, listRef, onManualNavigation, pageKey, select, threadKey],
  );
  useLayoutEffect(() => {
    if (!navigationRef) return;
    navigationRef.current = navigate;
    const viewport = listRef.current?.getScrollableNode();
    const cancelPending = () => {
      pending.current = null;
    };
    viewport?.addEventListener("wheel", cancelPending, { passive: true });
    viewport?.addEventListener("pointerdown", cancelPending, { passive: true });
    return () => {
      if (navigationRef.current === navigate) navigationRef.current = null;
      viewport?.removeEventListener("wheel", cancelPending);
      viewport?.removeEventListener("pointerdown", cancelPending);
    };
  }, [listRef, navigate, navigationRef]);

  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    if (request.threadKey !== threadKey || historyControls?.error) {
      pending.current = null;
      return;
    }
    if (historyControls?.loading) return;
    const index =
      request.beforeId === null
        ? items.length
        : items.findIndex((item) => item.id === request.beforeId);
    const previous = items[index - 1];
    if (previous) {
      pending.current = null;
      select(previous);
    } else if (!historyControls?.hasMoreHistory) {
      pending.current = null;
    } else {
      if (requestedBefore.current === pageKey) return;
      requestedBefore.current = pageKey;
      historyControls.onLoadEarlier();
    }
  }, [historyControls, items, pageKey, select, threadKey]);

  return announcement?.threadKey === threadKey ? announcement : null;
}

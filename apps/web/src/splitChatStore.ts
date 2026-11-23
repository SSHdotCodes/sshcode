import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage, type StateStorage } from "./lib/storage";

export type SplitOrientation = "horizontal" | "vertical";
export interface SplitChat {
  panes: [ScopedThreadRef, ScopedThreadRef];
  orientation: SplitOrientation;
  ratio: number;
}

export const SPLIT_CHAT_STORAGE_KEY = "sshcode:split-chat:v1";
export const SPLIT_MIN_WIDTH = 360;
export const SPLIT_MIN_HEIGHT = 240;
export const SPLIT_DIVIDER_SIZE = 6;

export function sameSplitThread(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return scopedThreadKey(a) === scopedThreadKey(b);
}

/** Focus is always the route, including after a reload or a tab selection. */
export function splitPaneIndex(split: SplitChat | null, active: ScopedThreadRef | null) {
  return active && split ? split.panes.findIndex((ref) => sameSplitThread(ref, active)) : -1;
}

export function clampSplitRatio(ratio: number, size?: number, minimum = SPLIT_MIN_WIDTH): number {
  const min =
    size === undefined
      ? 0.15
      : size <= minimum * 2 + SPLIT_DIVIDER_SIZE
        ? 0.5
        : Math.max(0.15, minimum / (size - SPLIT_DIVIDER_SIZE));
  return Math.max(min, Math.min(1 - min, Number.isFinite(ratio) ? ratio : 0.5));
}

export function canShowSplit(width: number, height: number, orientation: SplitOrientation) {
  return (
    width >=
      (orientation === "horizontal" ? SPLIT_MIN_WIDTH * 2 + SPLIT_DIVIDER_SIZE : SPLIT_MIN_WIDTH) &&
    (orientation === "horizontal" || height >= SPLIT_MIN_HEIGHT * 2 + SPLIT_DIVIDER_SIZE)
  );
}

const isThreadRef = Schema.is(ScopedThreadRef);
export function restoreSplitChat(value: unknown): SplitChat | null {
  if (!value || typeof value !== "object") return null;
  const split = value as Partial<SplitChat>;
  if (
    !Array.isArray(split.panes) ||
    split.panes.length !== 2 ||
    !split.panes.every(isThreadRef) ||
    sameSplitThread(split.panes[0], split.panes[1]) ||
    (split.orientation !== "horizontal" && split.orientation !== "vertical") ||
    typeof split.ratio !== "number"
  )
    return null;
  return {
    panes: split.panes,
    orientation: split.orientation,
    ratio: clampSplitRatio(split.ratio),
  };
}

interface SplitChatStore {
  split: SplitChat | null;
  openBeside: (active: ScopedThreadRef, beside: ScopedThreadRef) => void;
  /** Shows `ref` in pane `index`; a chat already in the other pane trades places. */
  placeInPane: (index: 0 | 1, ref: ScopedThreadRef) => void;
  close: () => void;
  swap: () => void;
  toggleOrientation: () => void;
  setRatio: (ratio: number) => void;
  /** Unknown/offline chats survive until an authoritative result arrives. */
  prune: (isAvailable: (ref: ScopedThreadRef) => boolean | null) => ScopedThreadRef | null;
}

export function createSplitChatStore(storage: StateStorage) {
  return create<SplitChatStore>()(
    persist(
      (set, get) => ({
        split: null,
        openBeside: (active, beside) =>
          set((state) => {
            if (
              sameSplitThread(active, beside) ||
              (splitPaneIndex(state.split, beside) !== -1 &&
                splitPaneIndex(state.split, active) !== -1)
            )
              return state;
            return {
              split: {
                panes: [active, beside],
                orientation: state.split?.orientation ?? "horizontal",
                ratio: state.split?.ratio ?? 0.5,
              },
            };
          }),
        placeInPane: (index, ref) =>
          set((state) => {
            const split = state.split;
            if (!split || sameSplitThread(split.panes[index], ref)) return state;
            const other = split.panes[index === 0 ? 1 : 0];
            const panes: [ScopedThreadRef, ScopedThreadRef] = sameSplitThread(other, ref)
              ? [split.panes[1], split.panes[0]]
              : index === 0
                ? [ref, other]
                : [other, ref];
            return { split: { ...split, panes } };
          }),
        close: () => set({ split: null }),
        swap: () =>
          set((state) =>
            state.split
              ? {
                  split: {
                    ...state.split,
                    panes: [state.split.panes[1], state.split.panes[0]],
                    ratio: 1 - state.split.ratio,
                  },
                }
              : state,
          ),
        toggleOrientation: () =>
          set((state) =>
            state.split
              ? {
                  split: {
                    ...state.split,
                    orientation:
                      state.split.orientation === "horizontal" ? "vertical" : "horizontal",
                  },
                }
              : state,
          ),
        setRatio: (ratio) =>
          set((state) =>
            state.split ? { split: { ...state.split, ratio: clampSplitRatio(ratio) } } : state,
          ),
        prune: (isAvailable) => {
          const split = get().split;
          if (!split) return null;
          const available = split.panes.filter((ref) => isAvailable(ref) !== false);
          if (available.length === 2) return null;
          set({ split: null });
          return available[0] ?? null;
        },
      }),
      {
        name: SPLIT_CHAT_STORAGE_KEY,
        storage: createJSONStorage(() => storage),
        partialize: ({ split }) => ({ split }),
        merge: (saved, current) => ({
          ...current,
          split: restoreSplitChat((saved as { split?: unknown } | null)?.split),
        }),
      },
    ),
  );
}

export const useSplitChatStore = createSplitChatStore(
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
);

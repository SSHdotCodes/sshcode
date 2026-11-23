import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, Columns2Icon, Rows2Icon, XIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { environmentShell } from "../../state/shell";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ThreadRouteView } from "../ThreadRouteView";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useResizeDrag } from "../../hooks/useResizeDrag";
import { useThreadShell, useThreadStatus } from "../../state/entities";
import { useThreadFamilyResult } from "../../state/threads";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../../threadRoutes";
import {
  canShowSplit,
  clampSplitRatio,
  sameSplitThread,
  splitPaneIndex,
  SPLIT_DIVIDER_SIZE,
  SPLIT_MIN_HEIGHT,
  SPLIT_MIN_WIDTH,
  useSplitChatStore,
} from "../../splitChatStore";
import { SplitChatPaneContext } from "./SplitChatPaneContext";
import { KeptChatPane } from "./KeptChatPane";
import { keepChatViews, keptChatViewCapacity, type KeptChatView } from "./keptChatViews";
import { WORKSPACE_CONTROLS_ROOM } from "./useWorkspaceControlsWidth";
import { cn } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isSplittableChat } from "../../hooks/useOpenChatBeside";
import {
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropKind,
  threadContextDropTargetProps,
} from "./threadContextDrag";

function SplitPaneAvailability({
  threadRef,
  active,
}: {
  threadRef: ScopedThreadRef;
  active: ScopedThreadRef | null;
}) {
  const thread = useThreadShell(threadRef);
  const status = useThreadStatus(threadRef);
  const shellStatusAtom = useMemo(
    () =>
      Atom.map(environmentShell.stateValueAtom(threadRef.environmentId), (state) => {
        if (state.status !== "live") return "loading";
        if (state.removedAt.has(threadRef.threadId)) return "removed";
        return state.snapshot._tag === "Some" &&
          state.snapshot.value.idleAppOwnedSubagentsOmitted === true
          ? "families"
          : "full";
      }),
    [threadRef.environmentId, threadRef.threadId],
  );
  const shellStatus = useAtomValue(shellStatusAtom);
  const family = useThreadFamilyResult(
    thread === null && shellStatus === "families" ? threadRef : null,
  );
  const missingFromFamily =
    AsyncResult.isSuccess(family) &&
    !family.value.threads.some(({ id }) => id === threadRef.threadId);
  const unavailable =
    (thread === null &&
      (shellStatus === "removed" || shellStatus === "full" || missingFromFamily)) ||
    thread?.archivedAt != null ||
    thread?.deletedAt != null ||
    status === "deleted";
  const navigate = useNavigate();
  useEffect(() => {
    if (!unavailable) return;
    const survivor = useSplitChatStore.getState().prune((ref) => !sameSplitThread(ref, threadRef));
    if (survivor && active && sameSplitThread(active, threadRef)) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(survivor),
        replace: true,
      });
    }
  }, [active, navigate, unavailable, threadRef]);
  return null;
}

/** Memoized so a kept chat view is left alone while the surface renders another. */
const ChatPaneView = memo(function ChatPaneView(props: {
  target: ThreadRouteTarget;
  redirectMissing: boolean;
}) {
  return <ThreadRouteView target={props.target} embedded redirectMissing={props.redirectMissing} />;
});

export function SplitChatSurface({ target }: { target: ThreadRouteTarget }) {
  const [keptViews, setKeptViews] = useState<ReadonlyArray<KeptChatView>>([]);
  const split = useSplitChatStore((state) => state.split);
  const navigate = useNavigate();
  const active = target.kind === "server" ? target.threadRef : null;
  const activeIndex = splitPaneIndex(split, active);
  const remembered = activeIndex !== -1 ? split : null;
  const draftSession = useComposerDraftStore((store) =>
    target.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    active ? store.getDraftIdByRef(active) : null,
  );
  const [draftMount, setDraftMount] = useState<{ threadKey: string; key: string } | null>(null);
  // Carry the draft's outer element through promotion, just as ThreadRouteView
  // carries its ChatView. Focusing its neighbor must not discard that identity.
  const draftThreadKey = draftSession ? scopedThreadKey(draftSession) : null;
  const nextDraftMount =
    target.kind === "draft" && draftThreadKey
      ? draftMount?.key === target.draftId && draftMount.threadKey === draftThreadKey
        ? draftMount
        : { threadKey: draftThreadKey, key: target.draftId }
      : draftMount &&
          ((active && scopedThreadKey(active) === draftMount.threadKey) ||
            remembered?.panes.some((ref) => scopedThreadKey(ref) === draftMount.threadKey))
        ? draftMount
        : active && promotedDraftId
          ? { threadKey: scopedThreadKey(active), key: promotedDraftId }
          : null;
  if (nextDraftMount !== draftMount) setDraftMount(nextDraftMount);
  const orientation = remembered?.orientation ?? "horizontal";
  const horizontal = orientation === "horizontal";
  const container = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const desktopSize = useMediaQuery("md");
  const dockMaximized = useRightPanelStore((state) => {
    const panel = selectThreadRightPanelState(state.byThreadKey, active);
    return remembered !== null && panel.isOpen && panel.maximized === true;
  });
  const shown = remembered !== null && fits && desktopSize;
  const minimum = horizontal ? SPLIT_MIN_WIDTH : SPLIT_MIN_HEIGHT;
  const ratio = remembered?.ratio ?? 0.5;

  // Only the grid's CSS property changes during a drag. Neither chat receives
  // pointer-rate state updates, and persistence happens once on release.
  const applyRatio = useStableCallback((next: number) => {
    const node = container.current;
    if (!node) return 0.5;
    const size = horizontal ? node.clientWidth : node.clientHeight;
    const clamped = clampSplitRatio(next, size, minimum);
    node.style.setProperty("--split-ratio", String(clamped));
    divider.current?.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
    return clamped;
  });
  const { refresh, ...resize } = useResizeDrag<HTMLDivElement>(() => {
    const node = container.current;
    if (!node || !shown) return null;
    const size = (horizontal ? node.clientWidth : node.clientHeight) - SPLIT_DIVIDER_SIZE;
    return {
      axis: horizontal ? "x" : "y",
      edge: "right",
      width: applyRatio(ratio) * size,
      resize: (width) => applyRatio(width / size) * size,
      finish: (width) => useSplitChatStore.getState().setRatio(width / size),
      cleanup: (committed) => {
        if (!committed) applyRatio(ratio);
      },
    };
  }, `${orientation}:${shown}`);

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const update = () => {
      if (node.clientWidth > 0)
        setFits(canShowSplit(node.clientWidth, node.clientHeight, orientation));
      applyRatio(ratio);
      refresh();
    };
    update();
    return observeResize(node, update);
  }, [orientation, ratio, refresh, applyRatio]);

  const focus = (ref: ScopedThreadRef) => {
    if (active && sameSplitThread(active, ref)) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
      replace: true,
    });
  };
  const panes: ThreadRouteTarget[] =
    shown && remembered
      ? remembered.panes.map((threadRef) => ({ kind: "server", threadRef }))
      : [target];
  // Recently shown chats stay mounted, hidden (see KeptChatPane), and switching back
  // reveals them. A kept view keeps the key and target it first mounted with.
  const nextKeptViews = keepChatViews(
    keptViews,
    panes.flatMap((pane) => {
      if (pane.kind !== "server") return [];
      const threadKey = scopedThreadKey(pane.threadRef);
      const key = threadKey === nextDraftMount?.threadKey ? nextDraftMount.key : threadKey;
      return [{ key, threadKey, target: pane }];
    }),
    keptChatViewCapacity(),
  );
  if (nextKeptViews !== keptViews) setKeptViews(nextKeptViews);
  // One keyed list in mount order, so showing or hiding a view never moves another.
  const paneViews: ReadonlyArray<{ key: string; target: ThreadRouteTarget; index: number }> = [
    ...nextKeptViews
      .toSorted((left, right) => left.order - right.order)
      .map((view) => ({
        key: view.key,
        target: view.target,
        index: panes.findIndex(
          (pane) => pane.kind === "server" && scopedThreadKey(pane.threadRef) === view.threadKey,
        ),
      })),
    ...panes.flatMap((pane, index) =>
      pane.kind === "draft" ? [{ key: pane.draftId, target: pane, index }] : [],
    ),
  ];

  // A chat dragged from the sidebar onto a pane opens beside the current one, or
  // takes that pane when split view is already showing. Composers inside the panes
  // are their own targets (they mention the chat), so only pane drops count here.
  const dropOnPane = useStableCallback((index: number, refs: ReadonlyArray<ScopedThreadRef>) => {
    const dropped = refs.find(isSplittableChat);
    if (!dropped) return;
    const store = useSplitChatStore.getState();
    if (shown && remembered) store.placeInPane(index === 0 ? 0 : 1, dropped);
    else if (active && isSplittableChat(active)) store.openBeside(active, dropped);
    else return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(dropped) });
  });
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const listener = (event: Event) => {
      if (threadContextDropKind(event.target) !== "split") return;
      const index = Number((event.target as Element).getAttribute("data-split-drop-index"));
      dropOnPane(index, (event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail);
    };
    // Drops are dispatched on the pane without bubbling; capture still passes the grid.
    node.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener, true);
    return () => node.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener, true);
  }, [dropOnPane]);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {split?.panes.map((ref) => (
        <SplitPaneAvailability key={scopedThreadKey(ref)} threadRef={ref} active={active} />
      ))}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={container}
          data-split-chat={shown ? orientation : undefined}
          className={cn(
            "relative grid min-h-0 min-w-0 flex-1 overflow-hidden",
            dockMaximized && "hidden",
          )}
          style={{
            gridTemplateColumns:
              shown && horizontal
                ? `minmax(0, calc((100% - ${SPLIT_DIVIDER_SIZE}px) * var(--split-ratio, 0.5))) ${SPLIT_DIVIDER_SIZE}px minmax(0, 1fr)`
                : "minmax(0, 1fr)",
            gridTemplateRows:
              shown && !horizontal
                ? `minmax(0, calc((100% - ${SPLIT_DIVIDER_SIZE}px) * var(--split-ratio, 0.5))) ${SPLIT_DIVIDER_SIZE}px minmax(0, 1fr)`
                : "minmax(0, 1fr)",
          }}
        >
          {paneViews.map(({ key, target: viewTarget, index }) => {
            const pane = index === -1 ? null : panes[index];
            if (!pane) {
              return (
                <KeptChatPane key={key} hidden>
                  {/* The same tree as a shown pane's, so hiding never remounts the chat. */}
                  <section className="relative flex min-h-0 min-w-0 overflow-hidden">
                    <SplitChatPaneContext value={null}>
                      <ChatPaneView target={viewTarget} redirectMissing={remembered === null} />
                    </SplitChatPaneContext>
                  </section>
                </KeptChatPane>
              );
            }
            const focused =
              pane.kind !== "server" || !active || sameSplitThread(pane.threadRef, active);
            const controls =
              shown && pane.kind === "server" ? (
                <div
                  data-split-controls
                  className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
                  // This pane's header ends under the window's own buttons: leave exactly their
                  // width. A fixed three-button gap put Close pane under a fourth button.
                  style={
                    (horizontal ? index === 1 : index === 0)
                      ? { marginRight: WORKSPACE_CONTROLS_ROOM }
                      : undefined
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Swap panes"
                    aria-label="Swap panes"
                    onClick={() => useSplitChatStore.getState().swap()}
                  >
                    <ArrowLeftRightIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={horizontal ? "Stack panes" : "Place panes side by side"}
                    aria-label="Switch split orientation"
                    onClick={() => useSplitChatStore.getState().toggleOrientation()}
                  >
                    {horizontal ? <Rows2Icon /> : <Columns2Icon />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Close pane"
                    aria-label="Close pane"
                    onClick={() => {
                      const survivor = remembered?.panes[index === 0 ? 1 : 0];
                      useSplitChatStore.getState().close();
                      if (survivor) focus(survivor);
                    }}
                  >
                    <XIcon />
                  </Button>
                </div>
              ) : null;
            return (
              <KeptChatPane key={key} hidden={false}>
                <section
                  aria-label={
                    shown ? `Chat pane ${index + 1}${focused ? " (focused)" : ""}` : "Chat"
                  }
                  data-split-pane={
                    shown && pane.kind === "server" ? scopedThreadKey(pane.threadRef) : undefined
                  }
                  data-split-pane-focused={shown ? focused : undefined}
                  data-split-drop-index={index}
                  {...(pane.kind === "server"
                    ? threadContextDropTargetProps(
                        "split",
                        shown ? "Open in this pane" : "Open in split view",
                      )
                    : {})}
                  className={cn(
                    "relative flex min-h-0 min-w-0 overflow-hidden",
                    "before:pointer-events-none before:absolute before:inset-0 before:z-40 before:hidden before:bg-primary/6 before:ring-2 before:ring-inset before:ring-primary/60 data-[thread-context-over=split]:before:block",
                    shown &&
                      focused &&
                      "after:pointer-events-none after:absolute after:inset-0 after:z-30 after:ring-1 after:ring-inset after:ring-primary/35",
                  )}
                  style={{
                    gridColumn: shown && horizontal ? index * 2 + 1 : 1,
                    gridRow: shown && !horizontal ? index * 2 + 1 : 1,
                  }}
                  onPointerDownCapture={(event) => {
                    if (
                      pane.kind === "server" &&
                      !(
                        event.target instanceof Element &&
                        event.target.closest("[data-split-controls]")
                      )
                    )
                      focus(pane.threadRef);
                  }}
                  onFocusCapture={(event) => {
                    if (
                      pane.kind === "server" &&
                      !(
                        event.target instanceof Element &&
                        event.target.closest("[data-split-controls]")
                      )
                    )
                      focus(pane.threadRef);
                  }}
                >
                  <SplitChatPaneContext value={remembered ? { focused, dock, controls } : null}>
                    <ChatPaneView target={viewTarget} redirectMissing={remembered === null} />
                  </SplitChatPaneContext>
                </section>
              </KeptChatPane>
            );
          })}
          {shown ? (
            <div
              ref={divider}
              role="separator"
              tabIndex={0}
              aria-label="Resize chat panes"
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
              className={cn(
                "z-20 touch-none bg-border/50 hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none",
                horizontal ? "cursor-col-resize" : "cursor-row-resize",
              )}
              style={{ gridColumn: horizontal ? 2 : 1, gridRow: horizontal ? 1 : 2 }}
              {...resize}
              onDoubleClick={() => useSplitChatStore.getState().setRatio(0.5)}
              onKeyDown={(event) => {
                const delta =
                  event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
                    ? -0.05
                    : event.key === (horizontal ? "ArrowRight" : "ArrowDown")
                      ? 0.05
                      : 0;
                if (!delta && event.key !== "Home") return;
                event.preventDefault();
                useSplitChatStore
                  .getState()
                  .setRatio(applyRatio(event.key === "Home" ? 0.5 : ratio + delta));
              }}
            />
          ) : null}
        </div>
        <div
          ref={setDock}
          className={cn("flex min-h-0 shrink-0", dockMaximized && "min-w-0 flex-1")}
          data-split-chat-dock
        />
      </div>
    </SidebarInset>
  );
}

// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

// Exercise the shipped patch without loading React Native in the Node runner.
// Native scroll delivery and animation frames advance independently here.
function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("gates the seeded contentOffset completion path too", () => {
      const list = createList(bundle);
      list.complete();
      expect(list.ready()).toBe(false);
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("preserves an initial index before the last item", () => {
      const list = createList(bundle);
      list.state.props.data = ["requested message", "later message"];
      list.state.scroll = 200;
      list.complete();
      list.advance(8);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("accounts for header insets when content is shorter than the full viewport", () => {
      const list = createList(bundle);
      list.resize(780);
      list.state.scroll = -20;
      list.state.lastNativeScroll = -100;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: -20 });
      list.state.lastNativeScroll = -20;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("preserves a drag that started before initial layout completed", () => {
      const list = createList(bundle);
      list.state.didUserDrag = true;
      list.complete();
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("reveals short content at UIKit's resting offset without awaiting a scroll event", () => {
      const list = createList(bundle);
      list.resize(700);
      list.state.lastNativeScroll = undefined;
      list.complete();
      expect(list.ready()).toBe(true);
      list.advance(10);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("does not gate empty lists or lists without an automatic header inset", () => {
      const list = createList(bundle);
      list.setInset(0);
      list.complete();
      expect(list.ready()).toBe(true);
      const empty = createList(bundle);
      empty.state.props.data = [];
      empty.complete();
      expect(empty.ready()).toBe(true);
    });
  },
);

function createWebScrollHarness(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const finishSlice = source.slice(
    source.indexOf("// src/core/finishInitialScroll.ts"),
    source.indexOf("// src/core/calculateOffsetForIndex.ts"),
  );
  const doScrollSlice = source.slice(
    source.indexOf("// src/core/doScrollTo.ts"),
    source.indexOf("// src/core/doMaintainScrollAtEnd.ts"),
  );
  const advanceSlice = source.slice(
    source.indexOf("function getAdvanceableInitialScrollState("),
    source.indexOf("function advanceMeasuredInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const timeouts: Array<{ delay: number; key: string | undefined; cb: () => void }> = [];
  const finishScrollTo = vi.fn();
  const recalculateSettledScroll = vi.fn();
  const setInitialRenderState = vi.fn();
  const releaseDeferredPublicOnScroll = vi.fn();
  let domScrollTop = 0;
  let domScrollHeight = 3080;
  let expectedContentSize = 3080;
  const scrollToCalls: Array<{ animated: boolean; x: number; y: number }> = [];
  const scroller = {
    getScrollableNode: () => ({
      scrollHeight: domScrollHeight,
      clientHeight: 748,
      scrollWidth: 900,
      clientWidth: 900,
    }),
    getCurrentScrollOffset: () => domScrollTop,
    scrollTo: (opts: { animated: boolean; x: number; y: number }) => {
      scrollToCalls.push(opts);
      const maxOffset = Math.max(0, domScrollHeight - 748);
      domScrollTop = Math.max(0, Math.min(opts.y, maxOffset));
    },
  };
  const scheduledWork = {
    cancel: vi.fn(),
    frame: (cb: () => void) => {
      frames.push(cb);
    },
    timeout: (cb: () => void, delay: number, key?: string) => {
      timeouts.push({ delay, key, cb });
    },
    register: vi.fn(),
  };
  const state = {
    props: { data: ["a", "b"], horizontal: false },
    initialScroll: { index: 1, viewPosition: 1, contentOffset: undefined as number | undefined },
    initialScrollSession: { kind: "bootstrap" },
    didFinishInitialScroll: false,
    queuedInitialLayout: true,
    scrollingTo: {
      isInitialScroll: true,
      waitForInitialScrollCompletionFrame: true,
      offset: 2332,
    } as Record<string, unknown> | undefined,
    scroll: 0,
    scrollPending: 0,
    scrollPrev: 0,
    hasScrolled: false,
    refScroller: { current: scroller },
    scheduledWork,
    isFinishingInitialScroll: false,
    initialScrollFinishToken: 0,
  };
  const ctx = { state };
  const api = NodeVM.runInNewContext(
    `${finishSlice}\n${doScrollSlice}\n${advanceSlice}\n({ doScrollTo, finishInitialScroll, getAdvanceableInitialScrollState })`,
    {
      requestAnimationFrame: (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      },
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      getContentSize: () => expectedContentSize,
      toNativeHorizontalOffset: (_s: unknown, offset: number) => offset,
      finishScrollTo,
      recalculateSettledScroll: (c: typeof ctx) => {
        // Simulate calculateItemsInView -> handleInitialScrollLayoutReady querying advanceability
        // while recalculateSettledScroll runs inside finishInitialScroll.
        recalculateSettledScroll(api.getAdvanceableInitialScrollState(c.state));
      },
      setInitialRenderState: (c: typeof ctx, flags: { didInitialScroll?: boolean }) => {
        if (flags.didInitialScroll) c.state.didFinishInitialScroll = true;
        setInitialRenderState(flags);
      },
      releaseDeferredPublicOnScroll,
      setInitialScrollSession: vi.fn(),
      initialScrollWatchdog: { clear: vi.fn() },
      initialScrollCompletion: { resetFlags: vi.fn() },
      cancelScrollCompletionChecks: vi.fn(),
    },
  ) as {
    doScrollTo: (
      context: typeof ctx,
      params: { animated: boolean; horizontal: boolean; offset: number },
    ) => void;
    finishInitialScroll: (context: typeof ctx, options?: Record<string, unknown>) => void;
    getAdvanceableInitialScrollState: (s: typeof state, opts?: Record<string, unknown>) => unknown;
  };
  return {
    state,
    ctx,
    api,
    frames,
    timeouts,
    scrollToCalls,
    finishScrollTo,
    recalculateSettledScroll,
    setInitialRenderState,
    setDomScrollHeight: (h: number) => {
      domScrollHeight = h;
    },
    setExpectedContentSize: (h: number) => {
      expectedContentSize = h;
    },
    getDomScrollTop: () => domScrollTop,
    flushFrame: () => {
      const batch = frames.splice(0);
      for (const fn of batch) fn();
    },
  };
}

describe.each(["react.js", "react.mjs", "react-native.web.js", "react-native.web.mjs"])(
  "web synchronous initial scroll reveal (%s)",
  (bundle) => {
    it("finishes synchronous non-animated scroll immediately without a 100 ms fallback timer", () => {
      const h = createWebScrollHarness(bundle);
      h.api.doScrollTo(h.ctx, { animated: false, horizontal: false, offset: 2332 });
      expect(h.getDomScrollTop()).toBe(2332);
      expect(h.finishScrollTo).toHaveBeenCalledTimes(1);
      expect(h.timeouts).toHaveLength(0);
      expect(h.state.scrollingTo?.waitForInitialScrollCompletionFrame).toBe(false);
    });

    it("finishes zero-offset short-list scrolls immediately without waiting for a scroll event", () => {
      const h = createWebScrollHarness(bundle);
      h.setDomScrollHeight(748);
      h.setExpectedContentSize(748);
      h.state.scrollingTo = {
        isInitialScroll: true,
        waitForInitialScrollCompletionFrame: true,
        offset: 0,
      };
      h.api.doScrollTo(h.ctx, { animated: false, horizontal: false, offset: 0 });
      expect(h.getDomScrollTop()).toBe(0);
      expect(h.finishScrollTo).toHaveBeenCalledTimes(1);
      expect(h.timeouts).toHaveLength(0);
    });

    it("retries on animation frame instead of waiting 100 ms when DOM scrollHeight lags totalSize", () => {
      const h = createWebScrollHarness(bundle);
      h.setDomScrollHeight(2700);
      h.setExpectedContentSize(3080);
      h.api.doScrollTo(h.ctx, { animated: false, horizontal: false, offset: 2332 });
      expect(h.finishScrollTo).not.toHaveBeenCalled();
      expect(h.timeouts).toHaveLength(0);
      expect(h.frames).toHaveLength(1);

      h.setDomScrollHeight(3080);
      h.flushFrame();
      expect(h.getDomScrollTop()).toBe(2332);
      expect(h.finishScrollTo).toHaveBeenCalledTimes(1);
      expect(h.timeouts).toHaveLength(0);
    });

    it("blocks re-entrant initial scroll dispatch while finishInitialScroll is completing", () => {
      const h = createWebScrollHarness(bundle);
      h.state.scrollingTo = undefined;
      h.api.finishInitialScroll(h.ctx, {
        preserveTarget: true,
        recalculateItems: true,
        resolvedOffset: 2332,
        waitForCompletionFrame: true,
      });
      // While awaiting the completion frame, a pending handleInitialScrollLayoutReady rAF
      // must not treat the initial scroll as advanceable and re-dispatch a duplicate scrollTo.
      expect(h.api.getAdvanceableInitialScrollState(h.state)).toBeUndefined();

      h.flushFrame();
      // Even during recalculateSettledScroll inside complete(), advanceability stays blocked.
      expect(h.recalculateSettledScroll).toHaveBeenCalledWith(undefined);
      expect(h.state.didFinishInitialScroll).toBe(true);
      expect(h.state.initialScroll?.contentOffset).toBe(2332);
    });
  },
);

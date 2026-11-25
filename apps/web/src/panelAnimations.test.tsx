import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolvePanelExitDurationMs,
  usePanelNavigationSuppression,
  usePanelPresence,
} from "./panelAnimations";

let renderer: ReactTestRenderer | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];

function SuppressionProbe({ navigationKey }: { navigationKey: string }) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [suppressed]);
  return null;
}

let observedPresence: Array<{ present: boolean; value: string | null }> = [];

function PresenceProbe(props: {
  open: boolean;
  value: string | null;
  animated: boolean;
  scopeKey: string | null;
  exitDurationMs: number;
}) {
  const result = usePanelPresence(
    props.open,
    props.value,
    props.animated,
    props.scopeKey,
    props.exitDurationMs,
  );
  useLayoutEffect(() => {
    observedPresence.push(result);
  }, [result]);
  return null;
}

beforeEach(() => {
  pendingFrames = [];
  observed = [];
  observedPresence = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
    cancelAnimationFrame: vi.fn(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function paintPendingFrame() {
  const callback = pendingFrames.shift();
  await act(() => callback?.(0));
}

describe("resolvePanelExitDurationMs", () => {
  it("keeps exits instant when duration is zero and snappier otherwise", () => {
    expect(resolvePanelExitDurationMs(0)).toBe(0);
    expect(resolvePanelExitDurationMs(175)).toBe(119);
    expect(resolvePanelExitDurationMs(200)).toBe(120);
    expect(resolvePanelExitDurationMs(100)).toBe(80);
  });
});

describe("usePanelNavigationSuppression", () => {
  it("suppresses initial and navigated panel state until each route has painted", async () => {
    await act(() => {
      renderer = create(<SuppressionProbe navigationKey="/thread/one" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    await act(() => {
      renderer?.update(<SuppressionProbe navigationKey="/thread/two" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});

describe("usePanelPresence", () => {
  it("retains closing content until the exit duration finishes, then unmounts", async () => {
    vi.useFakeTimers();
    await act(() => {
      renderer = create(
        <PresenceProbe open value="diff" animated scopeKey="thread-1" exitDurationMs={120} />,
      );
    });
    expect(observedPresence.at(-1)).toEqual({ present: true, value: "diff" });

    await act(() => {
      renderer?.update(
        <PresenceProbe
          open={false}
          value={null}
          animated
          scopeKey="thread-1"
          exitDurationMs={120}
        />,
      );
    });
    expect(observedPresence.at(-1)).toEqual({ present: true, value: "diff" });

    await act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(observedPresence.at(-1)).toEqual({ present: false, value: null });
  });

  it("unmounts immediately when closing across a thread switch or without animation", async () => {
    vi.useFakeTimers();
    await act(() => {
      renderer = create(
        <PresenceProbe open value="diff" animated scopeKey="thread-1" exitDurationMs={120} />,
      );
    });
    await act(() => {
      renderer?.update(
        <PresenceProbe
          open={false}
          value={null}
          animated
          scopeKey="thread-2"
          exitDurationMs={120}
        />,
      );
    });
    expect(observedPresence.at(-1)).toEqual({ present: false, value: null });

    await act(() => {
      renderer?.update(
        <PresenceProbe
          open
          value="files"
          animated={false}
          scopeKey="thread-2"
          exitDurationMs={120}
        />,
      );
    });
    await act(() => {
      renderer?.update(
        <PresenceProbe
          open={false}
          value={null}
          animated={false}
          scopeKey="thread-2"
          exitDurationMs={120}
        />,
      );
    });
    expect(observedPresence.at(-1)).toEqual({ present: false, value: null });
  });
});

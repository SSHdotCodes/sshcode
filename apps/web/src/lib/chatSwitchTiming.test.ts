// @vitest-environment jsdom

import * as Tracer from "effect/Tracer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ClientTracer from "../observability/clientTracer";
import { CHAT_SWITCH_MEASURE, installChatSwitchTiming, reportChatShown } from "./chatSwitchTiming";

type Listener = Parameters<Parameters<typeof installChatSwitchTiming>[0]["subscribe"]>[1];

function fakeRouter() {
  let listener: Listener | null = null;
  return {
    getMatchedRoutes: (pathname: string) => {
      const [environmentId, threadId, extra] = pathname.split("/").filter(Boolean);
      return environmentId && threadId && !extra && environmentId !== "settings"
        ? {
            foundRoute: { id: "/_chat/$environmentId/$threadId" },
            routeParams: { environmentId, threadId },
          }
        : { foundRoute: undefined, routeParams: {} };
    },
    subscribe: (_event: "onBeforeNavigate", next: Listener) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    navigate: (from: string, to: string) =>
      listener?.({ fromLocation: { pathname: from }, toLocation: { pathname: to } }),
  };
}

async function flushFrame() {
  for (const callback of frames.splice(0)) callback(performance.now());
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let frames: Array<FrameRequestCallback> = [];
let uninstall: () => void = () => {};
const spans: Array<{ name: string; attributes: ReadonlyMap<string, unknown> }> = [];

beforeEach(() => {
  frames = [];
  spans.length = 0;
  performance.clearMeasures();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  ClientTracer.setDelegate(
    Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
  );
});

afterEach(() => {
  uninstall();
  ClientTracer.setDelegate(null);
  vi.unstubAllGlobals();
});

describe("chat switch timing", () => {
  it("measures from the click that opened another chat to the frame after it shows", async () => {
    const router = fakeRouter();
    uninstall = installChatSwitchTiming(router);
    const click = new MouseEvent("click");
    window.dispatchEvent(click);
    router.navigate("/env-1/thread-a", "/env-1/thread-b");

    reportChatShown("env-1:thread-b", true);
    expect(performance.getEntriesByName(CHAT_SWITCH_MEASURE)).toHaveLength(0);
    await flushFrame();

    const [measure] = performance.getEntriesByName(CHAT_SWITCH_MEASURE) as PerformanceMeasure[];
    expect(measure?.startTime).toBe(click.timeStamp);
    expect(measure?.detail).toEqual({ threadKey: "env-1:thread-b", kept: true });
    expect(spans.map((span) => [span.name, span.attributes.get("chat.switch.kept")])).toEqual([
      ["web.chat.switch", true],
    ]);
  });

  it("ignores navigation that stays on a chat or leaves the chats", async () => {
    const router = fakeRouter();
    uninstall = installChatSwitchTiming(router);
    router.navigate("/env-1/thread-a", "/env-1/thread-a");
    router.navigate("/env-1/thread-a", "/settings/general");
    reportChatShown("env-1:thread-a", false);
    await flushFrame();

    expect(performance.getEntriesByName(CHAT_SWITCH_MEASURE)).toHaveLength(0);
  });

  it("only the chosen chat ends its switch, once", async () => {
    const router = fakeRouter();
    uninstall = installChatSwitchTiming(router);
    router.navigate("/env-1/thread-a", "/env-1/thread-b");
    reportChatShown("env-1:thread-a", true);
    await flushFrame();
    expect(performance.getEntriesByName(CHAT_SWITCH_MEASURE)).toHaveLength(0);

    reportChatShown("env-1:thread-b", false);
    reportChatShown("env-1:thread-b", false);
    await flushFrame();
    expect(performance.getEntriesByName(CHAT_SWITCH_MEASURE)).toHaveLength(1);
  });
});

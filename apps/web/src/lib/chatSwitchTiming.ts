import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { recordSpan } from "../observability/clientTracer";
import { resolveThreadRouteTarget } from "../threadRoutes";

/**
 * Times a chat switch from the input that asked for it (a click, a key) to the
 * first painted frame that shows the chosen chat's transcript. Each switch is a
 * `t3:chat-switch` performance measure and a `web.chat.switch` client span, so
 * real numbers can be read from the DevTools timeline or the server trace log.
 */
export const CHAT_SWITCH_MEASURE = "t3:chat-switch";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId";
// An input this recent started the navigation; an older one was something else.
const INPUT_WINDOW_MS = 1_000;
// A switch whose chat never shows (an empty or deleted chat) is dropped.
const ABANDON_AFTER_MS = 30_000;

interface PendingSwitch {
  readonly threadKey: string;
  readonly startedAt: number;
}

let lastInputAt = Number.NEGATIVE_INFINITY;
let pending: PendingSwitch | null = null;

interface ChatSwitchRouter {
  getMatchedRoutes: (pathname: string) => {
    readonly foundRoute: { readonly id: string } | undefined;
    readonly routeParams: Record<string, string>;
  };
  subscribe: (
    event: "onBeforeNavigate",
    listener: (event: {
      readonly fromLocation?: { readonly pathname: string } | undefined;
      readonly toLocation: { readonly pathname: string };
    }) => void,
  ) => () => void;
}

function threadKeyAt(router: ChatSwitchRouter, pathname: string | undefined): string | null {
  if (pathname === undefined) return null;
  const { foundRoute, routeParams } = router.getMatchedRoutes(pathname);
  const target = foundRoute?.id === THREAD_ROUTE_ID ? resolveThreadRouteTarget(routeParams) : null;
  return target?.kind === "server" ? scopedThreadKey(target.threadRef) : null;
}

/** Starts timing every navigation that lands on a different chat. */
export function installChatSwitchTiming(router: ChatSwitchRouter): () => void {
  const onInput = (event: Event) => {
    lastInputAt = event.timeStamp;
  };
  const options = { capture: true, passive: true } as const;
  const inputs = ["pointerdown", "click", "keydown"] as const;
  for (const type of inputs) window.addEventListener(type, onInput, options);
  const unsubscribe = router.subscribe("onBeforeNavigate", (event) => {
    const threadKey = threadKeyAt(router, event.toLocation.pathname);
    if (threadKey === null || threadKey === threadKeyAt(router, event.fromLocation?.pathname)) {
      return;
    }
    beginChatSwitch(threadKey, performance.now());
  });
  return () => {
    unsubscribe();
    for (const type of inputs) window.removeEventListener(type, onInput, options);
  };
}

export function beginChatSwitch(threadKey: string, now: number): void {
  pending = { threadKey, startedAt: now - lastInputAt <= INPUT_WINDOW_MS ? lastInputAt : now };
}

/**
 * Called from the commit that shows `threadKey`'s transcript. `kept` says the
 * view was already mounted and only revealed. The measure ends after the next
 * paint: a frame callback runs just before it, a message task just after.
 */
export function reportChatShown(threadKey: string, kept: boolean): void {
  const shown = pending;
  if (shown === null || shown.threadKey !== threadKey) return;
  pending = null;
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      const end = performance.now();
      const durationMs = end - shown.startedAt;
      if (durationMs > ABANDON_AFTER_MS) return;
      performance.measure(CHAT_SWITCH_MEASURE, {
        start: shown.startedAt,
        end,
        detail: { threadKey, kept },
      });
      recordSpan("web.chat.switch", shown.startedAt, end, {
        "chat.switch.kept": kept,
        "chat.switch.duration_ms": Math.round(durationMs * 10) / 10,
      });
    };
    channel.port2.postMessage(null);
  });
}

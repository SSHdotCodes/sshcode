import type { NotificationBehavior, NotificationResponse } from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useAgentNotificationNavigation } from "./notificationNavigation";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

const foreground = vi.hoisted(() => ({
  connection: "connected",
  feed: "live",
  setHandler: vi.fn(),
  presentationAtom: Symbol("presentation"),
  threadAtom: Symbol("thread"),
  navigate: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void) => effect(),
  useLayoutEffect: (effect: () => void) => effect(),
  useRef: <A>(current: A) => ({ current }),
}));
vi.mock("@react-navigation/native", () => ({ useLinkTo: () => foreground.navigate }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: foreground.setHandler,
  addNotificationResponseReceivedListener: () => ({ remove: vi.fn() }),
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock("./androidNotifications", () => ({ setAndroidThreadOnScreen: vi.fn() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => foreground.presentationAtom },
}));
vi.mock("../../state/threads", () => ({
  environmentThreads: { stateAtom: () => foreground.threadAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: symbol) =>
      atom === foreground.presentationAtom
        ? { connection: { phase: foreground.connection } }
        : AsyncResult.success({ status: foreground.feed }),
  },
}));

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("presents an alert on a cached thread until its live feed has caught up", async () => {
  useAgentNotificationNavigation("/threads/env/thread");
  const handler: {
    handleNotification: (notification: unknown) => Promise<NotificationBehavior>;
  } = foreground.setHandler.mock.lastCall?.[0];
  const { notification } = responseWithData({ deepLink: "/threads/env/thread" });

  foreground.connection = "reconnecting";
  foreground.feed = "cached";
  expect((await handler.handleNotification(notification)).shouldShowBanner).toBe(true);

  foreground.connection = "connected";
  foreground.feed = "synchronizing";
  expect((await handler.handleNotification(notification)).shouldShowBanner).toBe(true);

  foreground.feed = "live";
  expect((await handler.handleNotification(notification)).shouldShowBanner).toBe(false);
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports which initial-response operation failed", async () => {
    const cause = new Error("notification lookup unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.reject(cause),
      clearLastResponse: () => Promise.resolve(),
      handleResponse: vi.fn(),
    });

    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "read",
      }),
    );
  });

  it("routes a response before reporting a clear failure", async () => {
    const cause = new Error("notification clear unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-clear") as NotificationResponse;
    const handleResponse = vi.fn();

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse: () => Promise.reject(cause),
      handleResponse,
    });

    expect(handleResponse).toHaveBeenCalledWith(response);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "clear",
        notificationId: "notification-clear",
      }),
    );
  });

  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("normalizes explicit thread deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env%201/thread%2F2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});

it("keeps a failed response available to retry navigation", async () => {
  const handledResponseIds = new Set<string>();
  const response = responseWithData({
    environmentId: "env",
    threadId: "thread",
  }) as NotificationResponse;
  const clearLastResponse = vi.fn(async () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const navigate = vi.fn().mockImplementationOnce(() => {
    throw new Error("navigation not ready");
  });
  const consume = () =>
    consumeLastAgentNotificationResponse({
      getLastResponse: async () => response,
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });
  await consume();
  expect(handledResponseIds.size).toBe(0);
  expect(clearLastResponse).not.toHaveBeenCalled();
  await consume();
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(clearLastResponse).toHaveBeenCalledTimes(1);
  expect(handledResponseIds.has("notification-1")).toBe(true);
});
it("ignores malformed UTF-16 notification ids", () => {
  expect(
    extractAgentNotificationDeepLink(
      responseWithData({ environmentId: "env", threadId: "\ud800" }),
    ),
  ).toBeNull();
});

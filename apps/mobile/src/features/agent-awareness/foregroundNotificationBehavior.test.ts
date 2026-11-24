import type { Notification } from "expo-notifications";
import { describe, expect, it } from "vite-plus/test";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { threadDeepLinkOnScreen } from "./notificationPayload";

function notificationWithData(data: Record<string, unknown>): Notification {
  return {
    date: 0,
    request: { identifier: "notification-1", content: { data }, trigger: null },
  } as unknown as Notification;
}

describe("threadDeepLinkOnScreen", () => {
  it("maps a thread route and its nested screens to the thread deep link", () => {
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1")).toBe("/threads/env-1/thread-1");
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1/files/src")).toBe(
      "/threads/env-1/thread-1",
    );
  });

  it("normalizes unencoded colons and strips query/hash from React Navigation paths", () => {
    // React Navigation's getPathFromState emits raw colons (e.g. thread:delegated-task:abc),
    // while notification payloads percent-encode segments via encodeURIComponent.
    expect(threadDeepLinkOnScreen("/threads/env:1/thread:delegated-task:abc")).toBe(
      "/threads/env%3A1/thread%3Adelegated-task%3Aabc",
    );
    expect(threadDeepLinkOnScreen("/threads/env%3A1/thread%3Adelegated-task%3Aabc/files/src")).toBe(
      "/threads/env%3A1/thread%3Adelegated-task%3Aabc",
    );
    expect(threadDeepLinkOnScreen("/threads/env-1/thread:1?focus=1#bottom")).toBe(
      "/threads/env-1/thread%3A1",
    );
  });

  it("returns null outside a thread", () => {
    expect(threadDeepLinkOnScreen("/")).toBeNull();
    expect(threadDeepLinkOnScreen("/settings")).toBeNull();
    expect(threadDeepLinkOnScreen("/threads/env-1")).toBeNull();
  });
});

describe("foregroundNotificationBehavior", () => {
  const isLive = () => true;

  it("suppresses a notification for the thread already on screen", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
      "/threads/env-1/thread-1",
      isLive,
    );
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldShowList).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
  });

  it("suppresses a notification for a colon-containing thread id on screen", () => {
    const onScreen = threadDeepLinkOnScreen("/threads/env:1/thread:delegated-task:abc");
    const behavior = foregroundNotificationBehavior(
      notificationWithData({
        environmentId: "env:1",
        threadId: "thread:delegated-task:abc",
      }),
      onScreen,
      isLive,
    );
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldShowList).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
  });

  it("shows a notification for another thread", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ deepLink: "/threads/env-1/thread-2" }),
      "/threads/env-1/thread-1",
      isLive,
    );
    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldShowList).toBe(true);
  });

  it("shows a notification when no thread is open or the payload has no target", () => {
    expect(
      foregroundNotificationBehavior(
        notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
        null,
        isLive,
      ).shouldShowBanner,
    ).toBe(true);
    expect(
      foregroundNotificationBehavior(notificationWithData({}), "/threads/env-1/thread-1", isLive)
        .shouldShowBanner,
    ).toBe(true);
  });
});

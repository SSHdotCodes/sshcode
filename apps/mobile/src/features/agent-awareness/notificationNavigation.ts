import { useEffect, useLayoutEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentThreads } from "../../state/threads";
import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

function threadHasLiveFeed(deepLink: string): boolean {
  const [, , environment, thread] = deepLink.split("/");
  if (!environment || !thread) return false;
  const environmentId = EnvironmentId.make(decodeURIComponent(environment));
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  if (presentation?.connection.phase !== "connected") return false;
  const result = appAtomRegistry.get(
    environmentThreads.stateAtom(environmentId, ThreadId.make(decodeURIComponent(thread))),
  );
  return Option.exists(AsyncResult.value(result), ({ status }) => status === "live");
}

export function useAgentNotificationNavigation(pathname: string): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());
  // Read through a ref so the native handler registered once below sees the
  // current route without re-registering on every navigation.
  const deepLinkOnScreen = useRef<string | null>(null);
  useLayoutEffect(() => {
    const thread = threadDeepLinkOnScreen(pathname);
    deepLinkOnScreen.current = thread;
    // Android alerts are built natively from FCM data, so update the native
    // route at commit time alongside the iOS handler's route reference.
    setAndroidThreadOnScreen(thread);
  }, [pathname]);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: (notification) =>
        Promise.resolve(
          foregroundNotificationBehavior(notification, deepLinkOnScreen.current, threadHasLiveFeed),
        ),
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}

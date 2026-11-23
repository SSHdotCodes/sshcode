import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState } from "react-native";

/** Only a visible, foreground chat may advance the cross-device read watermark. */
export function useThreadVisit(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly updatedAt: string;
  readonly lastVisitedAt: string | null | undefined;
  readonly completedAt: string | null | undefined;
  readonly showContent: boolean;
  readonly visitThread: (request: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; visitedAt: string };
  }) => unknown;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const [active, setActive] = useState(() => AppState.currentState === "active");
  const lastDispatched = useRef<string | null>(null);
  const lastDispatch = useRef({ threadKey: props.threadKey, at: 0 });
  const canVisit = useEffectEvent(
    () => props.showContent && navigation.isFocused() && AppState.currentState === "active",
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- Catch a native change before subscription.
    setActive(AppState.currentState === "active");
    return () => subscription.remove();
  }, []);
  const {
    environmentId,
    threadId,
    threadKey,
    updatedAt,
    lastVisitedAt,
    completedAt,
    showContent,
    visitThread,
  } = props;
  useEffect(() => {
    if (!showContent || !focused || !active || lastVisitedAt === undefined) return;
    const updatedAtMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedAtMs)) return;
    const visitedAtMs = lastVisitedAt ? Date.parse(lastVisitedAt) : NaN;
    if (!Number.isNaN(visitedAtMs) && visitedAtMs >= updatedAtMs) return;
    const dispatchKey = `${threadKey}:${updatedAt}`;
    if (lastDispatched.current === dispatchKey) return;
    const dispatch = () => {
      // Native navigation / AppState can change before React runs effect cleanup.
      if (!canVisit()) return;
      lastDispatched.current = dispatchKey;
      lastDispatch.current = { threadKey, at: Date.now() };
      void visitThread({ environmentId, input: { threadId, visitedAt: updatedAt } });
    };
    // Completions clear immediately; streaming updates use a trailing throttle.
    const completedAtMs = completedAt ? Date.parse(completedAt) : NaN;
    const unseenCompletion =
      !Number.isNaN(completedAtMs) && (Number.isNaN(visitedAtMs) || completedAtMs > visitedAtMs);
    const previous = lastDispatch.current;
    const elapsed = Date.now() - previous.at;
    if (previous.threadKey !== threadKey || unseenCompletion || elapsed >= 10_000) {
      dispatch();
      return;
    }
    const timer = setTimeout(dispatch, 10_000 - elapsed);
    return () => clearTimeout(timer);
  }, [
    environmentId,
    threadId,
    threadKey,
    updatedAt,
    lastVisitedAt,
    completedAt,
    showContent,
    visitThread,
    focused,
    active,
  ]);
}

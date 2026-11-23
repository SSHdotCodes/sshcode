import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/utils";

export function ChatColumn(props: {
  maximized: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);
  // Inert may blur the chat control before the panel receives focus.
  const lastChatFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasMaximized = useRef(false);
  // The panel can mount in a sibling portal; its ref is ready after the layout effects.
  useEffect(() => {
    if (props.maximized === wasMaximized.current) return;
    wasMaximized.current = props.maximized;
    if (props.maximized) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : lastChatFocusRef.current;
      const panel = props.panelRef.current;
      const tab = panel?.querySelector<HTMLElement>(
        '[data-active-tab="true"] [data-right-panel-activate-tab]',
      );
      (tab ?? panel)?.focus({ preventScroll: true });
    } else {
      const previous = restoreFocusRef.current;
      const target =
        previous?.isConnected && !previous.closest("[inert]") && !previous.matches(":disabled")
          ? previous
          : columnRef.current;
      target?.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    }
  }, [props.maximized, props.panelRef]);
  return (
    <div
      ref={columnRef}
      inert={props.maximized}
      onFocusCapture={(event) => {
        if (!props.maximized && event.target instanceof HTMLElement) {
          lastChatFocusRef.current = event.target;
        }
      }}
      tabIndex={-1}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
        props.maximized ? "w-0 flex-none" : "flex-1",
      )}
      data-chat-column-maximized-away={props.maximized ? "true" : "false"}
    >
      {props.children}
    </div>
  );
}

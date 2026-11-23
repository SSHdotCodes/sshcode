import { createContext, use, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const SplitChatPaneContext = createContext<{
  focused: boolean;
  dock: HTMLElement | null;
  controls: ReactNode;
} | null>(null);

export function useSplitChatPane() {
  return use(SplitChatPaneContext);
}

/** The tool dock stays outside the two chat columns and follows the route. */
export function SplitChatDock({ children }: { children: ReactNode }) {
  const pane = useSplitChatPane();
  if (!pane) return children;
  return pane.focused && pane.dock ? createPortal(children, pane.dock) : null;
}

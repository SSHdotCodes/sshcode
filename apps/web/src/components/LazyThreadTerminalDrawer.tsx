import { AuthTerminalOperateScope } from "@t3tools/contracts";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ComponentProps } from "react";

import { cn } from "../lib/utils";
import { useEnvironmentScope } from "../state/session";

import { Spinner } from "./ui/spinner";

const TerminalDrawer = lazy(() => import("./ThreadTerminalDrawer"));
type Props = ComponentProps<typeof TerminalDrawer>;

function TerminalLoadingShell({ mode, height, threadRef, visible = true, focusRequestId }: Props) {
  const shell = useRef<HTMLElement>(null);
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  useLayoutEffect(() => {
    if (visible && canOperateTerminal) shell.current?.focus({ preventScroll: true });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each focus request must reclaim the pending shell.
  }, [visible, canOperateTerminal, focusRequestId]);
  return (
    <aside
      ref={shell}
      data-thread-terminal-drawer
      data-terminal-owner={mode === "panel" ? "right-panel" : "drawer"}
      tabIndex={-1}
      aria-label="Loading terminal"
      aria-busy="true"
      className={cn(
        "flex min-h-0 min-w-0 shrink-0 items-center justify-center overflow-hidden bg-background",
        mode !== "panel" && "border-t border-border/80",
      )}
      style={
        mode === "panel"
          ? { height: "100%", flex: 1 }
          : { height, minHeight: 180, maxHeight: "75vh" }
      }
      onKeyDown={(event) => {
        // Drop input until the renderer is ready; keep Tab and modified shortcuts available.
        if (event.key !== "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
        }
      }}
      onPaste={(event) => event.preventDefault()}
    >
      <Spinner size="md" tone="muted" />
    </aside>
  );
}

/** Keep dormant chats out of the terminal renderer; retain live sessions once mounted. */
export default function LazyThreadTerminalDrawer(props: Props) {
  const needed = props.visible !== false || props.terminalIds.length > 0;
  const [activated, setActivated] = useState(needed);
  if (needed && !activated) setActivated(true);
  if (!needed && !activated) return null;
  return (
    <Suspense fallback={<TerminalLoadingShell {...props} />}>
      <TerminalDrawer {...props} />
    </Suspense>
  );
}

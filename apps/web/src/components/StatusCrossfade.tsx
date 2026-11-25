import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

/** Keep outgoing ghost mounted slightly past the 120 ms exit fade so it never clips early. */
export const STATUS_CROSSFADE_EXIT_MS = 140;

interface StatusCrossfadeState {
  readonly scopeKey: string | undefined;
  readonly statusKey: string;
  readonly currentSnapshot: ReactNode;
  readonly outgoing: { readonly key: string; readonly content: ReactNode } | null;
  readonly transitionId: number;
}

export interface StatusCrossfadeProps {
  /** Logical status identity. Only live changes to this key crossfade; initial paint never does. */
  readonly statusKey: string;
  /** Owning entity key (e.g. threadId or subagentId). Changing it resets without animating. */
  readonly scopeKey?: string;
  /** Non-interactive snapshot of the current status, held briefly as the outgoing layer on change. */
  readonly snapshot: ReactNode;
  /** Live content rendered for the current status. */
  readonly children: ReactNode;
  /** Alignment of the outgoing layer while fading out. */
  readonly align?: "start" | "end";
  readonly className?: string;
}

/**
 * Crossfades live status label and color changes without animating first paint
 * or entity switches. Outgoing content sits out of flow so layout width never jumps.
 */
export function StatusCrossfade({
  statusKey,
  scopeKey,
  snapshot,
  children,
  align = "start",
  className,
}: StatusCrossfadeProps) {
  const [state, setState] = useState<StatusCrossfadeState>(() => ({
    scopeKey,
    statusKey,
    currentSnapshot: snapshot,
    outgoing: null,
    transitionId: 0,
  }));

  if (state.scopeKey !== scopeKey) {
    setState({
      scopeKey,
      statusKey,
      currentSnapshot: snapshot,
      outgoing: null,
      transitionId: 0,
    });
  } else if (state.statusKey !== statusKey) {
    const nextTransitionId = state.transitionId + 1;
    setState({
      scopeKey,
      statusKey,
      currentSnapshot: snapshot,
      outgoing: {
        key: `${state.statusKey}:${state.transitionId}`,
        content: state.currentSnapshot,
      },
      transitionId: nextTransitionId,
    });
  }

  const outgoingKey = state.outgoing?.key ?? null;
  useEffect(() => {
    if (outgoingKey === null) return;
    const timeout = window.setTimeout(() => {
      setState((current) =>
        current.outgoing?.key === outgoingKey ? { ...current, outgoing: null } : current,
      );
    }, STATUS_CROSSFADE_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [outgoingKey]);

  const animateIn = state.transitionId > 0;

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      {state.outgoing ? (
        <span
          key={state.outgoing.key}
          aria-hidden="true"
          data-status-crossfade-out=""
          className={cn(
            "pointer-events-none absolute inset-y-0 flex items-center whitespace-nowrap status-crossfade-out",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {state.outgoing.content}
        </span>
      ) : null}
      <span
        key={animateIn ? `${statusKey}:${state.transitionId}` : "initial"}
        data-status-crossfade-in={animateIn ? "" : undefined}
        className={cn(
          "inline-flex items-center whitespace-nowrap",
          animateIn && "status-crossfade-in",
        )}
      >
        {children}
      </span>
    </span>
  );
}

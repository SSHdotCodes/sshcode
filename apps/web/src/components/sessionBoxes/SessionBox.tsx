import { usePrivacyMode, usePrivacyLabel } from "~/hooks/usePrivacyMode";
import type { SessionBoxPresentation } from "@t3tools/client-runtime/state/session-boxes";
import { sessionBoxBaseIconId, type SessionBoxIconId } from "@t3tools/shared/sessionBoxes";
import { PinIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { HarnessMascot } from "../HarnessMascot";
import { SESSION_BOX_FALLBACK_ICONS } from "./sessionBoxFallbackIcons";
import { sessionBoxIconUrl } from "./sessionBoxIcons";

/** Painted icons that failed to load this session draw their line fallback instead. */
const missingIcons = new Set<SessionBoxIconId>();

export function PaintedIcon({
  id,
  size,
  className,
}: {
  readonly id: SessionBoxIconId;
  readonly size: number;
  readonly className?: string;
}) {
  const [failedId, setFailedId] = useState<SessionBoxIconId | null>(null);
  if (failedId === id || missingIcons.has(id)) {
    const Fallback = SESSION_BOX_FALLBACK_ICONS[sessionBoxBaseIconId(id)];
    return (
      <span
        aria-hidden
        className={cn("inline-flex items-center justify-center", className)}
        style={{ width: size, height: size }}
      >
        <Fallback className="size-[62%] text-(--box-paint)" strokeWidth={2.2} />
      </span>
    );
  }
  return (
    <img
      aria-hidden
      alt=""
      draggable={false}
      src={sessionBoxIconUrl(id)}
      width={size}
      height={size}
      className={cn("pointer-events-none block object-contain select-none", className)}
      onError={() => {
        missingIcons.add(id);
        setFailedId(id);
      }}
    />
  );
}

/**
 * A chat's painting for the start of a list row: its topic face, which never changes, and
 * a badge with what it is doing now. The same art as the boxes, at a size that reads.
 */
export function SessionBoxPainting({
  box,
  size,
}: {
  readonly box: SessionBoxPresentation;
  readonly identity?: string;
  readonly size: number;
}) {
  return (
    <span
      aria-hidden
      data-tone={box.tone}
      style={{ "--box-hue": box.hue, width: size, height: size } as CSSProperties}
      className="session-box-colors relative shrink-0"
    >
      <PaintedIcon key={box.face} id={box.face} size={size} className="session-box-paint-in" />
      {box.badge !== null ? (
        <span
          key={box.badge}
          data-working={box.tone === "working"}
          className="session-box-badge session-box-paint-in absolute -right-1.5 -bottom-1 inline-flex rounded-full bg-(--box-surface) p-px leading-none shadow-sm ring-1 ring-(--box-edge)"
        >
          <PaintedIcon id={box.badge} size={Math.round(size * 0.5)} />
        </span>
      ) : null}
    </span>
  );
}

/** Whole minutes of work so far ("12m", "1h 5m"); nothing in the first minute. */
export function useElapsed(since: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return null;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return null;
  const minutes = Math.floor(Math.max(0, now - started) / 60_000);
  if (minutes < 1) return null;
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/**
 * One chat as a box. The face (topic painting) and hue never change for a chat, so it
 * stays easy to find; the badge, status line and motion show what happens now.
 */
export function SessionBox({
  box,
  driver,
  agentId,
  isActive,
  isSelected,
  isPinned,
  machineLabel,
  identity,
  size = "sidebar",
  accessory,
}: {
  readonly box: SessionBoxPresentation;
  readonly identity?: string;
  /** Harness driver, for the agent's mascot. */
  readonly driver: string | null;
  readonly agentId?: string | null | undefined;
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly isPinned: boolean;
  /** Where the chat runs, when not on this machine (e.g. "Studio"). */
  readonly machineLabel: string | null;
  readonly size?: "sidebar" | "board";
  /** Extra controls, e.g. a draft marker, shown in the top row. */
  readonly accessory?: ReactNode;
}) {
  const privacy = usePrivacyMode();
  const privateLabel = usePrivacyLabel();
  const elapsed = useElapsed(box.tone === "working" ? box.since : null);
  const board = size === "board";
  const faceSize = board ? 44 : 30;
  return (
    <div className="@container w-full">
      <div
        data-tone={box.tone}
        style={{ "--box-hue": box.hue } as CSSProperties}
        className={cn(
          "session-box relative flex w-full flex-col overflow-hidden rounded-xl border text-left transition-[box-shadow,transform] duration-150",
          board ? "aspect-square p-2.5" : "session-box-shape p-1.5",
          isActive && "ring-2 ring-primary/70 ring-inset",
          !isActive && isSelected && "ring-2 ring-primary/40 ring-inset",
          "group-hover/sidebar-row:-translate-y-px group-hover/sidebar-row:shadow-md",
        )}
      >
        <div className="relative flex items-start justify-between gap-1">
          <span className="relative shrink-0" style={{ width: faceSize, height: faceSize }}>
            <PaintedIcon
              key={box.face}
              id={box.face}
              size={faceSize}
              className="session-box-paint-in"
            />
            {box.badge !== null ? (
              <span
                key={box.badge}
                data-working={box.tone === "working"}
                className={cn(
                  "session-box-badge session-box-paint-in absolute inline-flex rounded-full bg-(--box-surface) p-px leading-none shadow-sm ring-1 ring-(--box-edge)",
                  board ? "-right-2 -bottom-1.5" : "-right-1.5 -bottom-1",
                )}
              >
                <PaintedIcon id={box.badge} size={board ? 22 : 15} />
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              "flex min-w-0",
              board ? "items-center gap-1" : "flex-col items-end gap-0.5",
            )}
          >
            <span className="flex items-center gap-1">
              {accessory}
              {isPinned ? (
                <PinIcon aria-label="Pinned" className="size-3 shrink-0 opacity-60" />
              ) : null}
              {driver ? (
                <HarnessMascot
                  driver={driver}
                  agentId={agentId}
                  size={board ? 22 : 17}
                  state={box.mascot}
                  still={box.mascot === "idle"}
                />
              ) : null}
            </span>
            {!board && machineLabel ? (
              <span className="max-w-full truncate rounded-sm bg-(--box-edge) px-1 text-4xs leading-3.25 font-semibold tracking-wide uppercase opacity-80">
                {privateLabel("Computer", machineLabel, machineLabel)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="relative mt-auto min-w-0">
          <div
            className={cn(
              "leading-tight font-semibold tracking-tight break-words",
              box.now ? "line-clamp-1" : "line-clamp-2",
              board ? "text-sm" : "text-xs",
            )}
          >
            {privateLabel("Chat", identity ?? box.label, box.label)}
          </div>
          {box.now && !privacy ? (
            <div
              className={cn("truncate leading-tight opacity-65", board ? "text-xs" : "text-3xs")}
            >
              ↳ {box.now}
            </div>
          ) : null}
          <div
            className={cn(
              "mt-0.5 flex min-w-0 items-center gap-1 opacity-70",
              board ? "text-xs" : "text-3xs leading-tight",
              box.tone === "asking" && "font-medium text-(--box-asking-ink) opacity-100",
              box.tone === "failed" && "font-medium text-(--box-failed-ink) opacity-100",
            )}
          >
            <span className="truncate">{board ? box.status : box.statusShort}</span>
            {elapsed ? <span className="shrink-0 tabular-nums opacity-80">{elapsed}</span> : null}
            {box.tone === "unread" ? (
              <span
                role="img"
                aria-label="Unread"
                className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </div>
          {board && machineLabel ? (
            <div className="truncate text-2xs opacity-55">
              {privateLabel("Computer", machineLabel, machineLabel)}
            </div>
          ) : null}
        </div>
        {box.tone === "working" ? (
          <span aria-hidden className="session-box-paintline absolute inset-x-2 bottom-0 h-1.5" />
        ) : null}
      </div>
    </div>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  LIMIT_TONE_COLOR,
  limitTone,
  planRunsFromThreads,
  planUse,
  resetsInShort,
  statusRowRings,
  statusRowVisibleRings,
  summarizeProviderLimits,
  type StatusRing,
} from "@t3tools/client-runtime/limits-glance";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  isUsageWindowAlmostOut,
  recentUseBySource,
  usedPercentLabel,
  limitPoolIconUrl,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { focusUsageLimitsPlan } from "../usage/usageLimitsFocus";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

/** The most rings the dock draws; a narrow sidebar draws fewer. */
const RING_LIMIT = 8;
/** One ring's button, the same square as the footer's icons below it. */
const RING_SLOT = 32;
const RING_SIZE = 20;
const RING_STROKE = 2.25;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Kept clear at the row's end for the bell and its count. */
const TRAILING_WIDTH = 48;

const ringName = (ring: StatusRing) =>
  ring.label ?? PROVIDER_DISPLAY_NAMES[ring.limits.driver] ?? String(ring.limits.driver);

function LimitRing({ ring, now, onOpen }: { ring: StatusRing; now: number; onOpen: () => void }) {
  const { tightest, driver, pool, windows } = ring.limits;
  // Only older readings behind it: drawn quieter, as on the phone.
  const older =
    pool.accounts.length > 0 &&
    pool.accounts.every((account) => account.asOf !== undefined && !account.limits.refreshing);
  const used = Math.min(
    isUsageWindowAlmostOut(tightest) ? 99 : 100,
    Math.max(0, tightest.usedPercent),
  );
  const name = ringName(ring);
  const describe = (window: (typeof windows)[number]) => {
    const resets = resetsInShort(window, now);
    return `${window.label} ${usedPercentLabel(window)}${resets ? ` · resets in ${resets}` : ""}`;
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${name}: ${describe(tightest)}. Open limits.`}
            onClick={onOpen}
            className="group/ring relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) outline-hidden ring-ring transition-[background-color,scale] duration-100 ease-out hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <svg
              aria-hidden
              width={RING_SIZE}
              height={RING_SIZE}
              viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
              className={cn("-rotate-90", older && "opacity-45")}
            >
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={RING_STROKE}
                className="stroke-sidebar-foreground/12"
              />
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={LIMIT_TONE_COLOR[limitTone(used)]}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={`${(used / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
              />
            </svg>
            <span
              className={cn(
                "absolute inset-0 flex items-center justify-center",
                older && "opacity-45",
              )}
            >
              <ProviderInstanceIcon
                driverKind={driver}
                displayName={name}
                acpRegistryIconUrl={limitPoolIconUrl(pool)}
                className="size-2.5"
                iconClassName="size-2.5"
              />
            </span>
          </button>
        }
      />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-medium">{name}</span>
          {windows.map((window) => (
            <span key={`${window.kind}:${window.id}`} className="tabular-nums opacity-80">
              {describe(window)}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The row above the sidebar's footer: a ring per subscription plan, as on the phone's
 * status row, and the count of chats waiting for the user.
 */
export const SidebarStatusDock = memo(function SidebarStatusDock(props: {
  readonly needsYouCount: number;
  readonly needsYouActive: boolean;
  readonly onToggleNeedsYou: () => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const threads = useThreadShells();
  const now = useNowMinuteMs();
  const recentUse = useMemo(() => recentUseBySource(presentations), [presentations]);
  // Plans whose account hides its ring stay out; a plan that reports no limits has no ring.
  const rings = useMemo(
    () =>
      statusRowRings(
        summarizeProviderLimits(
          collectLimitPools(collectLimitAccounts(presentations), now, recentUse),
        ),
        undefined,
        undefined,
      ),
    [now, presentations, recentUse],
  );
  const [room, setRoom] = useState(RING_LIMIT);
  const observeRoom = useCallback(
    (row: HTMLDivElement) =>
      observeResize(row, ([entry]) => {
        if (!entry) return;
        const width = entry.contentRect.width - TRAILING_WIDTH;
        setRoom(Math.max(1, Math.min(RING_LIMIT, Math.floor(width / RING_SLOT))));
      }),
    [],
  );
  const visible = useMemo(
    () =>
      statusRowVisibleRings(
        rings,
        planUse(planRunsFromThreads(threads), now, recentUse),
        // The count of the rest takes a ring's place.
        rings.length > room ? Math.max(1, room - 1) : room,
      ),
    [now, recentUse, rings, room, threads],
  );
  const openUsage = useCallback(
    (plan: string | null) => {
      if (isMobile) setOpenMobile(false);
      saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
      if (plan !== null) focusUsageLimitsPlan(plan);
      void navigate({ to: "/usage" });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const { needsYouCount } = props;
  const needsYouLabel =
    needsYouCount === 0
      ? "Nothing needs you"
      : `${needsYouCount} ${needsYouCount === 1 ? "chat needs" : "chats need"} you`;

  return (
    <div
      ref={observeRoom}
      data-sidebar="status-dock"
      className="flex h-9 shrink-0 items-center px-(--sidebar-content-inset)"
    >
      <div className="flex min-w-0 flex-1 items-center">
        {visible.shown.map((ring) => (
          <LimitRing
            key={ring.key}
            ring={ring}
            now={now}
            // A provider's plans drawn as one ring open on the first of them.
            onOpen={() => openUsage(ring.limits.pool.key)}
          />
        ))}
        {visible.more > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`${visible.more} more ${visible.more === 1 ? "plan" : "plans"}. Open limits.`}
                  onClick={() => openUsage(null)}
                  className="flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) px-1.5 text-xs font-medium text-sidebar-muted-foreground/80 tabular-nums outline-hidden ring-ring transition-colors duration-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset motion-reduce:transition-none"
                >
                  +{visible.more}
                </button>
              }
            />
            <TooltipPopup side="top">
              {visible.more} more {visible.more === 1 ? "plan" : "plans"} on Usage
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={needsYouLabel}
              aria-pressed={props.needsYouActive}
              onClick={props.onToggleNeedsYou}
              className={cn(
                "flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-(--control-radius) px-2 text-xs font-medium tabular-nums outline-hidden ring-ring transition-[background-color,color,scale] duration-100 ease-out hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100",
                needsYouCount > 0
                  ? "text-warning-foreground"
                  : "text-sidebar-muted-foreground/80 hover:text-sidebar-foreground",
                props.needsYouActive && "bg-sidebar-row-selected",
              )}
            >
              <BellIcon aria-hidden className="size-4 shrink-0" />
              {needsYouCount > 0 ? <span>{needsYouCount}</span> : null}
            </button>
          }
        />
        <TooltipPopup side="top">
          {props.needsYouActive ? "Show all chats" : needsYouLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

import type { OrchestrationV2LiveProgress } from "@t3tools/contracts";
import {
  type LiveProgressCard as LiveProgressCardModel,
  type LiveProgressCardStage,
  liveProgressCard,
} from "@t3tools/shared/liveProgress";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One shared 15-second clock for time-left labels: minutes are the finest unit they show. It ticks
 * only while a progress card is mounted, and only those cards re-render.
 */
const TICK_MS = 15_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const entry of listeners) entry();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idleSubscribe = () => () => {};
const readNow = () => now;

/** The card's model at the shared clock's time. */
export function useLiveProgressCard(
  progress: OrchestrationV2LiveProgress | undefined,
): LiveProgressCardModel | null {
  const nowMs = useSyncExternalStore(
    progress === undefined ? idleSubscribe : subscribe,
    readNow,
    readNow,
  );
  return progress === undefined
    ? null
    : liveProgressCard(progress, Math.max(nowMs, progress.reportedAt));
}

/** Thin rounded bar; without an estimate a soft segment sweeps it instead of a made-up width. */
export function LiveProgressBar(props: {
  readonly fraction: number | null;
  readonly label: string;
  readonly size?: "card" | "mini";
  readonly className?: string;
}) {
  const percent = props.fraction === null ? null : Math.round(props.fraction * 100);
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn(
        "relative overflow-hidden rounded-full bg-foreground/8",
        props.size === "mini" ? "h-0.75" : "h-1",
        props.className,
      )}
    >
      {percent === null ? (
        <div
          ref={observeVisibleAnimation}
          className="live-progress-sweep absolute inset-y-0 left-0 rounded-full"
        />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      )}
    </div>
  );
}

/** A time with its expected finish on hover. */
function TimeWithFinish(props: {
  readonly children: ReactNode;
  readonly finish: string | null;
  readonly className?: string;
}) {
  if (props.finish === null) return <span className={props.className}>{props.children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={<span tabIndex={0} className={cn("cursor-default", props.className)} />}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.finish}</TooltipPopup>
    </Tooltip>
  );
}

function StageMark({ status }: { status: LiveProgressCardStage["status"] }) {
  if (status === "done") return <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />;
  return (
    <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-primary" : "border border-muted-foreground/45",
        )}
      />
    </span>
  );
}

function StageRow({ stage }: { stage: LiveProgressCardStage }) {
  return (
    <li
      data-stage-status={stage.status}
      className="flex min-w-0 items-center gap-2 text-2xs leading-5"
    >
      <StageMark status={stage.status} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          stage.status === "active"
            ? "font-medium text-foreground"
            : stage.status === "done"
              ? "text-muted-foreground"
              : "text-muted-foreground/80",
        )}
      >
        {stage.title}
      </span>
      {stage.status === "active" && stage.fraction !== null ? (
        <LiveProgressBar
          fraction={stage.fraction}
          label={`${stage.title} progress`}
          size="mini"
          className="w-12 shrink-0"
        />
      ) : null}
      {stage.label ? (
        <TimeWithFinish
          finish={stage.finishLabel}
          className="shrink-0 text-muted-foreground/85 tabular-nums"
        >
          {stage.label}
        </TimeWithFinish>
      ) : null}
    </li>
  );
}

/**
 * The lead's card above the composer: what it is on and the time left, the bar, its stages
 * around the current one (all of them on request), then its newest updates.
 */
export function LiveProgressPanel(props: {
  readonly progress: OrchestrationV2LiveProgress;
  /** Shown when the agent sent updates but no stages. */
  readonly fallbackTitle: string;
}) {
  const card = useLiveProgressCard(props.progress);
  const [expanded, setExpanded] = useState(false);
  if (card === null) return null;
  const [start, end] = card.collapsedRange;
  const hidden = card.stages.length - (end - start);
  const shown = expanded ? card.stages : card.stages.slice(start, end);
  const title = card.title ?? props.fallbackTitle;
  return (
    <section
      data-live-progress={props.progress.source}
      aria-label="Live progress"
      className="space-y-1.5 px-1.5 pt-0.5 pb-1"
    >
      <div className="flex min-w-0 items-baseline gap-2 text-xs leading-5">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {card.timeLeft ? (
          <TimeWithFinish
            finish={card.finishLabel}
            className="shrink-0 text-muted-foreground tabular-nums"
          >
            {card.timeLeft}
          </TimeWithFinish>
        ) : null}
      </div>
      <LiveProgressBar fraction={card.fraction} label={`${title} progress`} />
      {card.stages.length > 0 ? (
        <div className="min-w-0">
          <ol className="min-w-0">
            {shown.map((stage, index) => (
              <StageRow key={`${expanded ? index : start + index}:${stage.title}`} stage={stage} />
            ))}
          </ol>
          {hidden > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              className="-ms-0.5 flex h-5 items-center gap-1.5 rounded-md ps-0.5 pe-1.5 text-2xs text-muted-foreground/85 transition-colors duration-120 ease-out hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 motion-reduce:transition-none"
            >
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-3 transition-transform duration-150 ease-out motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
              {expanded ? "Fewer stages" : `All ${card.stages.length} stages`}
            </button>
          ) : null}
        </div>
      ) : null}
      {card.updates.length > 0 ? (
        <ul aria-label="Updates" className="space-y-0.5 border-t border-border/55 pt-1.5">
          {card.updates.map((update, index) => (
            <li key={update.at} className="flex min-w-0 items-baseline gap-2 text-2xs leading-4">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  index === 0 ? "text-foreground/90" : "text-muted-foreground",
                )}
              >
                {update.text}
              </span>
              <span className="shrink-0 text-muted-foreground/70 tabular-nums">{update.age}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Inside a subagent's card: the bar, time left and its latest update on one line. */
export function LiveProgressCompact(props: { readonly progress: OrchestrationV2LiveProgress }) {
  const card = useLiveProgressCard(props.progress);
  if (card === null) return null;
  return (
    <span data-live-progress-compact="" className="block space-y-1 pt-1">
      <span className="flex min-w-0 items-center gap-2">
        <LiveProgressBar
          fraction={card.fraction}
          label={`${card.title ?? "Subagent"} progress`}
          size="mini"
          className="min-w-0 flex-1"
        />
        {card.compactTimeLeft ? (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {card.compactTimeLeft}
          </span>
        ) : null}
      </span>
      {card.latestUpdate ? (
        <span className="block truncate text-2xs leading-snug text-muted-foreground/90">
          {card.latestUpdate}
        </span>
      ) : null}
    </span>
  );
}

/** "~8 min left" for the working row, when there is an estimate. */
export function useLiveProgressTimeLeft(
  progress: OrchestrationV2LiveProgress | undefined,
): { readonly text: string; readonly finish: string | null } | null {
  const card = useLiveProgressCard(progress);
  return card?.compactTimeLeft ? { text: card.compactTimeLeft, finish: card.finishLabel } : null;
}

export { TimeWithFinish as LiveProgressTimeWithFinish };

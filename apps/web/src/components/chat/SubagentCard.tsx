import type { ReactNode } from "react";
import type {
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { SubagentSpeed } from "@t3tools/client-runtime/state/subagent-display";
import { BotIcon, ChevronRightIcon, ZapIcon } from "lucide-react";
import { UltrafastIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { StatusCrossfade } from "../StatusCrossfade";

const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; textClass: string; label: string; pulse?: boolean }
> = {
  pending: { dotClass: "bg-info", textClass: "text-info-foreground", label: "Queued", pulse: true },
  running: {
    dotClass: "bg-info",
    textClass: "text-info-foreground",
    label: "Running",
    pulse: true,
  },
  waiting: { dotClass: "bg-info", textClass: "text-info-foreground", label: "Waiting" },
  idle: {
    dotClass: "bg-muted-foreground/50",
    textClass: "text-muted-foreground",
    label: "Idle · resumable",
  },
  completed: {
    dotClass: "bg-success",
    textClass: "text-success-foreground",
    label: "Completed",
  },
  failed: { dotClass: "bg-destructive", textClass: "text-destructive", label: "Failed" },
  cancelled: {
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
    label: "Stopped",
  },
  interrupted: {
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
    label: "Stopped",
  },
};

export function subagentStatusVisual(status: OrchestrationV2TurnItem["status"]) {
  return STATUS_VISUALS[status];
}

/** One line of a markdown result: drop list bullets, code ticks, and link targets. */
export function plainDetail(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Round provider tile with the agents panel's status dot; rings let a header stack overlap. */
export function SubagentAvatar({
  driver,
  provider,
  status,
  speed,
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  /** Omitted inside an overlapped stack, where a covered dot would only add noise. */
  status?: OrchestrationV2TurnItem["status"] | undefined;
  /** Started at Fast or Ultrafast: the composer's own speed mark sits on the corner. */
  speed?: SubagentSpeed | null | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background",
        className,
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
          className="z-auto"
          iconClassName="size-3.5"
        />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background transition-colors duration-160 ease-motion motion-reduce:transition-none",
            subagentStatusVisual(status).dotClass,
            subagentStatusVisual(status).pulse && "motion-safe:animate-status-pulse",
          )}
        />
      ) : null}
      {speed ? (
        <span
          data-subagent-speed={speed}
          className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-background text-foreground ring-1 ring-border/70"
        >
          {speed === "ultrafast" ? (
            <UltrafastIcon className="size-2.5" />
          ) : (
            <ZapIcon className="size-2 fill-current" />
          )}
        </span>
      ) : null}
    </span>
  );
}

/** The same transcript card for delegated work and independent created chats. */
export function SubagentCard(props: {
  readonly title: string;
  readonly status: OrchestrationV2TurnItem["status"] | null;
  readonly statusLabel: string;
  readonly detail: string | null;
  readonly preview?: string | null;
  readonly driver?: ProviderDriverKind | undefined;
  readonly provider: ServerProvider | undefined;
  readonly modelLabel: string;
  readonly speed?: SubagentSpeed | null | undefined;
  readonly elapsed: ReactNode;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly itemType: "subagent" | "thread_created";
  readonly children?: ReactNode;
}) {
  const failed = props.status === "failed";
  const statusTextClass = props.status
    ? subagentStatusVisual(props.status).textClass
    : "text-muted-foreground";
  const content = (
    <>
      <SubagentAvatar
        driver={props.driver}
        provider={props.provider}
        status={props.status ?? undefined}
        speed={props.speed}
        className="size-7"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        {/* The time shares the title's line and the status sits with the model:
            beside a cut-off title the status read as part of the time. */}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium leading-snug text-foreground">
            {props.title}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground/85 tabular-nums">
            {props.elapsed}
          </span>
        </span>
        <span className="flex items-baseline gap-1 text-2xs text-muted-foreground">
          <StatusCrossfade
            scopeKey={props.threadId ?? props.title}
            statusKey={`${props.status ?? "none"}:${props.statusLabel}`}
            snapshot={
              <span className={cn("shrink-0 font-medium", statusTextClass)}>
                {props.statusLabel}
              </span>
            }
            className="shrink-0"
          >
            <span className={cn("shrink-0 font-medium", statusTextClass)}>{props.statusLabel}</span>
          </StatusCrossfade>
          <span aria-hidden className="shrink-0 text-muted-foreground/60">
            ·
          </span>
          <span className="min-w-0 truncate">
            {props.itemType === "thread_created" ? "Chat · " : ""}
            {props.modelLabel}
          </span>
        </span>
        {props.detail ? (
          <span
            className={cn(
              "block truncate text-2xs leading-snug transition-colors duration-160 ease-motion motion-reduce:transition-none",
              failed ? "text-destructive" : "text-muted-foreground/90",
            )}
          >
            {props.detail.includes("/") && !props.detail.includes(" ") ? (
              <MiddleTruncate value={props.detail} showTitle={false} className="flex" />
            ) : (
              props.detail
            )}
          </span>
        ) : null}
        {props.preview ? (
          <span className="block truncate text-2xs leading-snug text-muted-foreground/85">
            {plainDetail(props.preview)}
          </span>
        ) : null}
      </span>
      {props.threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/55 transition-[color,transform] duration-150 ease-out motion-reduce:transition-none group-hover/subagent:translate-x-0.5 group-hover/subagent:text-foreground motion-reduce:group-hover/subagent:translate-x-0"
        />
      ) : null}
    </>
  );
  const className =
    "group/subagent my-1 flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/55 bg-card/50 px-3 py-2.5 text-left shadow-2xs/10 dark:inset-shadow-card-highlight";
  const target =
    props.threadId === null ? (
      <div
        data-v2-item-type={props.itemType}
        aria-description={props.statusLabel}
        className={className}
      >
        {content}
      </div>
    ) : (
      <button
        type="button"
        data-v2-item-type={props.itemType}
        aria-label={`Open ${props.title}`}
        aria-description={props.statusLabel}
        onClick={() => props.onOpenThread(props.threadId!)}
        className={cn(
          className,
          "cursor-pointer transition-[background-color,border-color,scale] duration-120 ease-out motion-reduce:transition-none hover:border-border/90 hover:bg-accent/35 active:scale-[0.995] active:bg-accent/50 motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
      >
        {content}
      </button>
    );
  return props.children ? (
    <Tooltip>
      <TooltipTrigger delay={200} render={target} />
      <ThreadHoverCardPopup>{props.children}</ThreadHoverCardPopup>
    </Tooltip>
  ) : (
    target
  );
}

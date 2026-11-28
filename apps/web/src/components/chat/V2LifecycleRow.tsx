import {
  IMAGE_GENERATOR_NATIVE_TYPE,
  ImageGenerationCard,
  ResearchCard,
  SubagentCard,
  subagentStatusVisual,
  plainDetail,
} from "./SubagentCard";
export { SubagentAvatar } from "./SubagentCard";
import { notificationSubagent } from "@t3tools/client-runtime/state/thread-execution";
import { SubagentGradeBadge } from "./SubagentGradeBadge";
import { AgentElapsed } from "./AgentElapsed";
import {
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { FirstSubagentAsk } from "./FirstSubagentAsk";
import { subagentBackgroundWaitLabel } from "@t3tools/shared/chatControls";
import type { ReactNode } from "react";
import { useLinkedThreadShell, useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails, createdChatShellAtom } from "../../state/threads";
import * as DateTime from "effect/DateTime";
import {
  resolveHandoffEndpoints,
  type HandoffEndpoints,
  type HandoffTimelineRun,
  resolveModelSwitchChange,
} from "@t3tools/client-runtime/handoff";
import {
  createdChatPresentation,
  resolveSubagentMetadata,
  subagentSeenLine,
  formatSubagentDisplayTitle,
  subagentCardDetail,
  SUBAGENT_SPEED_LABELS,
  subagentSpeed,
  isResearchSubagent,
  researchReportPreview,
  researchSources,
} from "@t3tools/client-runtime/state/subagent-display";
import { useOpenLink } from "../../browser/useOpenLink";
import {
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2HandoffBriefSource,
  type OrchestrationV2ModelSwitch,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type EnvironmentId,
  type NodeId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ArrowRightLeftIcon, ArrowRightIcon, GitForkIcon, MinusIcon, XIcon } from "lucide-react";

import { getExplicitModelEffortLabel, resolveSelectableModel } from "@t3tools/shared/model";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { HandoffBriefMenu } from "./HandoffBriefMenu";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

export type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Pictures a painting subagent made: the final one large, earlier tries small. */
  readonly renderSubagentImages?: (paths: ReadonlyArray<string>) => ReactNode;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-3xs text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    const label =
      item.status === "failed"
        ? "Context compaction failed"
        : item.status === "cancelled" || item.status === "interrupted"
          ? "Context compaction stopped"
          : item.status === "pending" || item.status === "running" || item.status === "waiting"
            ? "Compacting context"
            : "Context compacted";
    return (
      <TimelineSystemDivider label={label} detail={item.summary ?? tokenDetail} icon={MinusIcon} />
    );
  }
  if (item.type === "handoff") {
    return (
      <HandoffRow
        endpoints={resolveHandoffEndpoints(item, props.runs)}
        providers={props.providerStatuses}
        failed={item.status === "failed"}
        brief={item.brief}
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    return (
      <CreatedChatTimelineLink
        item={item}
        environmentId={props.environmentId}
        providers={props.providerStatuses}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentTimelineLink
        parentRef={scopeThreadRef(props.environmentId, item.threadId)}
        subagentId={item.subagentId}
        providerInstanceId={item.providerInstanceId}
        origin={item.origin}
        status={item.status}
        driver={item.driver}
        provider={props.providerStatuses.find(
          (provider) => provider.instanceId === item.providerInstanceId,
        )}
        providers={props.providerStatuses}
        title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
        result={item.result}
        progress={item.progress}
        startedAt={item.startedAt}
        completedAt={item.completedAt}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
        renderImages={props.renderSubagentImages}
      />
    );
  }
  return null;
}

/**
 * In-flight states all present as Working, the way the agents fleet view did:
 * detail belongs in the activity line, and a waiting or queued subagent is
 * still the fleet doing its job. Only settled states differentiate. Idle reads
 * as settled rather than in progress, since a resting child looks done unless
 * resumed.
 */
const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

/** The status a notification reported, frozen at the time it arrived. */
const NOTIFICATION_OUTCOME_STATUS: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  updated: "Updated",
  unknown: "Finished",
};

/** A notification about one subagent, drawn as that subagent's card. Renders `fallback` when the parent has no record of it. */
export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
  readonly source: OrchestrationV2Notification["source"];
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => notificationSubagent(thread?.projection.subagents ?? [], props.source) ?? null,
  );
  if (agent === null) return props.fallback;
  return (
    <SubagentTimelineLink
      parentRef={props.parentRef}
      subagentId={agent.id}
      providerInstanceId={agent.providerInstanceId}
      origin={agent.origin}
      status={agent.status}
      driver={agent.driver}
      provider={props.providerStatuses.find(
        (provider) => provider.instanceId === agent.providerInstanceId,
      )}
      providers={props.providerStatuses}
      title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
      result={agent.result}
      progress={agent.progress}
      startedAt={agent.startedAt}
      completedAt={agent.completedAt}
      threadId={props.childThreadId}
      onOpenThread={props.onOpenThread}
      event={{
        status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
        label: NOTIFICATION_OUTCOME_LABEL[props.outcome],
        timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
      }}
    />
  );
}

function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly title: string;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly renderImages?: ((paths: ReadonlyArray<string>) => ReactNode) | undefined;
  /** Draws a past event about the subagent: its status then, and when it happened instead of elapsed time. */
  readonly event?: {
    readonly status: OrchestrationV2TurnItem["status"] | null;
    readonly label: string;
    readonly timestamp: string;
  };
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const threadId = props.threadId;
  const openLink = useOpenLink(props.parentRef);
  const liveStatus = agent?.status ?? props.status;
  const status = props.event ? props.event.status : liveStatus;
  // A subagent whose turn ended with jobs still out reads as plain "Running"
  // otherwise, which looks like a result that never arrived. Its live progress
  // (token use High) also rides on its chat's shell.
  const childShell = useThreadShell(
    threadId && props.event === undefined && isActiveSubagentStatus(liveStatus)
      ? scopeThreadRef(props.parentRef.environmentId, threadId)
      : null,
  );
  const liveProgress = childShell?.source.liveProgress;
  const waitingLabel =
    childShell === null || liveStatus !== "running"
      ? null
      : subagentBackgroundWaitLabel({
          runtimeStatus: childShell.runtime?.status ?? null,
          longRunningWork: childShell.longRunningWork,
        });
  const statusLabel = props.event?.label ?? waitingLabel ?? subagentStatusVisual(liveStatus).label;
  // A running subagent leading its own subagents says so; otherwise they show only in its chat.
  const nestedRunning =
    props.event || waitingLabel !== null || liveStatus !== "running"
      ? 0
      : (childShell?.longRunningWork?.runningSubagentCount ?? 0);
  const nestedLabel =
    nestedRunning > 0 ? `${nestedRunning} ${nestedRunning === 1 ? "subagent" : "subagents"}` : null;
  const result = (agent?.result ?? props.result)?.trim();
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status ?? liveStatus);
  const rawDetail = settled ? result || progress : progress || result;
  const detail = subagentCardDetail(rawDetail);
  const timing = {
    status: liveStatus,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const { modelLabel } = resolveSubagentMetadata({
    model: agent?.model ?? null,
    modelOptions: agent?.modelSelection?.options,
    provider: props.provider,
  });
  const speed = subagentSpeed(agent?.modelSelection);
  if (props.event === undefined && agent?.nativeType === IMAGE_GENERATOR_NATIVE_TYPE) {
    const imagePaths = agent.imagePaths ?? [];
    return (
      <ImageGenerationCard
        title={props.title}
        status={liveStatus}
        imageCount={imagePaths.length}
        elapsed={<SubagentElapsed agent={timing} />}
        threadId={threadId}
        onOpenThread={props.onOpenThread}
        images={imagePaths.length > 0 ? props.renderImages?.(imagePaths) : null}
      />
    );
  }
  const trailing = (
    <>
      <SubagentGradeBadge
        environmentId={props.parentRef.environmentId}
        taskId={props.subagentId}
        origin={agent?.origin ?? props.origin}
        status={liveStatus}
      />
      {props.event === undefined &&
      agent?.origin === "app_owned" &&
      isActiveSubagentStatus(agent.status) ? (
        <FirstSubagentAsk parentRef={props.parentRef} agent={agent} />
      ) : null}
    </>
  );
  if (props.event === undefined && agent !== null && isResearchSubagent(agent)) {
    const done = SETTLED_SUBAGENT_STATUSES.has(liveStatus);
    const report = done && liveStatus !== "failed" ? (result ?? null) : null;
    return (
      <div className="flex min-w-0 items-center">
        <div className="min-w-0 flex-1">
          <ResearchCard
            title={props.title}
            status={liveStatus}
            statusLabel={
              waitingLabel ??
              (!done
                ? "Researching…"
                : liveStatus === "completed"
                  ? "Research done"
                  : subagentStatusVisual(liveStatus).label)
            }
            modelLabel={[
              agent.model?.trim() ? modelLabel : null,
              speed ? SUBAGENT_SPEED_LABELS[speed] : null,
              nestedLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
            elapsed={<SubagentElapsed agent={timing} />}
            threadId={threadId}
            onOpenThread={props.onOpenThread}
            progress={done ? null : subagentCardDetail(progress)}
            preview={researchReportPreview(report)}
            failure={liveStatus === "failed" ? subagentCardDetail(result || progress) : null}
            sources={researchSources(report)}
            onOpenSource={(url, event) => {
              event.preventDefault();
              void openLink(url, { event }).catch((error: unknown) => console.error(error));
            }}
          />
        </div>
        {trailing}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center">
      <div className="min-w-0 flex-1">
        <SubagentCard
          title={props.title}
          status={status}
          statusLabel={statusLabel}
          detail={detail}
          driver={props.driver}
          provider={props.provider}
          modelLabel={
            // A past event keeps its own moment; only the live card reads what the app saw.
            [
              // An unknown model says nothing; "Not reported" read as the subagent not reporting.
              agent?.model?.trim() ? modelLabel : null,
              speed ? SUBAGENT_SPEED_LABELS[speed] : null,
              props.event || agent === null ? null : subagentSeenLine(agent),
              nestedLabel,
            ]
              .filter(Boolean)
              .join(" · ")
          }
          speed={speed}
          elapsed={props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
          threadId={threadId}
          onOpenThread={props.onOpenThread}
          itemType="subagent"
          liveProgress={liveProgress}
        >
          <SubagentTimelineTooltip
            {...props}
            elapsed={
              agent ? <AgentElapsed agent={projectedSubagentsToRuntime([agent])[0]!} /> : null
            }
            model={agent?.model ?? null}
            modelSelection={agent?.modelSelection}
            status={liveStatus}
            result={agent?.result ?? props.result}
            progress={agent?.progress ?? props.progress}
          />
        </SubagentCard>
      </div>
      {trailing}
    </div>
  );
}

export function CreatedChatTimelineLink(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "thread_created" }>;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const shell = useAtomValue(
    createdChatShellAtom(scopeThreadRef(props.environmentId, props.item.targetThreadId)),
  );
  const chat = createdChatPresentation(props.item, shell);
  const provider = props.providers.find(
    (candidate) => candidate.instanceId === chat.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({ model: chat.model, provider });
  const modelSlug = provider
    ? resolveSelectableModel(provider.driver, chat.model, provider.models)
    : chat.model;
  const providerModel = provider?.models.find((candidate) => candidate.slug === modelSlug);
  const effort = getExplicitModelEffortLabel(shell?.modelSelection, providerModel?.capabilities);
  const speed = subagentSpeed(shell?.modelSelection);
  return (
    <SubagentCard
      title={chat.title}
      status={chat.status}
      statusLabel={chat.statusLabel}
      detail={chat.detail ? plainDetail(chat.detail) : null}
      preview={chat.preview}
      driver={provider?.driver}
      provider={provider}
      modelLabel={[
        chat.model?.trim() ? modelLabel : null,
        effort ?? null,
        speed ? SUBAGENT_SPEED_LABELS[speed] : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      speed={speed}
      elapsed={
        <SubagentElapsed
          agent={{
            status: chat.status,
            startedAt: isoOrNull(chat.startedAt),
            completedAt: isoOrNull(chat.completedAt),
          }}
        />
      }
      threadId={chat.canOpenThread ? props.item.targetThreadId : null}
      onOpenThread={props.onOpenThread}
      itemType="thread_created"
    >
      <SubagentTooltipContent
        title={chat.title}
        model={chat.model}
        providerInstanceId={chat.providerInstanceId}
        origin="app_owned"
        modelSelection={shell?.modelSelection}
        childThread={shell ?? undefined}
        provider={provider}
        providers={props.providers}
        status={chat.status}
        result={chat.detail}
        progress={chat.detail ?? undefined}
      />
    </SubagentCard>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & {
    model: string | null;
    modelSelection: OrchestrationV2Subagent["modelSelection"];
    elapsed: ReactNode;
  },
) {
  const environmentId = props.parentRef.environmentId;
  const parent = useThreadShell(props.parentRef)?.source;
  const child = useLinkedThreadShell(
    props.threadId ? scopeThreadRef(environmentId, props.threadId) : null,
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  return (
    <SubagentTooltipContent
      title={formatSubagentDisplayTitle(child?.title ?? props.title)}
      model={props.model}
      providerInstanceId={props.providerInstanceId}
      origin={props.origin}
      modelSelection={props.modelSelection}
      provider={props.provider}
      providers={props.providers}
      driver={props.driver}
      elapsed={props.elapsed}
      status={props.status}
      result={props.result}
      progress={props.progress}
      parentThread={parent}
      childThread={child}
      parentProject={parentProject ?? undefined}
      childProject={childProject ?? undefined}
    />
  );
}

/** A same-harness model or effort change. Shows only what changed. */
export function ModelSwitchRow(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSwitch: OrchestrationV2ModelSwitch;
}) {
  const { providers } = props;
  const change = resolveModelSwitchChange(props.modelSwitch, providers);
  if (change === null) return null;
  const describe = (selection: ModelSelection, effort: string | undefined) => {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === selection.model);
    const modelName = model ? getTriggerDisplayModelName(model) : selection.model;
    return [change.modelChanged ? modelName : null, effort].filter(Boolean).join(" ");
  };
  const { from, to } = props.modelSwitch;
  return (
    <TimelineSystemDivider
      label={`${describe(from, change.effort?.from)} → ${describe(to, change.effort?.to)}`}
    />
  );
}

export function HandoffRow(props: {
  readonly endpoints: HandoffEndpoints;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly pending?: boolean;
  readonly failed?: boolean;
  /** Who wrote the brief that came along, once delivered. */
  readonly brief?: OrchestrationV2HandoffBriefSource | undefined;
  /** A pending handoff names its brief writer here and lets it change before the send. */
  readonly briefEnvironmentId?: EnvironmentId | undefined;
}) {
  const { from: fromEndpoints, to } = props.endpoints;
  const leaving = fromEndpoints.at(-1);
  return (
    <TimelineSystemDivider
      label={props.pending ? "Context handoff pending" : "Context handoff"}
      icon={ArrowRightLeftIcon}
      showDetailSeparator={false}
      tone={props.failed ? "danger" : "neutral"}
      detail={
        <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
          {fromEndpoints.map((endpoint, index) => (
            <span
              key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
              className="inline-flex min-w-0 items-center"
            >
              <HandoffEndpoint
                providers={props.providers}
                instanceId={endpoint.instanceId}
                model={endpoint.model}
              />
              {index < fromEndpoints.length - 1 ? (
                <span aria-hidden="true" className="ml-0.5">
                  ,
                </span>
              ) : null}
            </span>
          ))}
          {fromEndpoints.length > 0 ? (
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <HandoffEndpoint
            providers={props.providers}
            instanceId={to.instanceId}
            model={to.model}
          />
          {props.pending && props.briefEnvironmentId !== undefined && leaving !== undefined ? (
            <HandoffBriefMenu
              environmentId={props.briefEnvironmentId}
              providers={props.providers}
              leaving={leaving}
              modelLabel={(instanceId, model) =>
                handoffModelLabel(props.providers, instanceId, model)
              }
            />
          ) : null}
          {props.brief === undefined ? null : (
            <span className="truncate">
              with a brief from{" "}
              {handoffModelLabel(
                props.providers,
                props.brief.providerInstanceId,
                props.brief.model,
              )}
            </span>
          )}
        </span>
      }
    />
  );
}

function handoffModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  model: string | undefined,
) {
  const entry = getProviderInstanceEntry(providers, instanceId);
  const slug = model?.trim();
  const providerModel =
    slug === undefined || slug.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === slug);
  return providerModel !== undefined
    ? getTriggerDisplayModelName(providerModel)
    : slug !== undefined && slug.length > 0
      ? slug
      : (entry?.displayName ?? instanceId);
}

function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const label = handoffModelLabel(props.providers, props.instanceId, props.model);
  const labelColor = providerTextColor(
    entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              iconClassName="size-3"
            />
            <span
              className={cn("truncate font-medium", labelColor.className)}
              style={labelColor.style}
            >
              {label}
            </span>
          </span>
        }
      />
      <TooltipPopup>
        {entry?.displayName ?? props.instanceId} · {label}
      </TooltipPopup>
    </Tooltip>
  );
}

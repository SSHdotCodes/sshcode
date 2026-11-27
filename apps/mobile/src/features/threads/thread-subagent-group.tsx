import { FirstSubagentAsk } from "./FirstSubagentAsk";
import { TeamBoardPresenceChip } from "./TeamBoardPresenceChip";
import { SubagentGradeBadge } from "./SubagentGradeBadge";
import { useAtomValue } from "@effect/atom-react";
import { connectionWorkLabel, connectionWorkStatus } from "@t3tools/client-runtime/connection";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { StackActions, useIsFocused, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type SubagentSpeed,
  subagentSpeed,
  summarizeSubagentStatuses,
  isResearchSubagent,
  researchReportPreview,
  researchSources,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { SubagentSpeedBadge } from "./SubagentSpeedBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { subagentCardDetail, subagentCardElapsed } from "./subagent-card-presentation";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { liveSubagentThreadId, shouldOverlaySubagentStatus } from "./subagentLiveStatus";
import {
  IMAGE_GENERATOR_NATIVE_TYPE,
  ImageGenerationPictures,
  ImageGenerationRow,
  ResearchReport,
  ResearchRow,
  SUBAGENT_TRANSCRIPT_CARD_CLASS_NAME,
  SubagentRow,
} from "./SubagentRow";
import { WorkLogBlock } from "./work-log-layout";

const EMPTY_LIVE_SUBAGENTS = Atom.make<ReadonlyArray<OrchestrationV2Subagent> | undefined>(
  undefined,
).pipe(Atom.withLabel("mobile-subagent-group:no-live"));

function subagentRosterAtom(environmentId: EnvironmentId, threadId: ThreadId | null) {
  if (threadId === null) return EMPTY_LIVE_SUBAGENTS;
  return environmentThreadDetails
    .threadAtom(scopeThreadRef(environmentId, threadId))
    .pipe(Atom.map((thread) => thread?.projection.subagents));
}

function useSubagentRosterAtom(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return useMemo(() => subagentRosterAtom(environmentId, threadId), [environmentId, threadId]);
}

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type AgentTiming = Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">;

export function SubagentElapsed({ agents }: { readonly agents: ReadonlyArray<AgentTiming> }) {
  const focused = useIsFocused();
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!live || !focused || !appActive) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [appActive, focused, live]);
  const elapsed = subagentCardElapsed(agents, nowMs);
  return elapsed ? <Text className="shrink-0 text-xs text-foreground-muted">{elapsed}</Text> : null;
}

function SubagentAvatar(props: {
  readonly item: SubagentItem;
  readonly iconUrl?: string | null | undefined;
  readonly speed?: SubagentSpeed | null | undefined;
}) {
  return (
    <View
      accessible={false}
      className="relative h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card"
    >
      <ProviderIcon provider={props.item.driver} iconUrl={props.iconUrl} size={15} />
      {props.speed ? <SubagentSpeedBadge speed={props.speed} /> : null}
    </View>
  );
}

export function ThreadSubagentGroup(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly environmentId: EnvironmentId;
  readonly anchorKey: string;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: ColorValue;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
  /** Shows a picture a subagent made, the way the feed shows pictures an agent opened. */
  readonly renderImage?: (image: {
    href: string;
    alt: string | null;
    title: string | null;
  }) => ReactNode;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const navigation = useNavigation();
  const openLink = useOpenPullRequest();
  const members = props.activities.flatMap(({ projectedItem }) =>
    projectedItem.item.type === "subagent"
      ? [
          {
            item: projectedItem.item,
            visibility: projectedItem.visibility,
            threadId: projectedItem.item.threadId,
          },
        ]
      : [],
  );
  const liveThreadId = liveSubagentThreadId(members);
  // Inherited cards keep the source thread id. Subscribing to it would paint
  // that chat's live agents into this one.
  const rosterAtom = useSubagentRosterAtom(props.environmentId, liveThreadId);
  const liveAgents = useAtomValue(rosterAtom);
  const agents = members.map((member) => {
    const item = member.item;
    const live = shouldOverlaySubagentStatus(member, liveThreadId)
      ? liveAgents?.find((agent) => agent.id === item.subagentId)
      : undefined;
    return {
      ...item,
      id: item.subagentId,
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
      result: live?.result ?? item.result,
      progress: live?.progress ?? item.progress,
      model: live?.model ?? null,
      modelSelection: live?.modelSelection,
      remote: live?.remote,
      nativeType: live?.nativeType,
      role: live?.role,
      imagePaths: live?.imagePaths,
    };
  });
  const connection = useRemoteEnvironmentRuntime(props.environmentId);
  const hasActive = agents.some((agent) => isActiveSubagentStatus(agent.status));
  const connectionStatus = hasActive ? connectionWorkStatus(connection?.connectionState) : null;
  const grouped = agents.length > 1;
  const label = `${agents.length} subagents`;
  const summary = connectionStatus
    ? connectionWorkLabel(connectionStatus)
    : summarizeSubagentStatuses(agents.map((agent) => agent.status));
  const expanded = props.expandedRows[props.anchorKey] ?? false;
  const iconUrl = (item: SubagentItem) =>
    config?.providers.find((provider) => provider.instanceId === item.providerInstanceId)?.iconUrl;
  return (
    <WorkLogBlock>
      {grouped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${summary}`}
          accessibilityState={{ expanded }}
          onPress={() => props.onToggleRow(props.anchorKey, props.anchorKey)}
          className={cn(
            "min-h-14 flex-row items-center gap-3 rounded-xl border-continuous px-2.5 py-2 active:bg-subtle-strong",
            expanded && "mb-1.5 bg-subtle",
          )}
        >
          <View className="flex-row items-center">
            {agents.slice(0, 3).map((agent, index) => (
              <View key={agent.item.id} style={{ marginLeft: index === 0 ? 0 : -7 }}>
                <SubagentAvatar
                  item={agent.item}
                  iconUrl={iconUrl(agent.item)}
                  speed={subagentSpeed(agent.modelSelection)}
                />
              </View>
            ))}
            {agents.length > 3 ? (
              <View className="-ml-2 h-7 w-7 items-center justify-center rounded-full border border-border bg-card">
                <Text className="text-2xs text-foreground-muted">+{agents.length - 3}</Text>
              </View>
            ) : null}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
              {label}
            </Text>
            <Text
              numberOfLines={1}
              className={cn(
                "text-2xs text-foreground-muted",
                hasActive && connectionStatus === null
                  ? "text-adaptive-sky-600-400"
                  : agents.some((agent) => agent.status === "failed") &&
                      "text-adaptive-rose-600-400",
              )}
            >
              {summary}
            </Text>
          </View>
          {connectionStatus === null ? <SubagentElapsed agents={agents} /> : null}
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
      ) : null}
      {!grouped || expanded ? (
        <View className="mb-1 gap-1.5">
          {agents.map((agent) => {
            const threadId = agent.childThreadId;
            const report =
              isResearchSubagent(agent) && agent.status === "completed" ? agent.result : null;
            const research = isResearchSubagent(agent)
              ? { sources: researchSources(report), preview: researchReportPreview(report) }
              : null;
            return (
              <View key={agent.item.id}>
                <Pressable
                  accessible
                  accessibilityRole={threadId === null ? undefined : "link"}
                  accessibilityHint={
                    threadId === null ? "Provider-managed subagent" : "Opens this subagent's chat"
                  }
                  disabled={threadId === null}
                  onPress={() => {
                    // Push, not navigate: navigate reuses this Thread route, so back
                    // would skip the parent thread.
                    if (threadId !== null)
                      navigation.dispatch(
                        StackActions.push("Thread", {
                          environmentId: String(agent.remote?.environmentId ?? props.environmentId),
                          threadId: String(threadId),
                        }),
                      );
                  }}
                  className={SUBAGENT_TRANSCRIPT_CARD_CLASS_NAME}
                >
                  {research ? (
                    <ResearchRow
                      environmentId={props.environmentId}
                      subagent={agent}
                      title={agent.title ?? "Research"}
                      status={agent.status}
                      pages={research.sources.pages}
                      elapsed={<SubagentElapsed agents={[agent]} />}
                      canOpenThread={threadId !== null}
                    />
                  ) : agent.nativeType === IMAGE_GENERATOR_NATIVE_TYPE ? (
                    <ImageGenerationRow
                      title={agent.title ?? "Image generation"}
                      status={agent.status}
                      imageCount={agent.imagePaths?.length ?? 0}
                      elapsed={<SubagentElapsed agents={[agent]} />}
                      canOpenThread={threadId !== null}
                    />
                  ) : (
                    <SubagentRow
                      environmentId={props.environmentId}
                      subagent={agent}
                      elapsed={<SubagentElapsed agents={[agent]} />}
                      grade={
                        <>
                          {agent.origin === "app_owned" ? (
                            <TeamBoardPresenceChip
                              environmentId={props.environmentId}
                              threadId={agent.threadId}
                              taskId={agent.id}
                            />
                          ) : null}
                          <SubagentGradeBadge
                            environmentId={props.environmentId}
                            taskId={agent.id}
                            origin={agent.origin}
                            status={agent.status}
                          />
                        </>
                      }
                    />
                  )}
                </Pressable>
                {research ? (
                  <ResearchReport
                    working={isActiveSubagentStatus(agent.status)}
                    progress={subagentCardDetail(agent.progress ?? null)}
                    preview={research.preview}
                    failure={
                      agent.status === "failed"
                        ? subagentCardDetail(agent.result || agent.progress || null)
                        : null
                    }
                    sites={research.sources.sites}
                    onOpenSite={(url) => void openLink(url)}
                  />
                ) : null}
                {agent.nativeType === IMAGE_GENERATOR_NATIVE_TYPE ? (
                  <ImageGenerationPictures
                    imagePaths={agent.imagePaths ?? []}
                    working={isActiveSubagentStatus(agent.status)}
                    renderImage={props.renderImage}
                  />
                ) : null}
                {agent.origin === "app_owned" && isActiveSubagentStatus(agent.status) ? (
                  <FirstSubagentAsk environmentId={props.environmentId} subagent={agent} />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </WorkLogBlock>
  );
}

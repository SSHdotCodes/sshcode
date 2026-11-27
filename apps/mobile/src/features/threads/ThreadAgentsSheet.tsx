import { TeamBoardPresenceChip } from "./TeamBoardPresenceChip";
import { SubagentGradeBadge } from "./SubagentGradeBadge";
import { useUiMode } from "../discord/useUiMode";
import { DiscordMainMembers, DiscordMember } from "../discord/DiscordMembers";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { HeldBackgroundWorkRow } from "./HeldBackgroundWork";
import {
  environmentThreadDetails,
  environmentThreadShells,
  useThreadFamily,
} from "../../state/threads";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { AgentsFooter, NewSubagentForm } from "./NewSubagentForm";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SubagentRow } from "./SubagentRow";
import { SubagentStopButton } from "./SubagentStopButton";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { ThreadMonitorRows, useThreadMonitors } from "./ThreadMonitors";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { connectionWorkLabel, connectionWorkStatus } from "@t3tools/client-runtime/connection";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const AGENTS_VIEW_ENTER = FadeIn.duration(160)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);
const AGENTS_VIEW_EXIT = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  return <AgentsSheetContent key={scopedThreadKey(route.params)} target={route.params} />;
}

function AgentsSheetContent({ target }: { readonly target: AgentsTarget }) {
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const theme = useUniwindTheme();
  const connection = useRemoteEnvironmentRuntime(target.environmentId);
  const connectionStatus = connectionWorkStatus(connection?.connectionState);
  const turn = useThreadTurnSubagents(target);
  const shell = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(target.environmentId, target.threadId)),
  );
  useThreadFamily(target.environmentId, shell?.lineage.rootThreadId ?? target.threadId);
  const heldItems =
    presentPendingBackgroundWork(shell?.pendingBackgroundTasks ?? [])?.items.filter(
      (item) => item.held !== undefined,
    ) ?? [];
  const heldTaskIds = new Set(heldItems.map((item) => item.taskId.replace(/^turn-item:/, "node:")));
  const subagents = (turn?.subagents ?? []).filter((subagent) => !heldTaskIds.has(subagent.id));
  const hasLiveAgent = subagents.some((subagent) => isOrchestrationV2WorkActive(subagent.status));
  const hasMonitors = useThreadMonitors(target.environmentId, target.threadId).length > 0;
  // Starting a subagent takes the sheet over, so the list and the form never crowd each other.
  const [composing, setComposing] = useState(false);
  const [viewTransitioned, setViewTransitioned] = useState(false);
  const openNewSubagent = () => {
    void Promise.resolve(Haptics.selectionAsync()).catch(() => undefined);
    setViewTransitioned(true);
    setComposing(true);
  };
  const closeNewSubagent = () => {
    setViewTransitioned(true);
    setComposing(false);
  };
  const title = composing ? "New subagent" : discord ? "Members" : "Agents";
  const body = composing ? (
    <Animated.View
      key="compose"
      entering={AGENTS_VIEW_ENTER}
      exiting={AGENTS_VIEW_EXIT}
      className="flex-1"
    >
      <NewSubagentForm
        environmentId={target.environmentId}
        threadId={target.threadId}
        onClose={closeNewSubagent}
      />
    </Animated.View>
  ) : null;

  const openChildThread = (childThreadId: ThreadId, environmentId = target.environmentId) => {
    void Haptics.selectionAsync();
    // Replace rather than push: the sheet is a leaf, and the child thread
    // belongs in the workspace stack where Home's back button expects it.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: 16 }}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      {heldItems.map((item) => (
        <HeldBackgroundWorkRow
          key={item.taskId}
          environmentId={target.environmentId}
          item={item}
          onOpen={() =>
            item.childThreadId !== undefined &&
            openChildThread(
              item.childThreadId,
              turn?.subagents.find((agent) => agent.childThreadId === item.childThreadId)?.remote
                ?.environmentId,
            )
          }
        />
      ))}
      {discord ? (
        <DiscordMainMembers environmentId={target.environmentId} threadId={target.threadId} />
      ) : null}
      {discord ? (
        (["Working", "Offline"] as const).map((group) => {
          const members = subagents.filter(
            (subagent) => resolveSubagentRowPresentation(subagent).live === (group === "Working"),
          );
          return members.length ? (
            <View key={group}>
              <Text
                className="pt-5 pb-2 uppercase text-foreground-muted"
                style={{ fontSize: 12, fontWeight: "600" }}
              >
                {group === "Working" && connectionStatus
                  ? connectionWorkLabel(connectionStatus)
                  : group}{" "}
                · {members.length}
              </Text>
              {members.map((subagent) => (
                <AgentRow
                  key={subagent.id}
                  subagent={subagent}
                  environmentId={target.environmentId}
                  connectionState={connection?.connectionState}
                  tickSeconds={hasLiveAgent && connectionStatus === null}
                  onOpen={openChildThread}
                />
              ))}
            </View>
          ) : null;
        })
      ) : subagents.length === 0 ? (
        hasMonitors || heldItems.length > 0 ? null : (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            No agents in this turn.
          </Text>
        )
      ) : (
        subagents.map((subagent) => (
          <AgentRow
            key={subagent.id}
            subagent={subagent}
            environmentId={target.environmentId}
            connectionState={connection?.connectionState}
            tickSeconds={hasLiveAgent && connectionStatus === null}
            onOpen={openChildThread}
          />
        ))
      )}
      <ThreadMonitorRows environmentId={target.environmentId} threadId={target.threadId} />
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {/* The form's buttons ride above the keyboard. */}
            <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
              {body ?? (
                <Animated.View
                  key="list"
                  entering={viewTransitioned ? AGENTS_VIEW_ENTER : undefined}
                  exiting={AGENTS_VIEW_EXIT}
                  className="flex-1"
                >
                  {content}
                  <AgentsFooter
                    environmentId={target.environmentId}
                    threadId={target.threadId}
                    onNewSubagent={openNewSubagent}
                  />
                </Animated.View>
              )}
            </KeyboardAvoidingView>
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title={title}
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader
        title={title}
        onBack={() => (composing ? closeNewSubagent() : navigation.goBack())}
      />
      <MaterialScreenContent insetHorizontal={layout.usesSplitView}>
        <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
          {body ?? (
            <Animated.View
              key="list"
              entering={viewTransitioned ? AGENTS_VIEW_ENTER : undefined}
              exiting={AGENTS_VIEW_EXIT}
              className="flex-1"
            >
              {content}
              <AgentsFooter
                environmentId={target.environmentId}
                threadId={target.threadId}
                onNewSubagent={openNewSubagent}
              />
            </Animated.View>
          )}
        </KeyboardAvoidingView>
      </MaterialScreenContent>
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly connectionState?:
    | import("@t3tools/client-runtime/connection").EnvironmentConnectionPhase
    | undefined;
  readonly onOpen: (childThreadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const [uiMode] = useUiMode();
  const { subagent } = props;
  const childThreadId = subagent.childThreadId;

  const presentation = resolveSubagentRowPresentation(subagent, props.connectionState);
  const paused = resolveSubagentRowPresentation(subagent).live && !presentation.live;
  const grade = (
    <>
      {subagent.origin === "app_owned" ? (
        <TeamBoardPresenceChip
          environmentId={props.environmentId}
          threadId={subagent.threadId}
          taskId={subagent.id}
        />
      ) : null}
      <SubagentGradeBadge
        environmentId={props.environmentId}
        taskId={subagent.id}
        origin={subagent.origin}
        status={subagent.status}
      />
    </>
  );
  const row =
    uiMode === "discord" ? (
      <DiscordMember
        name={presentation.title}
        driver={subagent.driver}
        status={presentation.detail ?? presentation.statusLabel}
        color={
          presentation.live ? "#23A55A" : presentation.tone === "failed" ? "#F23F43" : "#949BA4"
        }
      >
        {paused ? null : <AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      </DiscordMember>
    ) : (
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        elapsed={
          paused ? null : <AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />
        }
        grade={grade}
      />
    );
  // The row's own divider and padding; Discord member rows bring theirs.
  const rowFrame = uiMode === "discord" ? "" : "border-b border-border py-3.5";

  // The card carries its own grade chip; a Discord member row has no slot for it.
  const feedback = uiMode === "discord" ? <View className="items-start">{grade}</View> : null;
  if (childThreadId === null) {
    return (
      <View>
        <View
          accessible
          accessibilityHint="Provider-managed agent. Its work appears in the transcript."
          className={rowFrame}
        >
          {row}
        </View>
        {feedback}
      </View>
    );
  }

  return (
    <View>
      {/* Stop sits beside the row, not inside it, so VoiceOver reaches both. */}
      <View className={`flex-row items-center gap-2 ${rowFrame}`}>
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens this agent's chat"
          onPress={() => props.onOpen(childThreadId, subagent.remote?.environmentId)}
          className="min-w-0 flex-1 active:opacity-70"
        >
          {row}
        </Pressable>
        <SubagentStopButton
          environmentId={props.environmentId}
          subagent={subagent}
          title={presentation.title}
        />
      </View>
      {feedback}
    </View>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs text-foreground-muted">{elapsed}</Text>
  );
}

/**
 * Elapsed time for one agent. Only live work ticks, inside AgentElapsed,
 * so the timer never repaints the metadata or a settled sheet.
 */
function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const running = isOrchestrationV2WorkActive(subagent.status);
  const nowMs = useVisibleSecondClock(tickSeconds && running);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}

import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  WORKFLOW_AGENT_STATUS_LABEL,
  findWorkflowAgent,
  workflowAgentActions,
  workflowAgentsNeedingYou,
  workflowNeedsLabel,
} from "@t3tools/client-runtime/workflow-run";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type EnvironmentId,
  type ThreadId,
  type WorkflowRun,
  type WorkflowRunAgent,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getExplicitModelEffortLabel } from "@t3tools/shared/model";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_COLORS } from "./WorkflowCanvas";
import { WorkflowButton } from "./WorkflowSheets";
import { mutateWorkflow } from "./state";
import { workflowElapsed } from "./viewModel";

function failureText(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

/**
 * The run view's open sheet. A tap on an agent with a known thread opens its
 * sheet, following Retry to the newest attempt; anything else (a lead whose
 * mapping hasn't arrived) opens its chat as before.
 */
export function useWorkflowAgentSelection(
  run: WorkflowRun,
  openThread: (threadId: string) => void,
) {
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const agent = threadId === null ? null : findWorkflowAgent(run.agents, threadId);
  const needing = useMemo(() => workflowAgentsNeedingYou(run.agents), [run.agents]);
  const select = (id: string) => {
    if (findWorkflowAgent(run.agents, id as ThreadId)) setThreadId(id as ThreadId);
    else openThread(id);
  };
  const close = useCallback(() => setThreadId(null), []);
  return { agent, needing, select, close };
}

/** One chip per agent with an open approval or question; tapping opens its chat to answer. */
export function WorkflowNeedsStrip({
  agents,
  onOpen,
}: {
  agents: ReadonlyArray<WorkflowRunAgent>;
  onOpen: (agent: WorkflowRunAgent) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="grow-0 border-b border-border bg-sheet-solid"
      contentContainerClassName="items-center gap-2 px-4 py-2"
    >
      <Text className="text-xs font-t3-medium text-foreground-muted">Needs you</Text>
      {agents.map((agent) => (
        <Pressable
          key={agent.threadId}
          accessibilityRole="button"
          accessibilityHint="Opens its chat"
          onPress={() => onOpen(agent)}
          className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-secondary px-3"
        >
          <View
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: STATUS_COLORS.waiting }}
          />
          <Text className="text-sm">{workflowNeedsLabel(agent)}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** The tapped agent: where it stands, and Open chat, Steer, Stop or Retry. */
export function WorkflowAgentSheet({
  environmentId,
  run,
  agent,
  connected,
  now,
  onOpenChat,
  onClose,
}: {
  environmentId: EnvironmentId;
  run: WorkflowRun;
  agent: WorkflowRunAgent;
  connected: boolean;
  now: number;
  onOpenChat: (agent: WorkflowRunAgent) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const config = useEnvironmentServerConfig(environmentId);
  const mutate = useAtomCommand(mutateWorkflow, { reportFailure: false });
  const permission = useAtomValue(mutateWorkflow.permissionAtom(environmentId));
  const [busy, setBusy] = useState<"stopAgent" | "retryAgent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);
  const node = run.snapshot.nodes.find((entry) => entry.id === agent.nodeId);
  const box = node?.kind === "agent" ? node : undefined;
  const instanceId = agent.instanceId ?? box?.model?.instanceId;
  const slug = agent.model ?? box?.model?.model;
  const catalogModel = config?.providers
    .find((provider) => provider.instanceId === instanceId)
    ?.models.find((entry) => entry.slug === slug);
  const effort = getExplicitModelEffortLabel(box?.model, catalogModel?.capabilities);
  const model = [catalogModel?.name ?? slug, effort].filter(Boolean).join(" · ");
  const actions = workflowAgentActions(agent);
  const enabled = connected && permission && busy === null;
  const elapsed = agent.startedAt ? workflowElapsed(agent.startedAt, agent.completedAt, now) : null;

  const act = (type: "stopAgent" | "retryAgent") => {
    setBusy(type);
    setError(null);
    void mutate({ environmentId, input: { type, runId: run.id, threadId: agent.threadId } }).then(
      (result) => {
        setBusy(null);
        setError(
          failureText(result, type === "stopAgent" ? "Couldn't stop it." : "Couldn't retry it."),
        );
      },
    );
  };

  return (
    <KeyboardStickyView
      className="absolute inset-x-0 bottom-0"
      offset={{ closed: 0, opened: insets.bottom }}
    >
      <View
        accessibilityViewIsModal
        className="gap-3 rounded-t-3xl border-t border-border bg-sheet-solid px-5 pt-4"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <View className="flex-row items-center gap-3">
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="flex-1 text-lg font-t3-semibold"
          >
            {agent.title}
          </Text>
          <WorkflowButton title="Close" onPress={onClose} />
        </View>
        <View className="gap-1">
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {model}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[agent.status] }}
            />
            <Text className="flex-1 text-sm">
              {WORKFLOW_AGENT_STATUS_LABEL[agent.status]}
              {elapsed ? ` · ${elapsed}` : ""}
            </Text>
            {agent.grade !== undefined ? (
              <Text className="text-sm text-foreground-muted">Grade {agent.grade}/10</Text>
            ) : null}
          </View>
          {agent.needs ? (
            <Text className="text-sm text-warning-foreground">
              Needs your {agent.needs === "approval" ? "approval" : "answer"} in its chat.
            </Text>
          ) : null}
          {agent.progress ? (
            <Text numberOfLines={3} className="text-sm text-foreground-muted">
              {agent.progress}
            </Text>
          ) : null}
          {agent.retryOf ? (
            <Text className="text-sm text-foreground-muted">Retry of an earlier attempt</Text>
          ) : null}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <WorkflowButton title="Open chat" onPress={() => onOpenChat(agent)} />
          {actions.stop ? (
            <WorkflowButton
              title={busy === "stopAgent" ? "Stopping…" : "Stop"}
              danger
              disabled={!enabled}
              onPress={() => act("stopAgent")}
            />
          ) : null}
          {actions.retry ? (
            <WorkflowButton
              title={busy === "retryAgent" ? "Retrying…" : "Retry"}
              disabled={!enabled}
              onPress={() => act("retryAgent")}
            />
          ) : null}
        </View>
        {actions.steer ? (
          <SteerField
            environmentId={environmentId}
            agent={agent}
            disabled={!connected}
            onError={setError}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
    </KeyboardStickyView>
  );
}

/** Sends a steer into the agent's running turn, the way the chat composer does. */
function SteerField({
  environmentId,
  agent,
  disabled,
  onError,
}: {
  environmentId: EnvironmentId;
  agent: WorkflowRunAgent;
  disabled: boolean;
  onError: (error: string | null) => void;
}) {
  const send = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const shell = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, agent.threadId)),
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = () => {
    const message = text.trim();
    if (!message || sending || disabled) return;
    setSending(true);
    onError(null);
    void send({
      environmentId,
      input: {
        threadId: agent.threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: message,
          attachments: [],
        },
        // Only a new thread reads these; a steer goes to the turn already running.
        runtimeMode: shell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: shell?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        dispatchMode: "steer",
      },
    }).then((result) => {
      setSending(false);
      const failure = failureText(result, "The chat didn't take it.");
      onError(failure);
      if (result._tag === "Success") setText("");
    });
  };
  return (
    <View className="flex-row items-center gap-2">
      <AppTextInput
        accessibilityLabel={`Steer ${agent.title}`}
        placeholder="Steer this agent…"
        value={text}
        onChangeText={setText}
        maxLength={4_000}
        editable={!disabled}
        returnKeyType="send"
        onSubmitEditing={submit}
        className="flex-1"
      />
      <WorkflowButton
        title={sending ? "Sending…" : "Send"}
        disabled={disabled || sending || !text.trim()}
        onPress={submit}
      />
    </View>
  );
}

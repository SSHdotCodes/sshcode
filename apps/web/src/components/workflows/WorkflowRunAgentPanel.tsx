import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { workflowAgentActions } from "@t3tools/client-runtime/workflow-run";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ThreadId,
  type WorkflowAgentNode,
  type WorkflowRunAgent,
  type WorkflowRunId,
} from "@t3tools/contracts";
import { MessageSquareIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn, newMessageId } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { STATUS_DOT, ModelChip } from "./WorkflowStatus";
import { useNow } from "./useNow";
import { useWorkflowCommands } from "./useWorkflows";
import {
  AGENT_STATUS_LABEL,
  agentTitle,
  countCapacity,
  elapsedBetween,
  formatElapsed,
  type AgentChatTarget,
  type RunBox,
} from "./workflowGraph";
import { describeModel, type useWorkflowModelCatalog } from "./workflowModels";
import styles from "./workflows.module.css";

type Catalog = ReturnType<typeof useWorkflowModelCatalog>;

/** The selected box in a run: its agents, and what you can do with the picked one. */
export function WorkflowRunAgentPanel({
  environmentId,
  runId,
  box,
  agent,
  canEdit,
  catalog,
  chatTarget,
  onPick,
  onOpenAgent,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: WorkflowRunId;
  readonly box: RunBox;
  readonly agent: WorkflowRunAgent | null;
  readonly canEdit: boolean;
  readonly catalog: Catalog;
  readonly chatTarget: (agent: WorkflowRunAgent) => AgentChatTarget;
  readonly onPick: (threadId: ThreadId) => void;
  readonly onOpenAgent: (agent: WorkflowRunAgent) => void;
  readonly onClose: () => void;
}) {
  const many = countCapacity(box.node.count) > 1;
  return (
    <aside
      aria-label="Agent"
      className={`${styles.panel} pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg`}
    >
      <div className="flex items-center gap-2 py-2 pr-2 pl-3.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{agentTitle(box.node)}</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pb-3.5">
        {many ? (
          <AgentList agents={box.agents} picked={agent?.threadId ?? null} onPick={onPick} />
        ) : null}
        {agent ? (
          <AgentDetail
            key={agent.threadId}
            environmentId={environmentId}
            runId={runId}
            agent={agent}
            node={box.node}
            canEdit={canEdit}
            catalog={catalog}
            chatTarget={chatTarget(agent)}
            onOpen={() => onOpenAgent(agent)}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {box.agents.length > 0 ? "Pick an agent." : "Not started yet."}
          </p>
        )}
      </div>
    </aside>
  );
}

function AgentList({
  agents,
  picked,
  onPick,
}: {
  readonly agents: ReadonlyArray<WorkflowRunAgent>;
  readonly picked: ThreadId | null;
  readonly onPick: (threadId: ThreadId) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <ul className="-mx-1.5 flex flex-col">
      {agents.map((agent) => (
        <li key={agent.threadId}>
          <button
            type="button"
            aria-pressed={agent.threadId === picked}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent",
              agent.threadId === picked && "bg-accent",
            )}
            onClick={() => onPick(agent.threadId)}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[agent.status])} />
            <span className="min-w-0 flex-1 truncate">{agent.title}</span>
            <span className="shrink-0 text-muted-foreground">
              {agent.needs ? `Needs ${agent.needs}` : AGENT_STATUS_LABEL[agent.status]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentDetail({
  environmentId,
  runId,
  agent,
  node,
  canEdit,
  catalog,
  chatTarget,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: WorkflowRunId;
  readonly agent: WorkflowRunAgent;
  readonly node: WorkflowAgentNode;
  readonly canEdit: boolean;
  readonly catalog: Catalog;
  readonly chatTarget: AgentChatTarget;
  readonly onOpen: () => void;
}) {
  const commands = useWorkflowCommands(environmentId);
  const actions = workflowAgentActions(agent);
  const now = useNow(agent.startedAt !== null && agent.completedAt === null);
  const elapsed = elapsedBetween(agent.startedAt, agent.completedAt, now);
  const instanceId = agent.instanceId ?? node.model?.instanceId;
  const slug = agent.model ?? node.model?.model;
  const model =
    instanceId && slug
      ? describeModel(catalog.instanceEntries, instanceId, slug, node.model?.options)
      : null;
  const [busy, setBusy] = useState<"stop" | "retry" | null>(null);

  const mutate = async (type: "stopAgent" | "retryAgent") => {
    setBusy(type === "stopAgent" ? "stop" : "retry");
    const result = await commands.mutate({ type, runId, threadId: agent.threadId });
    setBusy(null);
    if (!result.ok && !result.interrupted) {
      toastManager.add({
        type: "error",
        title:
          type === "stopAgent" ? `Couldn't stop ${agent.title}` : `Couldn't retry ${agent.title}`,
        description: result.message,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {model ? <ModelChip description={model} className="min-w-0 text-foreground" /> : null}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[agent.status])} />
          <span>{AGENT_STATUS_LABEL[agent.status]}</span>
          {elapsed !== null ? (
            <span className="text-muted-foreground tabular-nums">· {formatElapsed(elapsed)}</span>
          ) : null}
          {agent.grade !== undefined ? (
            <span className="ml-auto text-muted-foreground tabular-nums">
              Grade {agent.grade}/10
            </span>
          ) : null}
        </div>
        {agent.needs ? (
          <p className="text-xs text-warning-foreground">
            Needs your {agent.needs === "approval" ? "approval" : "answer"} in its chat.
          </p>
        ) : null}
        {agent.progress ? (
          <p className="line-clamp-3 text-xs text-muted-foreground">{agent.progress}</p>
        ) : null}
        {agent.retryOf ? (
          <p className="text-xs text-muted-foreground">Retry of an earlier attempt</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={onOpen}>
          <MessageSquareIcon />
          Open chat
        </Button>
        {actions.stop ? (
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={!canEdit || busy !== null}
            onClick={() => void mutate("stopAgent")}
          >
            {busy === "stop" ? <Spinner /> : <SquareIcon />}
            Stop
          </Button>
        ) : null}
        {actions.retry ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || busy !== null}
            onClick={() => void mutate("retryAgent")}
          >
            {busy === "retry" ? <Spinner /> : <RotateCcwIcon />}
            Retry
          </Button>
        ) : null}
      </div>
      {actions.steer && chatTarget.kind === "app" ? (
        <SteerField
          environmentId={chatTarget.environmentId as EnvironmentId}
          threadId={chatTarget.threadId as ThreadId}
          title={agent.title}
          disabled={!canEdit}
        />
      ) : null}
    </div>
  );
}

/** Sends a steer into the agent's running turn, the way the chat composer does. */
function SteerField({
  environmentId,
  threadId,
  title,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly disabled: boolean;
}) {
  const send = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const message = text.trim();
    if (!message || sending || disabled) return;
    setSending(true);
    const result = await send({
      environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        // Only a new thread reads these; a steer goes to the turn already running.
        runtimeMode: shell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: shell?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        dispatchMode: "steer",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Couldn't steer ${title}`,
        description: error instanceof Error ? error.message : "The chat didn't take it.",
      });
      return;
    }
    setText("");
  };
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        size="sm"
        aria-label={`Steer ${title}`}
        placeholder="Steer this agent…"
        value={text}
        maxLength={4_000}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={disabled || sending || !text.trim()}
      >
        {sending ? <Spinner /> : null}
        Send
      </Button>
    </form>
  );
}

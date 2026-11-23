import { useAtomValue } from "@effect/atom-react";
import { getExplicitModelEffortLabel } from "@t3tools/shared/model";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  WorkflowId,
  type EnvironmentId,
  type ModelSelection,
  type WorkflowAgentStatus,
  type WorkflowDefinition,
  type WorkflowOperation,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowRunStatus,
} from "@t3tools/contracts";
import { sketchExampleWorkflow } from "@t3tools/shared/workflowSketch";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import { relativeTime } from "../../lib/time";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useWorkflowRunTitle } from "./useWorkflowRunTitle";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_COLORS } from "./WorkflowCanvas";
import { WorkflowButton, WorkflowField, WorkflowSheet } from "./WorkflowSheets";
import { useSketchFont, WorkflowSketch, type SketchModel } from "./WorkflowSketch";
import { mutateWorkflow, workflowsState } from "./state";
import { newWorkflow, workflowElapsed } from "./viewModel";

const RUN_LABEL: Record<WorkflowRunStatus, string> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const RUN_TONE: Record<WorkflowRunStatus, WorkflowAgentStatus> = {
  starting: "pending",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};
// Work still going outranks a failure, which outranks a finish (as on the Mac).
const STATUS_WEIGHT: Record<WorkflowAgentStatus, number> = {
  running: 7,
  waiting: 6,
  pending: 5,
  failed: 4,
  interrupted: 3,
  cancelled: 2,
  completed: 1,
  planned: 0,
};

const isLive = (status: WorkflowRunStatus) =>
  status === "starting" || status === "running" || status === "waiting";

function boxStatus(agents: ReadonlyArray<WorkflowRunAgent>): WorkflowAgentStatus {
  let status: WorkflowAgentStatus = "planned";
  for (const agent of agents)
    if (STATUS_WEIGHT[agent.status] > STATUS_WEIGHT[status]) status = agent.status;
  return status;
}

function runStatuses(run: WorkflowRun) {
  const statuses = new Map<string, WorkflowAgentStatus>();
  for (const node of run.snapshot.nodes)
    if (node.kind === "agent")
      statuses.set(node.id, boxStatus(run.agents.filter((agent) => agent.nodeId === node.id)));
  return statuses;
}

function failureText(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : String(cause);
}

/** "claude-opus-5-5" → "Opus 5.5" when the catalog doesn't name a model. */
function prettifyModelSlug(slug: string): string {
  const out: string[] = [];
  for (const word of slug
    .replace(/^claude-/u, "")
    .split(/[-_\s]+/u)
    .filter(Boolean)) {
    const previous = out.at(-1);
    if (/^\d+$/u.test(word) && previous !== undefined && /\d$/u.test(previous))
      out[out.length - 1] = `${previous}.${word}`;
    else out.push(word.toLowerCase() === "gpt" ? "GPT" : word[0]!.toUpperCase() + word.slice(1));
  }
  return out.join(" ") || slug;
}

/** Names a box's model from this environment's catalog, like the Mac's model chips. */
function useSketchModels(environmentId: EnvironmentId) {
  const providers = useEnvironmentServerConfig(environmentId)?.providers;
  return useCallback(
    (selection: ModelSelection | null): (SketchModel & { iconUrl?: string }) | null => {
      if (!selection) return null;
      const provider = providers?.find((entry) => entry.instanceId === selection.instanceId);
      const model = provider?.models.find((entry) => entry.slug === selection.model);
      return {
        name: [
          model?.name ?? prettifyModelSlug(selection.model),
          getExplicitModelEffortLabel(selection, model?.capabilities),
        ]
          .filter(Boolean)
          .join(" · "),
        driverKind: provider?.driver ?? selection.instanceId,
        ...(provider?.iconUrl ? { iconUrl: provider.iconUrl } : {}),
      };
    },
    [providers],
  );
}

function RunBadge({ status }: { readonly status: WorkflowRunStatus }) {
  const color = STATUS_COLORS[RUN_TONE[status]];
  return (
    <View
      className="flex-row items-center gap-1 rounded-full px-2 py-0.5"
      style={{ backgroundColor: `${color}24` }}
    >
      <View className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      <Text className="text-xs font-t3-medium" style={{ color }}>
        {RUN_LABEL[status]}
      </Text>
    </View>
  );
}

function MoreButton({ label }: { readonly label: string }) {
  return (
    <View
      accessibilityLabel={label}
      className="size-8 items-center justify-center rounded-full active:opacity-60"
    >
      <SymbolView name="ellipsis" size={15} tintColorClassName="accent-icon-muted" />
    </View>
  );
}

export function WorkflowLibrary({
  environmentId,
  connected,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const navigation = useNavigation();
  const query = useEnvironmentQuery(workflowsState({ environmentId, input: {} }));
  const canMutate = useAtomValue(mutateWorkflow.permissionAtom(environmentId));
  const mutate = useAtomCommand(mutateWorkflow, { reportFailure: false });
  const describe = useSketchModels(environmentId);
  const hand = useSketchFont();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WorkflowDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [now] = useState(() => Date.now());
  const example = useMemo(() => {
    let next = 0;
    return sketchExampleWorkflow(new Date(0).toISOString(), true, () => `example${++next}`);
  }, []);
  const workflows = useMemo(
    () => [...(query.data?.workflows ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [query.data?.workflows],
  );
  const runs = query.data?.runs ?? [];
  const lastRun = (workflow: WorkflowDefinition) =>
    runs
      .filter((run) => run.workflowId === workflow.id)
      .reduce<WorkflowRun | null>(
        (latest, run) => (latest && latest.createdAt > run.createdAt ? latest : run),
        null,
      );
  const operate = async (input: WorkflowOperation) => {
    if (lock.current || !connected || !canMutate) return false;
    lock.current = true;
    setBusy(true);
    try {
      const result = await mutate({ environmentId, input });
      setError(failureText(result));
      return result._tag === "Success";
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const open = (workflowId: string) =>
    navigation.dispatch(StackActions.push("Workflows", { environmentId, workflowId }));
  const openRun = (runId: string) =>
    navigation.dispatch(StackActions.push("Workflows", { environmentId, runId }));
  const create = async (fromExample: boolean) => {
    const at = new Date().toISOString();
    const workflow = fromExample
      ? sketchExampleWorkflow(at, false, () => uuidv4().replaceAll("-", "").slice(0, 12))
      : newWorkflow(uuidv4(), at);
    if (await operate({ type: "save", workflow })) open(workflow.id);
  };
  const duplicate = (workflow: WorkflowDefinition) => {
    const at = new Date().toISOString();
    void operate({
      type: "save",
      workflow: {
        ...workflow,
        id: WorkflowId.make(uuidv4()),
        name: `${workflow.name.slice(0, 110)} copy`,
        createdAt: at,
        updatedAt: at,
      },
    });
  };
  const remove = (workflow: WorkflowDefinition) =>
    Alert.alert(`Delete “${workflow.name}”?`, "Its runs stay.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void operate({ type: "delete", id: workflow.id }),
      },
    ]);
  const enabled = connected && canMutate && !busy && query.data !== null;
  const rows = [
    ...workflows.map((workflow) => ({ kind: "workflow" as const, workflow })),
    ...(runs.length ? [{ kind: "runs" as const }] : []),
  ];

  const notices = (
    <>
      {!connected ? (
        <Text className="text-sm text-foreground-muted">
          Reconnect to edit or start a workflow.
        </Text>
      ) : null}
      {connected && !canMutate ? (
        <Text className="text-sm text-foreground-muted">This connection has read-only access.</Text>
      ) : null}
      {error || query.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? query.error}
        </Text>
      ) : null}
      {query.error ? <WorkflowButton title="Retry" onPress={query.refresh} /> : null}
    </>
  );

  return (
    <>
      <FlatList
        data={rows}
        keyExtractor={(row) => (row.kind === "workflow" ? row.workflow.id : "runs")}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
        ListHeaderComponent={
          query.data === null && !query.error ? (
            <Text className="py-10 text-center text-foreground-muted">
              {connected ? "Loading workflows…" : "Connect to see your workflows."}
            </Text>
          ) : workflows.length === 0 && query.data ? (
            <View className="items-center gap-5 py-4">
              {notices}
              <WorkflowSketch
                workflow={example}
                describe={describe}
                showNotes={false}
                height={250}
              />
              <View className="items-center gap-1.5 px-3">
                <Text className="text-2xl" style={hand ? { fontFamily: hand } : null}>
                  Draw a team of agents
                </Text>
                <Text className="text-center text-sm text-foreground-muted">
                  Sketch who leads and who helps, on which models. Starting it opens a lead chat
                  that hands work down the boxes you drew.
                </Text>
              </View>
              <View className="w-full gap-2 px-6">
                <Pressable
                  accessibilityRole="button"
                  disabled={!enabled}
                  onPress={() => void create(false)}
                  className="min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-primary disabled:opacity-40"
                >
                  <SymbolView
                    name="plus"
                    size={14}
                    tintColorClassName="accent-primary-foreground"
                  />
                  <Text className="font-t3-semibold text-primary-foreground">New workflow</Text>
                </Pressable>
                <WorkflowButton
                  title="Start from an example"
                  disabled={!enabled}
                  onPress={() => void create(true)}
                />
              </View>
            </View>
          ) : (
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-lg font-t3-semibold">Workflows</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="New workflow"
                  disabled={!enabled}
                  onPress={() => void create(false)}
                  className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-primary px-3.5 disabled:opacity-40"
                >
                  <SymbolView
                    name="plus"
                    size={12}
                    tintColorClassName="accent-primary-foreground"
                  />
                  <Text className="text-sm font-t3-semibold text-primary-foreground">New</Text>
                </Pressable>
              </View>
              {notices}
            </View>
          )
        }
        renderItem={({ item }) =>
          item.kind === "runs" ? (
            <View className="gap-2 pt-2">
              <Text className="text-lg font-t3-semibold">Runs</Text>
              <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
                {runs.map((run, index) => (
                  <RunRow
                    key={run.id}
                    environmentId={environmentId}
                    run={run}
                    first={index === 0}
                    now={now}
                    canEdit={enabled}
                    onOpen={() => openRun(run.id)}
                    onCancel={() => void operate({ type: "cancelRun", runId: run.id })}
                    onDelete={() => void operate({ type: "deleteRun", runId: run.id })}
                  />
                ))}
              </View>
            </View>
          ) : (
            <WorkflowCard
              workflow={item.workflow}
              lastRun={lastRun(item.workflow)}
              describe={describe}
              canEdit={enabled}
              onOpen={() => open(item.workflow.id)}
              onRename={() => setRenaming(item.workflow)}
              onDuplicate={() => duplicate(item.workflow)}
              onDelete={() => remove(item.workflow)}
            />
          )
        }
      />
      {renaming ? (
        <WorkflowSheet
          title="Rename workflow"
          onClose={() => setRenaming(null)}
          footer={
            <WorkflowButton
              title="Save name"
              disabled={!renaming.name.trim() || busy}
              onPress={() => {
                void operate({
                  type: "save",
                  workflow: {
                    ...renaming,
                    name: renaming.name.trim(),
                    updatedAt: new Date().toISOString(),
                  },
                }).then((saved) => {
                  if (saved) setRenaming(null);
                });
              }}
            />
          }
        >
          <WorkflowField
            label="Name"
            value={renaming.name}
            maxLength={120}
            onChange={(name) => setRenaming({ ...renaming, name })}
          />
        </WorkflowSheet>
      ) : null}
    </>
  );
}

function WorkflowCard({
  workflow,
  lastRun,
  describe,
  canEdit,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  readonly workflow: WorkflowDefinition;
  readonly lastRun: WorkflowRun | null;
  readonly describe: ReturnType<typeof useSketchModels>;
  readonly canEdit: boolean;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}) {
  const models = useMemo(() => {
    const seen = new Map<string, NonNullable<ReturnType<typeof describe>>>();
    for (const node of workflow.nodes) {
      if (node.kind !== "agent" || !node.model) continue;
      const key = `${node.model.instanceId}:${node.model.model}`;
      const description = describe(node.model);
      if (description && !seen.has(key)) seen.set(key, description);
    }
    return [...seen.values()];
  }, [describe, workflow.nodes]);
  // While its latest run is live, the drawing tints each box by how it's doing.
  const statuses = useMemo(
    () => (lastRun && isLive(lastRun.status) ? runStatuses(lastRun) : undefined),
    [lastRun],
  );
  return (
    <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${workflow.name}`}
        onPress={onOpen}
        className="h-40 justify-center border-b border-border-subtle bg-subtle px-3 active:opacity-80"
      >
        <WorkflowSketch
          workflow={workflow}
          statuses={statuses}
          describe={describe}
          showNotes={false}
          height={144}
          compact
        />
      </Pressable>
      <View className="gap-2 px-4 pb-3.5 pt-3">
        <View className="flex-row items-center gap-2">
          <Pressable accessibilityRole="button" onPress={onOpen} className="flex-1">
            <Text numberOfLines={1} className="text-base font-t3-semibold">
              {workflow.name}
            </Text>
          </Pressable>
          <ControlPillMenu
            accessibilityLabel={`More for ${workflow.name}`}
            actions={[
              {
                id: "rename",
                title: "Rename",
                image: "pencil",
                attributes: { disabled: !canEdit },
              },
              {
                id: "duplicate",
                title: "Duplicate",
                image: "doc.on.doc",
                attributes: { disabled: !canEdit },
              },
              {
                id: "delete",
                title: "Delete",
                image: "trash",
                attributes: { destructive: true, disabled: !canEdit },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "rename") onRename();
              else if (nativeEvent.event === "duplicate") onDuplicate();
              else if (nativeEvent.event === "delete") onDelete();
            }}
          >
            <MoreButton label={`More for ${workflow.name}`} />
          </ControlPillMenu>
        </View>
        <View className="min-h-5 flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {models.length ? (
            models.slice(0, 3).map((model) => (
              <View
                key={`${model.driverKind}:${model.name}`}
                className="flex-row items-center gap-1.5"
              >
                <ProviderIcon provider={model.driverKind} iconUrl={model.iconUrl} size={14} />
                <Text className="text-xs font-t3-medium">{model.name}</Text>
              </View>
            ))
          ) : (
            <Text className="text-xs text-foreground-muted">No models yet</Text>
          )}
          {models.length > 3 ? (
            <Text className="text-xs text-foreground-muted">+{models.length - 3}</Text>
          ) : null}
        </View>
        <View className="flex-row items-center gap-2">
          {lastRun ? (
            <>
              <RunBadge status={lastRun.status} />
              <Text className="text-xs text-foreground-muted">
                {relativeTime(lastRun.createdAt)} ago
              </Text>
            </>
          ) : (
            <Text className="text-xs text-foreground-muted">Never run</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function RunRow({
  environmentId,
  run,
  first,
  now,
  canEdit,
  onOpen,
  onCancel,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
  readonly first: boolean;
  readonly now: number;
  readonly canEdit: boolean;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  const title = useWorkflowRunTitle(environmentId, run);
  const live = isLive(run.status);
  const statuses = useMemo(() => [...runStatuses(run)], [run]);
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${first ? "" : "border-t border-border-subtle"}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open run: ${title}, ${RUN_LABEL[run.status]}`}
        onPress={onOpen}
        className="flex-1 gap-1 active:opacity-60"
      >
        <View className="flex-row items-center gap-2">
          <RunBadge status={run.status} />
          <Text className="ml-auto text-xs tabular-nums text-foreground-muted">
            {workflowElapsed(run.createdAt, run.completedAt, now)}
          </Text>
        </View>
        <Text numberOfLines={1} className="text-sm">
          {title}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-xs text-foreground-muted">
            {run.snapshot.name} · {relativeTime(run.createdAt)} ago ·{" "}
            {run.agents.length === 1 ? "1 agent" : `${run.agents.length} agents`}
          </Text>
          <View className="flex-row items-center gap-1" accessibilityElementsHidden>
            {statuses.map(([id, status]) => (
              <View
                key={id}
                className="size-2 rounded-full"
                style={{
                  backgroundColor: STATUS_COLORS[status],
                  opacity: status === "planned" ? 0.4 : 1,
                }}
              />
            ))}
          </View>
        </View>
      </Pressable>
      <ControlPillMenu
        accessibilityLabel="Run actions"
        actions={[
          live
            ? {
                id: "cancel",
                title: "Cancel run",
                image: "stop",
                attributes: { disabled: !canEdit },
              }
            : {
                id: "delete",
                title: "Remove from list",
                image: "trash",
                attributes: { destructive: true, disabled: !canEdit },
              },
        ]}
        onPressAction={({ nativeEvent }) =>
          nativeEvent.event === "cancel" ? onCancel() : onDelete()
        }
      >
        <MoreButton label="Run actions" />
      </ControlPillMenu>
    </View>
  );
}

import {
  agentChatTarget,
  layoutWorkflow,
  rollupWorkflowRun,
  validateWorkflow,
} from "@t3tools/shared/workflows";
import { useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useIsFocused,
  usePreventRemove,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  WorkflowNodeId,
  type ModelSelection,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowCompileResult,
} from "@t3tools/contracts";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { buildModelOptions } from "../../lib/modelOptions";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useWorkflowRunTitle } from "./useWorkflowRunTitle";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { WorkflowCanvas } from "./WorkflowCanvas";
import {
  useWorkflowAgentSelection,
  WorkflowAgentSheet,
  WorkflowNeedsStrip,
} from "./WorkflowRunCockpit";
import {
  WorkflowButton,
  WorkflowField,
  WorkflowModelPicker,
  WorkflowNodeSheet,
  WorkflowSheet,
} from "./WorkflowSheets";
import {
  compileWorkflow,
  mutateWorkflow,
  startWorkflow,
  useWorkflowsEnabled,
  workflowsState,
} from "./state";
import {
  addWorkflowAgent,
  deleteWorkflowBranch,
  workflowElapsed,
  saveWorkflowNode,
} from "./viewModel";
import {
  decideWorkflowDraftRestore,
  loadWorkflowDraft,
  removeWorkflowDraft,
  saveWorkflowDraft,
} from "./workflowDrafts";

type Params =
  | { readonly environmentId?: string; readonly workflowId?: string; readonly runId?: string }
  | undefined;

function failureText(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : String(cause);
}

function WorkflowEditor({
  workflow,
  environmentId,
  connected,
}: {
  workflow: WorkflowDefinition;
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const navigation = useNavigation();
  const [draft, setDraft] = useState(workflow);
  const [saved, setSaved] = useState(workflow);
  // Identity, like the web editor: every edit spreads a fresh doc, a save adopts it.
  const dirty = draft !== saved;
  const changedElsewhere = workflow.updatedAt !== saved.updatedAt && workflow !== draft;
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const touchedRef = useRef(false);
  const discardedRef = useRef(false);
  const restoredRef = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const applyDraft = useCallback((value: WorkflowDefinition) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const applySaved = useCallback((value: WorkflowDefinition) => {
    savedRef.current = value;
    setSaved(value);
  }, []);
  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(
      "Discard unsaved changes?",
      "Save this workflow before leaving to keep your edits.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            discardedRef.current = true;
            void removeWorkflowDraft(environmentId, workflow.id).catch(() => {});
            navigation.dispatch(data.action);
          },
        },
      ],
    );
  });
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [sheet, setSheet] = useState<"ai" | "start" | null>(null);
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState("");
  const [proposal, setProposal] = useState<WorkflowCompileResult | null>(null);
  const [compileModel, setCompileModel] = useState<ModelSelection | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [issues, setIssues] = useState<readonly WorkflowIssue[]>(validateWorkflow(workflow));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mutate = useAtomCommand(mutateWorkflow, { reportFailure: false });
  const compile = useAtomCommand(compileWorkflow, { reportFailure: false });
  const start = useAtomCommand(startWorkflow, { reportFailure: false });
  const permission = useAtomValue(mutateWorkflow.permissionAtom(environmentId));
  const compilePermission = useAtomValue(compileWorkflow.permissionAtom(environmentId));
  const startPermission = useAtomValue(startWorkflow.permissionAtom(environmentId));
  const editable = connected && permission && !busy && !proposal;
  const config = useEnvironmentServerConfig(environmentId);
  const defaultModel =
    buildModelOptions(config, null, undefined, null).find(
      (option) => !option.isUnavailable && !option.isHidden,
    )?.selection ?? null;
  const change = (value: WorkflowDefinition) => {
    touchedRef.current = true;
    applyDraft({ ...value, updatedAt: new Date().toISOString() });
    setIssues(validateWorkflow(value));
    setError(null);
  };
  const operate = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const save = useCallback(async (): Promise<boolean> => {
    // One save at a time, so an older copy can never land after a newer one.
    while (savingRef.current) await savingRef.current;
    const current = draftRef.current;
    if (current === savedRef.current) return true;
    if (!connected || !permission) return false;
    const run = (async () => {
      const result = await mutate({ environmentId, input: { type: "save", workflow: current } });
      setError(failureText(result));
      if (result._tag !== "Success") return false;
      applySaved(current);
      void removeWorkflowDraft(environmentId, current.id).catch(() => {});
      return true;
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  }, [applySaved, connected, environmentId, mutate, permission]);
  // Autosave shortly after edits settle, like the web editor.
  useEffect(() => {
    if (draft === saved || !connected || !permission || changedElsewhere) return;
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [changedElsewhere, connected, draft, permission, save, saved]);
  // A draft left by a killed app comes back once, unless the user already typed.
  useEffect(() => {
    if (restoredRef.current) return;
    let cancelled = false;
    void loadWorkflowDraft(environmentId, workflow.id).then((stored) => {
      if (cancelled || restoredRef.current) return;
      restoredRef.current = true;
      if (stored === null || touchedRef.current) return;
      const decision = decideWorkflowDraftRestore(workflow, stored);
      if (decision.kind === "none") {
        void removeWorkflowDraft(environmentId, workflow.id).catch(() => {});
        return;
      }
      applyDraft(decision.draft);
      applySaved(decision.saved);
      setIssues(validateWorkflow(decision.draft));
    });
    return () => {
      cancelled = true;
    };
  }, [applyDraft, applySaved, environmentId, workflow]);
  // Keep the dirty draft on disk so an app kill mid-edit loses nothing.
  useEffect(() => {
    if (draft === saved) return;
    const timer = setTimeout(() => {
      void saveWorkflowDraft(environmentId, workflow.id, { base: saved, draft }).catch(
        (error: unknown) => {
          console.warn("[workflow-drafts] could not persist the draft", error);
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, environmentId, saved, workflow.id]);
  // Land the last edits before iOS suspends the editor or navigation unmounts it.
  useEffect(() => {
    const flush = () => {
      const current = draftRef.current;
      if (discardedRef.current || current === savedRef.current) return;
      void saveWorkflowDraft(environmentId, workflow.id, {
        base: savedRef.current,
        draft: current,
      }).catch((error: unknown) => {
        console.warn("[workflow-drafts] could not flush the draft", error);
      });
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [environmentId, workflow.id]);
  const resolve = () =>
    void operate(async () => {
      const result = await compile({
        environmentId,
        input: {
          workflow: draft,
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(compileModel ? { model: compileModel } : {}),
        },
      });
      if (result._tag === "Success") {
        setProposal(result.value);
        setIssues(result.value.issues);
        setSheet(null);
      } else setError(failureText(result));
    });
  const startRun = () =>
    void operate(async () => {
      const validation = validateWorkflow(draft);
      setIssues(validation);
      if (validation.length) {
        setError("Fix the issues in this workflow before starting.");
        return;
      }
      if (!(await save())) return;
      const result = await start({
        environmentId,
        input: { workflowId: draft.id, task: task.trim() },
      });
      if (result._tag === "Success") {
        setSheet(null);
        navigation.dispatch(
          StackActions.push("Workflows", { environmentId, runId: result.value.runId }),
        );
      } else setError(failureText(result));
    });
  const addChild = (parentId: WorkflowNodeId | null) => {
    if (draft.nodes.length >= 64) {
      setError("Use at most 64 nodes.");
      return;
    }
    const next = addWorkflowAgent(draft, uuidv4(), parentId, defaultModel);
    change(next);
    const added = next.nodes.at(-1);
    if (added) setNode(added);
  };
  // A blank canvas is not a mistake yet; Start still checks it.
  const shownIssues = draft.nodes.some((entry) => entry.kind === "agent") ? issues : [];
  const changedIds =
    proposal?.workflow.nodes
      .filter(
        (entry) =>
          JSON.stringify(entry) !==
          JSON.stringify(draft.nodes.find((current) => current.id === entry.id)),
      )
      .map((entry) => entry.id) ?? [];
  return (
    <View className="flex-1">
      <View className="gap-2 border-b border-border bg-sheet-solid px-4 py-3">
        <Text className="text-lg font-t3-semibold">
          {draft.name}
          {dirty ? " · Edited" : ""}
        </Text>
        {changedElsewhere ? (
          <View className="gap-2">
            <Text className="text-sm text-foreground-muted">
              This workflow changed on another device.
            </Text>
            <WorkflowButton
              title="Reload saved version"
              onPress={() => {
                touchedRef.current = true;
                applyDraft(workflow);
                applySaved(workflow);
                void removeWorkflowDraft(environmentId, workflow.id).catch(() => {});
                setNode(null);
                setProposal(null);
                setIssues(validateWorkflow(workflow));
              }}
            />
          </View>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <WorkflowButton
            title={busy ? "Working…" : "Save"}
            disabled={!editable}
            onPress={() =>
              void operate(async () => {
                await save();
              })
            }
          />
          <WorkflowButton
            title="Tidy up"
            disabled={!editable}
            onPress={() => change(layoutWorkflow(draft))}
          />
          <WorkflowButton
            title="Make with AI"
            disabled={!editable || !compilePermission}
            onPress={() => setSheet("ai")}
          />
          <WorkflowButton
            title="Start"
            disabled={!editable || !startPermission}
            onPress={() => setSheet("start")}
          />
          {draft.rootNodeId === null ? (
            <WorkflowButton
              title="+ Lead"
              disabled={!editable || draft.nodes.length >= 64}
              onPress={() => addChild(null)}
            />
          ) : (
            <WorkflowButton
              title="+ Note"
              disabled={!editable || draft.nodes.length >= 64}
              onPress={() => {
                const note: WorkflowNode = {
                  kind: "note",
                  id: WorkflowNodeId.make(uuidv4()),
                  x: -260,
                  y: draft.nodes.length * 20,
                  width: 232,
                  height: 148,
                  text: "",
                  attachedTo: null,
                };
                change({ ...draft, nodes: [...draft.nodes, note] });
                setNode(note);
              }}
            />
          )}
        </View>
        {!connected ? (
          <Text className="text-sm text-foreground-muted">
            Reconnect to edit, compile or start.
          </Text>
        ) : null}
        {!permission ? (
          <Text className="text-sm text-foreground-muted">Read-only connection.</Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {proposal ? (
          <View className="gap-2">
            <Text className="text-sm">{proposal.summary}</Text>
            <Text className="text-xs text-foreground-muted">
              {changedIds.length} changed boxes highlighted
            </Text>
            <View className="flex-row gap-2">
              <WorkflowButton
                title="Apply"
                disabled={busy}
                onPress={() => {
                  change(proposal.workflow);
                  setIssues(proposal.issues);
                  setProposal(null);
                }}
              />
              <WorkflowButton
                title="Discard"
                onPress={() => {
                  setProposal(null);
                  setIssues([]);
                }}
              />
            </View>
          </View>
        ) : null}
        {shownIssues.map((issue) => (
          <Pressable
            key={`${issue.nodeId}-${issue.edgeId}-${issue.message}`}
            accessibilityRole="button"
            onPress={() => {
              const offending = draft.nodes.find((entry) => entry.id === issue.nodeId);
              if (offending && editable) setNode(offending);
            }}
          >
            <Text className="text-xs text-danger-foreground">{issue.message}</Text>
          </Pressable>
        ))}
      </View>
      <WorkflowCanvas
        environmentId={environmentId}
        workflow={proposal?.workflow ?? draft}
        issues={shownIssues}
        changedIds={changedIds}
        onNodePress={editable ? setNode : undefined}
        onAddChild={editable && draft.nodes.length < 64 ? addChild : undefined}
        onNodeDelete={
          editable
            ? (id) =>
                Alert.alert("Delete branch?", "This box and its children will be removed.", [
                  { text: "Keep", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => change(deleteWorkflowBranch(draft, id)),
                  },
                ])
            : undefined
        }
      />
      {node ? (
        <WorkflowNodeSheet
          key={node.id}
          node={node}
          workflow={draft}
          environmentId={environmentId}
          onSave={(updated, after) => change(saveWorkflowNode(draft, updated, after))}
          onClose={() => setNode(null)}
        />
      ) : null}
      {sheet === "ai" ? (
        <WorkflowSheet
          title="Make with AI"
          onClose={() => !busy && setSheet(null)}
          footer={
            <WorkflowButton
              title={busy ? "Resolving…" : "Resolve drawing"}
              disabled={
                busy ||
                !connected ||
                !compilePermission ||
                (!prompt.trim() && draft.nodes.length === 0)
              }
              onPress={resolve}
            />
          }
        >
          <WorkflowField
            label="Describe your team"
            value={prompt}
            onChange={setPrompt}
            multiline
            maxLength={8000}
          />
          <Text className="text-sm text-foreground-muted">
            For example: Opus leads, two Sol workers, each with many Haiku agents.
          </Text>
          <WorkflowButton
            title={compileModel?.model ?? "Compile model: default"}
            onPress={() => setModelOpen(true)}
          />
          {error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </WorkflowSheet>
      ) : null}
      {sheet === "start" ? (
        <WorkflowSheet
          title="Start workflow"
          onClose={() => !busy && setSheet(null)}
          footer={
            <WorkflowButton
              title={busy ? "Starting…" : "Start"}
              disabled={busy || !task.trim() || !connected || !startPermission}
              onPress={startRun}
            />
          }
        >
          <WorkflowField label="Task" value={task} onChange={setTask} multiline maxLength={20000} />
          {error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </WorkflowSheet>
      ) : null}
      {modelOpen ? (
        <WorkflowModelPicker
          environmentId={environmentId}
          selection={compileModel}
          onSelect={setCompileModel}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </View>
  );
}

function WorkflowRunView({
  run,
  environmentId,
  connected,
}: {
  run: WorkflowRun;
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const runTitle = useWorkflowRunTitle(environmentId, run);
  const navigation = useNavigation();
  const mutate = useAtomCommand(mutateWorkflow, { reportFailure: false });
  const permission = useAtomValue(mutateWorkflow.permissionAtom(environmentId));
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const focused = useIsFocused();
  const status =
    run.agents.length && ["starting", "running", "waiting"].includes(run.status)
      ? rollupWorkflowRun(run.agents, run.leadThreadId)
      : run.status;
  const live = run.status === "starting" || run.status === "running" || run.status === "waiting";
  useEffect(() => {
    if (!live || !focused) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focused, live]);
  const { environments } = useWorkspaceState();
  const openThread = (threadId: string, threadLink: string | null = null) => {
    // The cockpit sheet passes only the id; remote agents still need their link.
    const link =
      threadLink ?? run.agents.find((agent) => agent.threadId === threadId)?.threadLink ?? null;
    const target = agentChatTarget({ threadId, threadLink: link }, environmentId, (id) =>
      environments.some(
        (entry) => entry.environmentId === id && entry.connectionState === "connected",
      ),
    );
    if (target.kind === "web") {
      void tryOpenExternalUrl(target.url, "workflow-agent");
      return;
    }
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: target.environmentId,
        threadId: target.threadId,
      }),
    );
  };
  const cockpit = useWorkflowAgentSelection(run, openThread);
  return (
    <View className="flex-1">
      <View className="gap-2 border-b border-border bg-sheet-solid px-4 py-3">
        <Text className="text-lg font-t3-semibold">{runTitle}</Text>
        <Text numberOfLines={3} className="text-sm text-foreground-muted">
          {run.snapshot.name} · {run.task}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {status} · {workflowElapsed(run.createdAt, run.completedAt, now)} · {run.agents.length}{" "}
          agents
        </Text>
        <View className="flex-row gap-2">
          <WorkflowButton
            title="Open lead chat"
            disabled={!connected}
            onPress={() => openThread(run.leadThreadId)}
          />
          {live ? (
            <WorkflowButton
              title={cancelling ? "Cancelling…" : "Cancel run"}
              danger
              disabled={!connected || !permission || cancelling}
              onPress={() => {
                setCancelling(true);
                void mutate({ environmentId, input: { type: "cancelRun", runId: run.id } }).then(
                  (result) => {
                    setError(failureText(result));
                    setCancelling(false);
                  },
                );
              }}
            />
          ) : null}
        </View>
        {error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {!connected ? (
          <Text className="text-sm text-foreground-muted">
            Disconnected. Showing the last run state.
          </Text>
        ) : null}
        <Text className="text-xs text-foreground-muted">
          Pinch to zoom. Tap an agent to steer, stop or open it.
        </Text>
      </View>
      <WorkflowNeedsStrip agents={cockpit.needing} onOpen={(agent) => openThread(agent.threadId)} />
      <WorkflowCanvas
        environmentId={environmentId}
        workflow={run.snapshot}
        run={run}
        now={now}
        onThreadPress={cockpit.select}
        selectedThreadId={cockpit.agent?.threadId ?? null}
        onNodePress={() =>
          Alert.alert("Agent not started", "This box will open its chat once its parent starts it.")
        }
      />
      {cockpit.agent ? (
        <WorkflowAgentSheet
          environmentId={environmentId}
          run={run}
          agent={cockpit.agent}
          connected={connected}
          now={now}
          onOpenChat={(agent) => openThread(agent.threadId)}
          onClose={cockpit.close}
        />
      ) : null}
    </View>
  );
}

function WorkflowDetail({
  environmentId,
  connected,
  workflowId,
  runId,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
  workflowId?: string;
  runId?: string;
}) {
  const query = useEnvironmentQuery(workflowsState({ environmentId, input: {} }));
  const workflow = query.data?.workflows.find((entry) => entry.id === workflowId);
  const run = query.data?.runs.find((entry) => entry.id === runId);
  if (query.data === null)
    return (
      <Text
        accessibilityRole={query.error ? "alert" : undefined}
        className="p-5 text-foreground-muted"
      >
        {query.error ?? (connected ? "Loading workflow…" : "Reconnect to load this workflow.")}
      </Text>
    );
  if (runId && run)
    return <WorkflowRunView run={run} environmentId={environmentId} connected={connected} />;
  if (workflow)
    return (
      <WorkflowEditor
        key={workflow.id}
        workflow={workflow}
        environmentId={environmentId}
        connected={connected}
      />
    );
  return (
    <Text className="p-5 text-foreground-muted">
      This {runId ? "run" : "workflow"} is no longer available.
    </Text>
  );
}

export function WorkflowsRouteScreen({ route }: StaticScreenProps<Params>) {
  const { environments: allEnvironments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const environments = allEnvironments.filter(
    (entry) => configs.get(entry.environmentId)?.settings.workflowsBeta === true,
  );
  const [selected, setSelected] = useState(route.params?.environmentId ?? null);
  const environment =
    environments.find((entry) => entry.environmentId === selected) ??
    (selected === null
      ? (environments.find((entry) => entry.connectionState === "connected") ?? environments[0])
      : undefined);
  const environmentId = environment?.environmentId;
  const [enabled] = useWorkflowsEnabled(environmentId);
  if (selected === null && environmentId) setSelected(environmentId);
  // iOS draws the native header over the screen. The library scrolls under it with
  // automatic insets; the editor, run view and environment picker sit below it.
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? insets.top + 44;
  const detail = Boolean(route.params?.workflowId || route.params?.runId);
  const picker = environments.length > 1 && !detail;
  const topInset = Platform.OS === "ios" && (detail || picker) ? headerHeight : 0;
  return (
    <SettingsScreen title="Workflows">
      {!enabled ? (
        <Text className="p-5 text-foreground-muted">
          Enable Workflows in Settings → Beta to continue.
        </Text>
      ) : !environmentId ? (
        <Text className="p-5 text-foreground-muted">
          Connect to an environment to use workflows.
        </Text>
      ) : (
        <View className="flex-1" style={{ paddingTop: topInset }}>
          {picker ? (
            <View className="px-5 pt-3">
              <ControlPillMenu
                title="Workflows environment"
                actions={environments.map((entry) => ({
                  id: entry.environmentId,
                  title: entry.environmentLabel,
                  state: entry.environmentId === environmentId ? "on" : "off",
                }))}
                onPressAction={({ nativeEvent }) => setSelected(nativeEvent.event)}
              >
                <ControlPill
                  variant="pill"
                  label={environment.environmentLabel}
                  icon="chevron.down"
                />
              </ControlPillMenu>
            </View>
          ) : null}
          {route.params?.workflowId || route.params?.runId ? (
            <WorkflowDetail
              environmentId={EnvironmentId.make(environmentId)}
              connected={environment.connectionState === "connected"}
              workflowId={route.params.workflowId}
              runId={route.params.runId}
            />
          ) : (
            <WorkflowLibrary
              key={environmentId}
              environmentId={EnvironmentId.make(environmentId)}
              connected={environment.connectionState === "connected"}
            />
          )}
        </View>
      )}
    </SettingsScreen>
  );
}

import {
  CommandId,
  ComposerContextId,
  MessageId,
  ProjectId,
  ThreadId,
  WorkflowRunId,
  WorkflowsError,
  WorkflowsState,
  type WorkflowCompileRequest,
  type WorkflowCompileResult,
  type WorkflowOperation,
  type WorkflowStartRequest,
  type WorkflowStartResult,
  WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowContextRecord,
  type OrchestrationMessageContext,
  ModelSelection,
  NodeId,
  RunId,
  RuntimeMode,
  ProviderInteractionMode,
  OrchestrationV2WorkspacePreparation,
  type OrchestrationV2ServerCommand,
  OrchestratorMcpDelegateTaskInput,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  compactWorkflowPlan,
  rollupWorkflowRun,
  validateWorkflow,
  withRunLabels,
  workflowRunDiagnostics,
} from "@t3tools/shared/workflows";
import { sketchCountTag, sketchTitle } from "@t3tools/shared/workflowSketch";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { type DelegateTaskDetails } from "../mcp/delegateTaskDetails.ts";
import { pendingTaskNeeds } from "../mcp/pendingTaskRequests.ts";
import { resolveRuntimeMode, resolveInteractionMode } from "../mcp/delegationModes.ts";
import * as Rankings from "../subagentRankings/SubagentRankings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import { parseWorkflowCompile, workflowCompileModel, workflowCompilePrompt } from "./compile.ts";
import { planWorkflowDelegation } from "./delegation.ts";
import { registerWorkflowsAgentAccess, setWorkflowsBetaEnabled } from "./workflowsBeta.ts";

export class WorkflowsService extends Context.Service<
  WorkflowsService,
  {
    readonly subscribe: (input?: {
      readonly leadThreadId?: ThreadId;
    }) => Stream.Stream<WorkflowsState, WorkflowsError>;
    readonly mutate: (operation: WorkflowOperation) => Effect.Effect<void, WorkflowsError>;
    readonly compile: (
      input: WorkflowCompileRequest,
    ) => Effect.Effect<WorkflowCompileResult, WorkflowsError>;
    readonly start: (
      input: WorkflowStartRequest,
    ) => Effect.Effect<WorkflowStartResult, WorkflowsError>;
    /** An agent's run: `spawn` creates the lead as the caller's subagent, so its result wakes the caller. */
    readonly startChild: <E, R>(
      input: {
        readonly workflowId: WorkflowStartRequest["workflowId"];
        readonly task: string;
        readonly key: string;
        readonly leadThreadId: ThreadId;
        readonly parentThreadId?: ThreadId;
      },
      spawn: (lead: OrchestratorMcpDelegateTaskInput) => Effect.Effect<DelegateTaskDetails, E, R>,
    ) => Effect.Effect<
      DelegateTaskDetails & { readonly runId: WorkflowRunId },
      E | WorkflowsError,
      R
    >;
    /** Wrap only creation, never a blocking wait, so child boxes can delegate immediately. */
    readonly delegate: <E, R>(
      threadId: ThreadId,
      key: string,
      input: OrchestratorMcpDelegateTaskInput,
      inherited: ModelSelection,
      execute: (
        input: OrchestratorMcpDelegateTaskInput,
        context?: WorkflowContextRecord,
        admit?: (command: DelegationCommand) => Effect.Effect<void, WorkflowsError>,
      ) => Effect.Effect<DelegateTaskDetails, E, R>,
      context?: OrchestrationMessageContext,
    ) => Effect.Effect<DelegateTaskDetails, E | WorkflowsError, R>;
    readonly refresh: Effect.Effect<void, WorkflowsError>;
    /**
     * After an agent saves a workflow: its name is only a seed, replaced by a
     * generated one, unless the user had named the workflow themselves.
     */
    readonly agentSaved: (
      workflowId: WorkflowDefinition["id"],
      previousName: string | undefined,
    ) => Effect.Effect<void>;
  }
>()("t3/workflows/WorkflowsService") {}

type DelegationCommand = Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>;
const launchDetails = Schema.Struct({
  parentRunId: RunId,
  parentNodeId: NodeId,
  task: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: Schema.optional(OrchestrationV2WorkspacePreparation),
});
// A JSON write-ahead record: identity and capacity are saved before any child can run.
const Admission = Schema.Struct({
  key: Schema.String,
  runId: WorkflowRunId,
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  projectId: Schema.optionalKey(ProjectId),
  reuseThread: Schema.optionalKey(Schema.Boolean),
  input: OrchestratorMcpDelegateTaskInput,
  command: Schema.optionalKey(launchDetails),
  launched: Schema.Boolean,
  stopped: Schema.optionalKey(Schema.Boolean),
  stopApplied: Schema.optionalKey(Schema.Boolean),
  noticePending: Schema.optionalKey(Schema.Boolean),
});
type Admission = typeof Admission.Type;
const storedSchema = Schema.Struct({
  ...WorkflowsState.fields,
  activeRuns: Schema.optionalKey(Schema.Array(WorkflowRun)),
  admissions: Schema.optionalKey(Schema.Array(Admission)),
  // Retry keys are private persistence, never sent to clients or agents.
  receipts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, threadId: ThreadId })),
  ),
  starts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, runId: WorkflowRunId })),
  ),
  // Names the server gave (or an agent seeded); a different current name is the user's own.
  autoNamed: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, content: Schema.String })),
  ),
});
const storedJson = Schema.fromJsonString(storedSchema);
const decodeStored = Schema.decodeEffect(storedJson);
const encodeStored = Schema.encodeEffect(storedJson);
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const live = (status: string) => ["pending", "running", "waiting"].includes(status);
const activeRun = (run: WorkflowRun) =>
  !terminal(run.status) || run.agents.some((agent) => !terminal(agent.status));

const MAX_FINISHED_RUNS = 200;
/**
 * The run history kept: every run still going (its membership enforces the
 * drawing), plus the newest finished ones. Order is kept, newest first.
 */
export function retainWorkflowRuns<
  R extends {
    readonly status: string;
    readonly agents?: ReadonlyArray<{ readonly status: string }>;
  },
>(runs: ReadonlyArray<R>): ReadonlyArray<R> {
  let finished = 0;
  return runs.filter(
    (run) =>
      ["starting", "running", "waiting"].includes(run.status) ||
      run.agents?.some((agent) => !terminal(agent.status)) ||
      ++finished <= MAX_FINISHED_RUNS,
  );
}

/** A run's chat title from its task's first line ("Lead: Fix the tests" with a prefix), at most 80 characters. */
const UNTITLED_WORKFLOW = "Untitled workflow";

/** What a name describes: changes here (not positions) earn a new generated name. */
function workflowNamingContent(workflow: WorkflowDefinition): string {
  return JSON.stringify([
    workflow.description,
    workflow.nodes.map((node) =>
      node.kind === "agent"
        ? [node.label, node.text, node.model?.model ?? null, node.instructions, node.count]
        : [node.text],
    ),
  ]);
}

function workflowNamingPrompt(workflow: WorkflowDefinition): string {
  const labels = new Map(workflow.nodes.map((node) => [node.id, sketchTitle(node)]));
  const lines = workflow.nodes.flatMap((node) => {
    if (node.kind !== "agent") return node.text.trim() ? [`- Note: ${node.text.trim()}`] : [];
    const parent = workflow.edges.find((edge) => edge.to === node.id && edge.kind === "delegates");
    const count = sketchCountTag(node);
    const brief = (node.instructions || node.text).trim().replace(/\s+/g, " ").slice(0, 160);
    return [
      `- ${labels.get(node.id)}${count ? ` (${count})` : ""}${node.model ? ` on ${node.model.model}` : ""}${parent ? `, started by ${labels.get(parent.from)}` : ", leads"}${brief ? `: ${brief}` : ""}`,
    ];
  });
  return [
    'Name this saved team of AI agents the way a chat gets its title: 2 to 5 words, Title Case, specific to what the team does or how it is built. No quotes, no final period, no word "workflow". Reply with the name only.',
    "",
    ...(workflow.description.trim() ? [`Description: ${workflow.description.trim()}`] : []),
    `Current name: ${workflow.name}`,
    "Agents:",
    ...lines,
  ].join("\n");
}

function cleanWorkflowName(output: string): string | null {
  const line = output
    .split("\n")
    .map((candidate) => candidate.replace(/^[#*\s"'`“”]+|[\s"'`“”*.]+$/g, "").trim())
    .find(Boolean);
  if (!line || line === UNTITLED_WORKFLOW) return null;
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

function runTitleSeed(task: string, fallback: string, prefix?: string): string {
  const line =
    task
      .split("\n")
      .find((candidate) => candidate.trim())
      ?.trim() ?? "";
  const title = prefix && line ? `${prefix}: ${line}` : line || fallback;
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* Threads.ThreadManagementService;
  const launch = yield* Launch.ThreadLaunchService;
  const folders = yield* Folders.ManagedProjectFolders;
  const providers = yield* Providers.ProviderRegistry;
  const generation = yield* Generation.TextGeneration;
  const rankings = yield* Effect.serviceOption(Rankings.SubagentRankings);
  const projects = yield* Effect.serviceOption(Projects.ProjectService);
  const git = yield* Effect.serviceOption(Git.GitVcsDriver);
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const layerScope = yield* Effect.scope;
  const filePath = path.join(config.stateDir, "workflows.json");
  const empty: typeof storedSchema.Type = { version: 1, workflows: [], runs: [] };
  const loadStored = Effect.gen(function* () {
    const contents = yield* fs.readFileString(filePath).pipe(
      Effect.catchIf(
        (e) => e._tag === "PlatformError" && e.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError(
        () => new WorkflowsError({ reason: "read", message: "Could not read workflows." }),
      ),
    );
    const loaded =
      contents === undefined
        ? empty
        : yield* decodeStored(contents).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const names = new Set(
                  yield* fs.readDirectory(config.stateDir).pipe(
                    Effect.mapError(
                      () =>
                        new WorkflowsError({
                          reason: "read",
                          message: "Could not preserve invalid workflows.",
                        }),
                    ),
                  ),
                );
                let backup = "workflows.json.unreadable",
                  i = 0;
                while (names.has(backup)) backup = `workflows.json.unreadable.${++i}`;
                yield* fs.rename(filePath, path.join(config.stateDir, backup)).pipe(
                  Effect.mapError(
                    () =>
                      new WorkflowsError({
                        reason: "read",
                        message: "Could not preserve invalid workflows.",
                      }),
                  ),
                );
                yield* Effect.logWarning("Invalid workflows were preserved; starting empty.");
                return empty;
              }),
            ),
          );
    if (loaded.activeRuns === undefined) return loaded;
    const seen = new Set<WorkflowRunId>();
    const runs = [...loaded.activeRuns, ...loaded.runs]
      .filter((run) => {
        if (seen.has(run.id)) return false;
        seen.add(run.id);
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { ...loaded, runs };
  });
  const loaded = yield* loadStored.pipe(Effect.result);
  let storageError = loaded._tag === "Failure" ? loaded.failure : undefined;
  const initial = loaded._tag === "Success" ? loaded.success : empty;
  if (Option.isSome(serverSettings)) {
    const settings = yield* serverSettings.value.getSettings.pipe(
      Effect.mapError(
        () => new WorkflowsError({ reason: "read", message: "Could not read workflow settings." }),
      ),
    );
    setWorkflowsBetaEnabled(settings.workflowsBeta === true);
    const changes = yield* serverSettings.value.subscribeChanges;
    yield* changes.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => setWorkflowsBetaEnabled(settings.workflowsBeta === true)),
      ),
      Effect.forkScoped,
    );
  } else setWorkflowsBetaEnabled(false);
  const state = yield* SubscriptionRef.make<WorkflowsState>({
    version: 1,
    workflows: initial.workflows,
    runs: retainWorkflowRuns(initial.runs).map((run) => ({
      ...run,
      diagnostics: workflowRunDiagnostics(run),
    })),
  });
  const receipts = new Map(initial.receipts?.map((r) => [r.key, r.threadId]));
  const autoNamed = new Map(
    initial.autoNamed?.map((entry) => [entry.id, { name: entry.name, content: entry.content }]),
  );
  const starts = new Map(initial.starts?.map((entry) => [entry.key, entry.runId]));
  const admissions = new Map(initial.admissions?.map((a) => [a.key, a]));
  const launching = new Set<string>();
  const threadAdmissions = new Map<ThreadId, Admission>();
  // Policy ownership is indexed independently of the bounded history presented to clients.
  const activeMembership = new Map<ThreadId, WorkflowRun>();
  const closedMembership = new Set<ThreadId>();
  const taskMembership = new Map<NodeId, WorkflowRunId>();
  const indexMembership = (runs: ReadonlyArray<WorkflowRun>) => {
    threadAdmissions.clear();
    for (const admission of admissions.values()) {
      threadAdmissions.set(admission.threadId, admission);
      if (admission.parentThreadId)
        taskMembership.set(
          derive.delegatedTaskNode({ commandId: CommandId.make(admission.key) }),
          admission.runId,
        );
    }
    activeMembership.clear();
    closedMembership.clear();
    for (const run of runs) {
      const active = activeRun(run);
      for (const agent of run.agents) {
        if (active) activeMembership.set(agent.threadId, run);
        else if (run.origin === "workflows" || agent.threadId !== run.leadThreadId)
          closedMembership.add(agent.threadId);
      }
    }
  };
  indexMembership(initial.runs);
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const save = (next: WorkflowsState) =>
    Effect.gen(function* () {
      const unchanged = new Set((yield* SubscriptionRef.get(state)).runs);
      const bounded = {
        ...next,
        runs: retainWorkflowRuns(next.runs).map((run) =>
          unchanged.has(run) ? run : { ...run, diagnostics: workflowRunDiagnostics(run) },
        ),
      };
      const ids = new Set(bounded.runs.flatMap((r) => r.agents.map((a) => a.threadId)));
      const storedReceipts = [...receipts]
        .filter(([, id]) => ids.has(id))
        .map(([key, threadId]) => ({ key, threadId }));
      const workflowIds = new Set(bounded.workflows.map((w) => w.id as string));
      const contents = yield* encodeStored({
        ...bounded,
        // Live execution is durable independently of the terminal history limit.
        activeRuns: bounded.runs.filter(activeRun),
        runs: bounded.runs.filter((run) => !activeRun(run)),
        receipts: storedReceipts,
        admissions: [...admissions.values()].filter((a) => ids.has(a.threadId)),
        starts: [...starts]
          .filter(([, id]) => bounded.runs.some((r) => r.id === id))
          .map(([key, runId]) => ({ key, runId })),
        autoNamed: [...autoNamed]
          .filter(([id]) => workflowIds.has(id))
          .map(([id, entry]) => ({ id, ...entry })),
      }).pipe(
        Effect.mapError(
          () => new WorkflowsError({ reason: "write", message: "Could not encode workflows." }),
        ),
      );
      yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          () => new WorkflowsError({ reason: "write", message: "Could not save workflows." }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            indexMembership(bounded.runs);
            for (const [key, id] of receipts) if (!ids.has(id)) receipts.delete(key);
            for (const [key, admission] of admissions)
              if (!ids.has(admission.threadId)) admissions.delete(key);
            const kept = new Set(bounded.runs.map((run) => run.id));
            for (const [taskId, id] of taskMembership)
              if (!kept.has(id)) taskMembership.delete(taskId);
            for (const [key, id] of starts) if (!kept.has(id)) starts.delete(key);
          }),
        ),
        Effect.andThen(SubscriptionRef.set(state, bounded)),
        Effect.uninterruptible,
      );
    });
  const ensureStorage = lock.withPermits(1)(
    Effect.gen(function* () {
      if (storageError === undefined) return;
      const restored = yield* loadStored.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            storageError = error;
          }),
        ),
      );
      admissions.clear();
      for (const admission of restored.admissions ?? []) admissions.set(admission.key, admission);
      receipts.clear();
      for (const receipt of restored.receipts ?? []) receipts.set(receipt.key, receipt.threadId);
      starts.clear();
      for (const start of restored.starts ?? []) starts.set(start.key, start.runId);
      autoNamed.clear();
      for (const entry of restored.autoNamed ?? [])
        autoNamed.set(entry.id, { name: entry.name, content: entry.content });
      const runs = retainWorkflowRuns(restored.runs).map((run) => ({
        ...run,
        diagnostics: workflowRunDiagnostics(run),
      }));
      indexMembership(runs);
      yield* SubscriptionRef.set(state, { version: 1, workflows: restored.workflows, runs });
      storageError = undefined;
    }),
  );
  const requireEnabled = Effect.gen(function* () {
    const settings = Option.isSome(serverSettings)
      ? yield* serverSettings.value.getSettings.pipe(
          Effect.mapError(
            () =>
              new WorkflowsError({ reason: "read", message: "Could not read workflow settings." }),
          ),
        )
      : undefined;
    if (settings?.workflowsBeta !== true)
      return yield* new WorkflowsError({
        reason: "start",
        message: "Workflows are off on this server.",
      });
  });
  const update = (f: (s: WorkflowsState) => WorkflowsState) =>
    lock.withPermits(1)(
      SubscriptionRef.get(state).pipe(
        Effect.flatMap((s) => {
          const next = f(s);
          return next === s ? Effect.void : save(next);
        }),
      ),
    );

  // Workflows get chat-style names from the chat title model, like chats do: an
  // untitled one once it has agents, an agent-saved one (its name is a seed), and
  // again when a generated one's agents change. A name the user typed stays.
  const autoNameable = (workflow: WorkflowDefinition) =>
    workflow.name === UNTITLED_WORKFLOW || autoNamed.get(workflow.id)?.name === workflow.name;
  const namingFibers = new Map<string, Fiber.Fiber<void>>();
  const nameWorkflow = (workflowId: WorkflowDefinition["id"]) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings) || !generation.rewriteProse) return;
      const workflow = (yield* SubscriptionRef.get(state)).workflows.find(
        (w) => w.id === workflowId,
      );
      if (!workflow || !autoNameable(workflow)) return;
      const seed = workflow.name;
      const content = workflowNamingContent(workflow);
      const { output } = yield* generation.rewriteProse({
        cwd: config.stateDir,
        modelSelection: (yield* serverSettings.value.getSettings).textGenerationModelSelection,
        prompt: workflowNamingPrompt(workflow),
      });
      const name = cleanWorkflowName(output);
      yield* update((s) => {
        const current = s.workflows.find((w) => w.id === workflowId);
        // Renamed or edited meanwhile: that save scheduled its own naming.
        if (!current || current.name !== seed || workflowNamingContent(current) !== content)
          return s;
        autoNamed.set(workflowId, { name: name ?? seed, content });
        return name === null || name === seed
          ? s
          : { ...s, workflows: s.workflows.map((w) => (w.id === workflowId ? { ...w, name } : w)) };
      });
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("workflows.naming-failed", { cause })));
  const scheduleNaming = (workflowId: WorkflowDefinition["id"]) =>
    Effect.gen(function* () {
      const workflow = (yield* SubscriptionRef.get(state)).workflows.find(
        (w) => w.id === workflowId,
      );
      if (
        !workflow ||
        !autoNameable(workflow) ||
        !workflow.nodes.some(
          (n) => n.kind === "agent" && (n.label.trim() || n.text.trim() || n.model !== null),
        ) ||
        autoNamed.get(workflowId)?.content === workflowNamingContent(workflow)
      )
        return;
      const previous = namingFibers.get(workflowId);
      if (previous) yield* Fiber.interrupt(previous);
      // Editors save on every change; name once they pause.
      const fiber = yield* nameWorkflow(workflowId).pipe(
        Effect.delay("4 seconds"),
        Effect.forkIn(layerScope),
      );
      namingFibers.set(workflowId, fiber);
    });

  const refreshRuns = (ids?: ReadonlySet<WorkflowRunId>) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (!current.runs.length) return;
          const scratchRoot = Option.getOrUndefined(
            yield* Effect.suspend(() => folders.scratchRoot).pipe(
              Effect.catchCause(() => Effect.succeed(Option.none<string>())),
            ),
          );
          const inScratch = (folder: string) =>
            scratchRoot !== undefined &&
            (folder === scratchRoot || folder.startsWith(`${scratchRoot.replace(/\/+$/, "")}/`));
          const timestamp = yield* now;
          const grades = Option.isSome(rankings)
            ? new Map((yield* rankings.value.getSnapshot()).thumbs.map((r) => [r.taskId, r.grade]))
            : new Map<NodeId, number | undefined>();
          const runs: WorkflowRun[] = [];
          for (const run of current.runs) {
            const settled = terminal(run.status) && run.agents.every((a) => terminal(a.status));
            if (ids && !ids.has(run.id)) {
              runs.push(run);
              continue;
            }
            const agents = [...run.agents];
            // Walk mapped threads: nested subagents belong to the same run, never to another branch.
            for (let i = 0; i < agents.length; i++) {
              const agent = agents[i]!;
              if (agent.threadLink) continue;
              const projection = yield* threads
                .getThreadRecords(agent.threadId, ["runs", "subagents", "runtimeRequests"])
                .pipe(Effect.option);
              if (Option.isNone(projection)) continue; // Remote threads are reflected on their local parent.
              const actual = projection.value.thread;
              const needs = pendingTaskNeeds(projection.value);
              const { needs: _needs, ...withoutNeeds } = agent;
              agents[i] = {
                ...withoutNeeds,
                ...(needs ? { needs } : {}),
                model: actual.modelSelection.model,
                instanceId: actual.modelSelection.instanceId,
                machine:
                  agent.threadId === run.leadThreadId && agent.nodeId !== run.snapshot.rootNodeId
                    ? (agent.machine ?? "local")
                    : "local",
                // A per-chat scratch folder fills worktreePath too, but it isn't a worktree.
                isolation:
                  actual.worktreePath && !inScratch(actual.worktreePath) ? "worktree" : "shared",
              };
              const latest = [...projection.value.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
              // Agents end their turn while their subagents work; that is waiting, not done.
              const busy = projection.value.subagents.some((task) => live(task.status));
              const stop = threadAdmissions.get(agent.threadId);
              const stopped = stop?.stopApplied || (stop?.stopped && agent.status === "cancelled");
              if (settled)
                agents[i] = { ...agents[i]!, status: agent.status, completedAt: agent.completedAt };
              else if (stopped)
                agents[i] = { ...agents[i]!, status: "cancelled", completedAt: agent.completedAt };
              else if (latest && (agent.parentThreadId === null || agent.status !== "completed")) {
                const status =
                  latest.status === "preparing" ||
                  latest.status === "queued" ||
                  latest.status === "starting"
                    ? "pending"
                    : latest.status === "rolled_back"
                      ? "cancelled"
                      : latest.status;
                const waiting = status === "completed" && busy;
                agents[i] = {
                  ...agents[i]!,
                  status: waiting ? "waiting" : status,
                  startedAt: latest.startedAt
                    ? DateTime.formatIso(latest.startedAt)
                    : agent.startedAt,
                  completedAt:
                    latest.completedAt && !waiting ? DateTime.formatIso(latest.completedAt) : null,
                };
              } else if (agent.status === "completed" && busy) {
                agents[i] = { ...agents[i]!, status: "waiting", completedAt: null };
              }
              for (const task of projection.value.subagents) {
                if (!task.childThreadId) continue;
                taskMembership.set(task.id, run.id);
                const existing = agents.findIndex((a) => a.threadId === task.childThreadId);
                if (existing >= 0) {
                  const { grade: _grade, ...ungraded } = agents[existing]!;
                  const grade = grades.get(task.id);
                  const stop = threadAdmissions.get(task.childThreadId);
                  const stopped =
                    stop?.stopApplied ||
                    (stop?.stopped && agents[existing]!.status === "cancelled");
                  agents[existing] = {
                    ...ungraded,
                    ...(grade === undefined ? {} : { grade }),
                    model: task.model,
                    instanceId: task.providerInstanceId,
                    status: stopped
                      ? "cancelled"
                      : task.status === "idle"
                        ? "pending"
                        : task.status,
                    ...(task.progress ? { progress: task.progress.slice(0, 300) } : {}),
                    startedAt: task.startedAt
                      ? DateTime.formatIso(task.startedAt)
                      : agents[existing]!.startedAt,
                    completedAt: task.completedAt ? DateTime.formatIso(task.completedAt) : null,
                  };
                }
              }
            }
            // A parent's task can read completed while its own children still work; bottom up,
            // any agent with a live child is still waiting.
            for (let changed = true; changed;) {
              changed = false;
              for (const [index, agent] of agents.entries()) {
                if (agent.status !== "completed") continue;
                if (!agents.some((a) => a.parentThreadId === agent.threadId && live(a.status)))
                  continue;
                agents[index] = { ...agent, status: "waiting", completedAt: null };
                changed = true;
              }
            }
            const status =
              settled || run.status === "cancelled"
                ? run.status
                : rollupWorkflowRun(agents, run.leadThreadId);
            // A cheap structural change check on plain data; nothing is decoded.
            const changed =
              status !== run.status ||
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify(agents) !== JSON.stringify(run.agents);
            runs.push(
              changed
                ? {
                    ...run,
                    agents,
                    status,
                    updatedAt: timestamp,
                    completedAt: terminal(status) ? (run.completedAt ?? timestamp) : null,
                  }
                : run,
            );
          }
          if (runs.some((r, i) => r !== current.runs[i])) yield* save({ ...current, runs });
        }),
      )
      .pipe(Effect.withSpan("WorkflowsService.refresh"));

  const childContext = (run: WorkflowRun, agent: WorkflowRunAgent): WorkflowContextRecord => ({
    version: 1,
    kind: "workflow",
    contextId: ComposerContextId.make(`workflow_${run.id}`),
    label: run.snapshot.name,
    workflowId: run.workflowId,
    runId: run.id,
    nodeId: agent.nodeId,
    plan: compactWorkflowPlan(run.snapshot, agent.nodeId),
  });
  const childIdentity = (key: string) =>
    derive.delegatedTaskThread({ commandId: CommandId.make(key) });
  const saveAdmission = (admission: Admission) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = admissions.get(admission.key);
        admissions.set(admission.key, {
          ...previous,
          ...admission,
          ...(previous?.stopped ? { stopped: true } : {}),
          ...(previous?.launched ? { launched: true } : {}),
        });
        yield* save({ ...(yield* SubscriptionRef.get(state)) }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (previous) admissions.set(admission.key, previous);
              else admissions.delete(admission.key);
            }),
          ),
        );
      }),
    );
  const admitCommand = (key: string, command: DelegationCommand) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const admission = admissions.get(key);
        if (!admission || admission.stopped)
          return yield* new WorkflowsError({ reason: "invalid", message: "Agent was stopped." });
        if (admission.command) return;
        admissions.set(key, { ...admission, command });
        yield* save({ ...(yield* SubscriptionRef.get(state)) }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              admissions.set(key, admission);
            }),
          ),
        );
      }),
    );
  const launchAdmission = Effect.fn("WorkflowsService.launchAdmission")(function* (
    admission: Admission,
  ) {
    const input = admission.input;
    const owner = (yield* SubscriptionRef.get(state)).runs.find((r) => r.id === admission.runId);
    const agent = owner?.agents.find((a) => a.threadId === admission.threadId);
    if (!owner || !agent)
      return yield* new WorkflowsError({
        reason: "notFound",
        message: "Workflow agent not found.",
      });
    const context = childContext(owner, agent);
    if (!admission.parentThreadId) {
      if (!input.target?.providerInstanceId || !input.target.model)
        return yield* new WorkflowsError({ reason: "start", message: "Choose the lead model." });
      const modelSelection = {
        instanceId: input.target.providerInstanceId,
        model: input.target.model,
        ...(input.target.options ? { options: input.target.options } : {}),
      };
      const initialMessage = {
        text: `${input.task}\n\n${formatComposerContextReference(context)}`,
        attachments: [],
        context: { version: 1 as const, records: [context] },
      };
      if (admission.reuseThread)
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(admission.key),
          threadId: admission.threadId,
          messageId: MessageId.make(admission.key),
          ...initialMessage,
          modelSelection,
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        });
      else
        yield* launch.launch({
          commandId: CommandId.make(admission.key),
          threadId: admission.threadId,
          projectId: admission.projectId ?? (yield* folders.ensureScratchProject).projectId,
          title: runTitleSeed(input.task, context.label),
          generateTitle: true,
          modelSelection,
          runtimeMode:
            input.runtimeMode && input.runtimeMode !== "inherit"
              ? input.runtimeMode
              : "full-access",
          interactionMode:
            input.interactionMode && input.interactionMode !== "inherit"
              ? input.interactionMode
              : "default",
          workspaceStrategy: { type: "root" },
          initialMessage,
          createdBy: "user",
          creationSource: "workflows",
        });
      return { childThreadId: admission.threadId, status: "pending" };
    }
    const parent = yield* threads.getThreadRecords(admission.parentThreadId, ["runs"]);
    let details = admission.command;
    if (!details) {
      const parentRun = parent.runs
        .toSorted((a, b) => b.ordinal - a.ordinal)
        .find((r) => r.rootNodeId);
      if (!parentRun?.rootNodeId || !input.target?.providerInstanceId || !input.target.model)
        return yield* new WorkflowsError({
          reason: "start",
          message: "Parent turn is unavailable.",
        });
      let workspaceStrategy: DelegationCommand["workspaceStrategy"];
      if (input.isolation === "worktree") {
        if (Option.isNone(projects) || Option.isNone(git))
          return yield* new WorkflowsError({
            reason: "start",
            message: "Worktree is unavailable.",
          });
        const project = yield* projects.value.getById(parent.thread.projectId);
        if (Option.isNone(project))
          return yield* new WorkflowsError({ reason: "notFound", message: "Project not found." });
        const cwd =
          input.repositoryPath ?? parent.thread.worktreePath ?? project.value.workspaceRoot;
        const snapshot = input.withEdits ? yield* git.value.captureParentEdits(cwd) : undefined;
        const base = snapshot
          ? snapshot.baseCommit
          : (yield* git.value.resolveCommit({ cwd, revision: "HEAD" })).commitSha;
        workspaceStrategy = {
          type: "worktree",
          baseRef: base,
          startFromOrigin: false,
          ...(input.repositoryPath ? { sourcePath: input.repositoryPath } : {}),
          ...(snapshot ? { parentSnapshot: snapshot.directory } : {}),
        };
      } else if (input.repositoryPath)
        workspaceStrategy = { type: "existing_worktree", worktreePath: input.repositoryPath };
      const modelSelection = {
        instanceId: input.target.providerInstanceId,
        model: input.target.model,
        ...(input.target.options ? { options: input.target.options } : {}),
      };
      const provider = (yield* providers.getProviders).find(
        (p) => p.instanceId === modelSelection.instanceId,
      );
      details = {
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        task: input.task,
        modelSelection,
        runtimeMode: yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode, {
          modelSelection,
          supportedRuntimeModes: provider?.supportedRuntimeModes,
        }),
        interactionMode: yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        ),
        ...(workspaceStrategy ? { workspaceStrategy } : {}),
      };
      yield* saveAdmission({ ...admission, command: details });
    }
    if (!(yield* threads.hasReceipt(CommandId.make(admission.key)))) {
      yield* resolveRuntimeMode(parent.thread.runtimeMode, details.runtimeMode);
      yield* resolveInteractionMode(parent.thread.interactionMode, details.interactionMode);
    }
    const result = yield* threads.dispatch({
      ...details,
      type: "delegated_task.request",
      commandId: CommandId.make(admission.key),
      parentThreadId: admission.parentThreadId,
      ...(input.title ? { title: input.title } : {}),
      ...(input.role && input.role !== "general" ? { role: input.role } : {}),
      context: { version: 1, records: [context] },
      completionWake: "always",
      workflowAdmission: true,
      createdBy: "system",
      creationSource: "server",
    });
    const task = result.storedEvents.find((e) => e.event.type === "subagent.updated");
    if (task?.event.type !== "subagent.updated" || !task.event.payload.childThreadId)
      return yield* new WorkflowsError({ reason: "start", message: "Could not start agent." });
    const childThreadId = task.event.payload.childThreadId;
    const run = result.storedEvents.find(
      (e) => e.event.type === "run.created" && e.event.threadId === childThreadId,
    );
    if (run?.event.type === "run.created" && run.event.payload.workspacePreparation)
      yield* launch.prepareRun({
        commandId: CommandId.make(admission.key),
        threadId: task.event.payload.childThreadId,
        runId: run.event.payload.id,
      });
    return {
      taskId: task.event.payload.id,
      childThreadId: task.event.payload.childThreadId,
      status: task.event.payload.status === "idle" ? "pending" : task.event.payload.status,
    };
  });
  const finishAdmission = (
    key: string,
    result: {
      readonly childThreadId: ThreadId | null;
      readonly status: string;
      readonly childThreadLink?: string | undefined;
    },
  ) =>
    update((s) => {
      const admission = admissions.get(key);
      if (!admission || !result.childThreadId) return s;
      admissions.set(key, { ...admission, launched: true, threadId: result.childThreadId });
      receipts.set(key, result.childThreadId);
      return {
        ...s,
        runs: s.runs.map((r) =>
          r.id !== admission.runId
            ? r
            : {
                ...r,
                agents: r.agents.map((a) =>
                  a.threadId !== admission.threadId
                    ? a
                    : {
                        ...a,
                        threadId: result.childThreadId!,
                        status:
                          result.status === "queued" ||
                          result.status === "held" ||
                          result.status === "idle"
                            ? "pending"
                            : result.status === "starting"
                              ? "running"
                              : (result.status as WorkflowRunAgent["status"]),
                        ...(result.childThreadLink ? { threadLink: result.childThreadLink } : {}),
                      },
                ),
              },
        ),
      };
    });

  const refresh = ensureStorage.pipe(Effect.andThen(refreshRuns()));

  const compile = Effect.fn("WorkflowsService.compile")(function* (input: WorkflowCompileRequest) {
    yield* ensureStorage;
    const catalog = yield* providers.getProviders;
    const model = input.model ?? workflowCompileModel(catalog);
    if (
      !model ||
      !catalog.some(
        (p) => p.instanceId === model.instanceId && p.models.some((m) => m.slug === model.model),
      )
    )
      return yield* new WorkflowsError({
        reason: "compile",
        message: input.model
          ? "Choose an available compile model."
          : "No ready provider can compile workflows. Set one up in Settings → Providers.",
      });
    if (!generation.rewriteProse)
      return yield* new WorkflowsError({
        reason: "compile",
        message: "This provider cannot compile workflows.",
      });
    const prompt = workflowCompilePrompt(input, catalog);
    const generate = (retry: boolean) =>
      generation.rewriteProse!({
        cwd: config.stateDir,
        modelSelection: model,
        prompt: `${prompt}${retry ? "\nPrevious output was invalid. Return valid JSON matching the requested schema and catalog." : ""}`,
      }).pipe(
        Effect.mapError(
          () =>
            new WorkflowsError({
              reason: "compile",
              message: "The compile model failed. Try again or choose another model.",
            }),
        ),
      );
    const first = yield* generate(false);
    const parsed = yield* parseWorkflowCompile(first.output, input, catalog).pipe(Effect.result);
    if (parsed._tag === "Success") return parsed.success;
    const second = yield* generate(true);
    return yield* parseWorkflowCompile(second.output, input, catalog).pipe(
      Effect.mapError(
        () =>
          new WorkflowsError({
            reason: "compile",
            message: "Compile returned invalid output twice. Try a clearer brief or another model.",
          }),
      ),
    );
  });

  const start = Effect.fn("WorkflowsService.start")(function* (input: WorkflowStartRequest) {
    yield* ensureStorage;
    yield* requireEnabled;
    const current = yield* SubscriptionRef.get(state);
    const workflow = current.workflows.find((w) => w.id === input.workflowId);
    if (!workflow)
      return yield* new WorkflowsError({ reason: "notFound", message: "Workflow not found." });
    const issues = validateWorkflow(workflow);
    if (issues.length)
      return yield* new WorkflowsError({
        reason: "invalid",
        message: "Fix workflow issues before starting.",
        issues,
      });
    const root = workflow.nodes.find((n) => n.id === workflow.rootNodeId && n.kind === "agent")!;
    if (root.kind !== "agent" || !root.model)
      return yield* new WorkflowsError({ reason: "invalid", message: "Choose the lead model." });
    const existing = input.chatThreadId
      ? yield* threads
          .getThreadRecords(input.chatThreadId, [])
          .pipe(
            Effect.mapError(
              () => new WorkflowsError({ reason: "start", message: "Chat not found." }),
            ),
          )
      : undefined;
    if (existing?.thread.worktreePath)
      return yield* new WorkflowsError({
        reason: "start",
        message: "This chat uses a worktree. Start the workflow from a shared chat.",
      });
    const threadId = input.chatThreadId ?? ThreadId.make(yield* randomUuidV4);
    if (
      current.runs.some((r) => !terminal(r.status) && r.agents.some((a) => a.threadId === threadId))
    )
      return yield* new WorkflowsError({
        reason: "start",
        message: "This chat already belongs to a live run.",
      });
    const runId = WorkflowRunId.make(yield* randomUuidV4),
      timestamp = yield* now;
    const modelSelection = existing?.thread.modelSelection ?? root.model;
    const definition = withRunLabels(structuredClone(workflow));
    const snapshot = existing
      ? {
          ...definition,
          nodes: definition.nodes.map((n) =>
            n.id === root.id && n.kind === "agent" ? { ...n, model: modelSelection } : n,
          ),
        }
      : definition;
    const run: WorkflowRun = {
      id: runId,
      workflowId: workflow.id,
      snapshot,
      task: input.task,
      origin: existing ? "chat" : "workflows",
      leadThreadId: threadId,
      status: "starting",
      agents: [
        {
          nodeId: root.id,
          slot: 0,
          threadId,
          parentThreadId: null,
          title:
            definition.nodes.find((n): n is typeof root => n.kind === "agent" && n.id === root.id)
              ?.label ?? root.label,
          model: modelSelection.model,
          status: "pending",
          startedAt: null,
          completedAt: null,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    // Publish ownership before launch so even an immediate delegate call sees its policy.
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* SubscriptionRef.get(state);
        if (
          latest.runs.some(
            (r) => !terminal(r.status) && r.agents.some((a) => a.threadId === threadId),
          )
        )
          return yield* new WorkflowsError({
            reason: "start",
            message: "This chat already belongs to a live run.",
          });
        const admission: Admission = {
          key: `workflow:${runId}`,
          runId,
          threadId,
          parentThreadId: null,
          ...(existing ? { projectId: existing.thread.projectId, reuseThread: true } : {}),
          input: {
            task: input.task,
            title: run.agents[0]!.title,
            target: {
              providerInstanceId: modelSelection.instanceId,
              model: modelSelection.model,
              ...(modelSelection.options ? { options: modelSelection.options } : {}),
            },
            ...(existing
              ? {
                  runtimeMode: existing.thread.runtimeMode,
                  interactionMode: existing.thread.interactionMode,
                }
              : {}),
          },
          launched: false,
        };
        admissions.set(admission.key, admission);
        yield* save({ ...latest, runs: [run, ...latest.runs] }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              admissions.delete(admission.key);
            }),
          ),
        );
      }),
    );
    const admission = admissions.get(`workflow:${runId}`)!;
    yield* resumeAdmission(admission.key).pipe(
      Effect.mapError(
        () =>
          new WorkflowsError({ reason: "start", message: "Could not start the workflow lead." }),
      ),
    );
    return { runId, leadThreadId: threadId };
  });

  const startChild: WorkflowsService["Service"]["startChild"] = (input, spawn) =>
    Effect.gen(function* () {
      yield* ensureStorage;
      yield* requireEnabled;
      const run = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const previousId = starts.get(input.key);
          const previous = current.runs.find((r) => r.id === previousId);
          if (previous) {
            if (
              previous.workflowId !== input.workflowId ||
              previous.task !== input.task ||
              previous.leadThreadId !== input.leadThreadId
            )
              return yield* new WorkflowsError({
                reason: "start",
                message: "This start key belongs to another request.",
              });
            if (previous.status === "cancelled")
              return yield* new WorkflowsError({
                reason: "start",
                message: "This workflow start was cancelled.",
              });
            return previous;
          }
          const workflow = current.workflows.find((w) => w.id === input.workflowId);
          if (!workflow)
            return yield* new WorkflowsError({
              reason: "notFound",
              message: "Workflow not found.",
            });
          const issues = validateWorkflow(workflow);
          if (issues.length)
            return yield* new WorkflowsError({
              reason: "invalid",
              message: "Fix workflow issues before starting.",
              issues,
            });
          const snapshot = withRunLabels(structuredClone(workflow));
          const root = snapshot.nodes.find((n) => n.id === snapshot.rootNodeId);
          if (root?.kind !== "agent" || !root.model)
            return yield* new WorkflowsError({
              reason: "invalid",
              message: "Choose the lead model.",
            });
          const id = WorkflowRunId.make(yield* randomUuidV4),
            timestamp = yield* now;
          const reserved: WorkflowRun = {
            id,
            workflowId: workflow.id,
            snapshot,
            task: input.task,
            origin: "workflows",
            leadThreadId: input.leadThreadId,
            status: "starting",
            agents: [
              {
                nodeId: root.id,
                slot: 0,
                threadId: input.leadThreadId,
                parentThreadId: null,
                title: root.label,
                model: root.model.model,
                status: "planned",
                startedAt: null,
                completedAt: null,
              },
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: null,
          };
          starts.set(input.key, id);
          if (input.parentThreadId)
            admissions.set(input.key, {
              key: input.key,
              runId: id,
              threadId: input.leadThreadId,
              parentThreadId: input.parentThreadId,
              input: {
                task: `${input.task}\n\n${compactWorkflowPlan(snapshot, root.id)}`,
                title: runTitleSeed(input.task, root.label, root.label),
                target: {
                  providerInstanceId: root.model.instanceId,
                  model: root.model.model,
                  ...(root.model.options ? { options: root.model.options } : {}),
                  userNamedModel: true,
                },
                mode: "async",
              },
              launched: false,
            });
          yield* save({ ...current, runs: [reserved, ...current.runs] }).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                starts.delete(input.key);
                admissions.delete(input.key);
              }),
            ),
          );
          return reserved;
        }),
      );
      const root = run.snapshot.nodes.find((n) => n.id === run.snapshot.rootNodeId);
      if (root?.kind !== "agent" || !root.model)
        return yield* new WorkflowsError({ reason: "invalid", message: "Choose the lead model." });
      // The deterministic delegation command replays its receipt after a crash or lost response.
      const result = yield* spawn({
        task: `${run.task}\n\n${compactWorkflowPlan(run.snapshot, root.id)}`,
        title: runTitleSeed(run.task, root.label, root.label),
        target: {
          providerInstanceId: root.model.instanceId,
          model: root.model.model,
          ...(root.model.options ? { options: root.model.options } : {}),
          userNamedModel: true,
        },
        mode: "async",
      });
      if (result.childThreadId !== run.leadThreadId)
        return yield* new WorkflowsError({
          reason: "start",
          message: "Workflow lead identity changed.",
        });
      yield* update((s) => ({
        ...s,
        runs: s.runs.map((r) =>
          r.id === run.id
            ? {
                ...r,
                agents: r.agents.map((a) =>
                  a.threadId === run.leadThreadId
                    ? {
                        ...a,
                        status:
                          result.status === "queued" || result.status === "held"
                            ? "pending"
                            : result.status === "starting"
                              ? "running"
                              : result.status,
                      }
                    : a,
                ),
              }
            : r,
        ),
      }));
      yield* refreshRuns(new Set([run.id]));
      if (
        (yield* SubscriptionRef.get(state)).runs.find((r) => r.id === run.id)?.status ===
        "cancelled"
      )
        yield* mutate({ type: "cancelRun", runId: run.id });
      return { ...result, runId: run.id };
    });

  const delegate: WorkflowsService["Service"]["delegate"] = (
    threadId,
    key,
    input,
    inherited,
    execute,
    context,
  ) =>
    Effect.gen(function* () {
      yield* ensureStorage;
      if (activeMembership.size && !activeMembership.has(threadId)) {
        // An immediate child call can precede its parent's event batch.
        const projection = yield* threads.getThreadRecords(threadId, []).pipe(Effect.option);
        const parentId = Option.isSome(projection)
          ? projection.value.thread.lineage.parentThreadId
          : null;
        const owner = parentId ? activeMembership.get(parentId) : undefined;
        if (owner) yield* refreshRuns(new Set([owner.id]));
      }
      const prepared = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const run = activeMembership.get(threadId);
          if (run && threadAdmissions.get(threadId)?.stopped)
            return yield* new WorkflowsError({
              reason: "invalid",
              message: "Workflow parent has stopped.",
            });
          if (!run && closedMembership.has(threadId))
            return yield* new WorkflowsError({
              reason: "invalid",
              message: "Workflow run has ended.",
            });
          if (!run) {
            const admission = admissions.get(key);
            if (!admission || admission.parentThreadId !== threadId) return undefined;
            const owner = (yield* SubscriptionRef.get(state)).runs.find(
              (r) => r.id === admission.runId,
            );
            if (!owner) return undefined;
            return {
              run: owner,
              input: admission.input,
              agent: owner.agents.find((a) => a.threadId === admission.threadId)!,
              admission,
            };
          }
          // A queued workflow must not constrain the chat's preceding turn.
          if (
            run.origin === "chat" &&
            threadId === run.leadThreadId &&
            run.status === "starting" &&
            run.agents.length === 1 &&
            !context?.records.some(
              (r) => r.kind === "workflow" && !("payload" in r) && r.runId === run.id,
            )
          )
            return undefined;
          const admitted = admissions.get(key);
          if (admitted)
            return {
              run,
              previous: receipts.get(key),
              input: admitted.input,
              agent: run.agents.find((a) => a.threadId === admitted.threadId)!,
              admission: admitted,
            };
          const previous = receipts.get(key);
          if (previous)
            return {
              run,
              previous,
              input,
              agent: run.agents.find((a) => a.threadId === previous)!,
            };
          const planned = planWorkflowDelegation(run, threadId, input, inherited);
          if ("error" in planned)
            return yield* new WorkflowsError({ reason: "invalid", message: planned.error! });
          if (input.target?.driverKind) {
            const catalog = yield* providers.getProviders;
            if (
              catalog.find((p) => p.instanceId === planned.node.model!.instanceId)?.driver !==
              input.target.driverKind
            )
              return yield* new WorkflowsError({
                reason: "invalid",
                message: `Use the drawn provider. Allowed box: ${planned.node.label} (${planned.node.model!.model}).`,
              });
          }
          const agent: WorkflowRunAgent = {
            nodeId: planned.node.id,
            slot: planned.slot,
            threadId: childIdentity(key),
            parentThreadId: threadId,
            title: planned.input.title!,
            model: planned.node.model!.model,
            instanceId: planned.node.model!.instanceId,
            machine: planned.node.machine,
            isolation: planned.input.isolation ?? "shared",
            status: "pending",
            startedAt: null,
            completedAt: null,
          };
          const predecessors = new Set(
            run.snapshot.edges
              .filter((e) => e.kind === "then" && e.to === agent.nodeId)
              .map((e) => e.from),
          );
          const previousResults: string[] = [];
          if (predecessors.size) {
            const parent = yield* threads.getThreadRecords(threadId, ["subagents"]).pipe(
              Effect.mapError(
                () =>
                  new WorkflowsError({
                    reason: "read",
                    message: "Could not read preceding results.",
                  }),
              ),
            );
            const replaced = new Set(run.agents.flatMap((a) => (a.retryOf ? [a.retryOf] : [])));
            const ids = new Set(
              run.agents
                .filter(
                  (a) =>
                    predecessors.has(a.nodeId) &&
                    a.parentThreadId === threadId &&
                    !replaced.has(a.threadId),
                )
                .map((a) => a.threadId),
            );
            for (const task of parent.subagents)
              if (task.childThreadId && ids.has(task.childThreadId) && task.result)
                previousResults.push(task.result);
          }
          const preparedInput = previousResults.length
            ? {
                ...planned.input,
                task: `${planned.input.task}\n\nPreceding results:\n${previousResults.join("\n").slice(0, 16000)}`,
              }
            : planned.input;
          const admission: Admission = {
            key,
            runId: run.id,
            threadId: agent.threadId,
            parentThreadId: threadId,
            input: preparedInput,
            launched: false,
          };
          admissions.set(key, admission);
          const current = yield* SubscriptionRef.get(state);
          yield* save({
            ...current,
            runs: current.runs.map((r) =>
              r.id === run.id ? { ...r, agents: [...r.agents, agent] } : r,
            ),
          }).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                admissions.delete(key);
              }),
            ),
          );
          return { run, input: preparedInput, agent, admission };
        }),
      );
      if (!prepared) return yield* execute(input);
      const admission = admissions.get(key);
      const handoffContext = childContext(prepared.run, prepared.agent);
      const result = yield* execute(
        prepared.input,
        handoffContext,
        admission ? (command) => admitCommand(key, command) : undefined,
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            // An accepted command may have run even when its response was lost. Keep
            // its intent for replay; a request rejected before admission frees capacity.
            if (
              (yield* threads
                .hasReceipt(CommandId.make(key))
                .pipe(Effect.orElseSucceed(() => false))) ||
              admissions.get(key)?.command
            )
              return;
            yield* update((s) => {
              const current = admissions.get(key);
              if (!current) return s;
              admissions.delete(key);
              return {
                ...s,
                runs: s.runs.map((r) =>
                  r.id === current.runId
                    ? { ...r, agents: r.agents.filter((a) => a.threadId !== current.threadId) }
                    : r,
                ),
              };
            });
          }).pipe(Effect.catch(() => Effect.logWarning("Could not release workflow reservation."))),
        ),
      );
      yield* finishAdmission(key, result);
      const current = (yield* SubscriptionRef.get(state)).runs.find(
        (r) => r.id === prepared.run.id,
      );
      if (current?.status === "cancelled") yield* mutate({ type: "cancelRun", runId: current.id });
      else if (admissions.get(key)?.stopped && result.childThreadId)
        yield* mutate({
          type: "stopAgent",
          runId: prepared.run.id,
          threadId: result.childThreadId,
        });
      yield* refreshRuns(new Set([prepared.run.id]));
      return result;
    });

  const stopAgents = Effect.fn("WorkflowsService.stopAgents")(function* (
    runId: WorkflowRunId,
    root?: ThreadId,
  ) {
    const run = (yield* SubscriptionRef.get(state)).runs.find((r) => r.id === runId);
    if (!run) return yield* new WorkflowsError({ reason: "notFound", message: "Run not found." });
    if (root && !run.agents.some((a) => a.threadId === root))
      return yield* new WorkflowsError({ reason: "notFound", message: "Agent not found." });
    const selected = new Set(root ? [root] : run.agents.map((a) => a.threadId));
    for (let changed = true; changed;) {
      changed = false;
      for (const agent of run.agents)
        if (
          agent.parentThreadId &&
          selected.has(agent.parentThreadId) &&
          !selected.has(agent.threadId)
        ) {
          selected.add(agent.threadId);
          changed = true;
        }
    }
    const pending = run.agents.filter(
      (a) =>
        selected.has(a.threadId) &&
        (!terminal(a.status) ||
          (threadAdmissions.get(a.threadId)?.stopped &&
            !threadAdmissions.get(a.threadId)?.stopApplied)),
    );
    if (!pending.length) return;
    const timestamp = yield* now;
    // Close admission first. A launch already in flight rechecks this after its receipt.
    yield* update((s) => {
      for (const [key, a] of admissions)
        if (pending.some((agent) => agent.threadId === a.threadId))
          admissions.set(key, { ...a, stopped: true });
      return {
        ...s,
        runs: s.runs.map((r) =>
          r.id !== runId
            ? r
            : {
                ...r,
                ...(root ? {} : { status: "cancelled" as const, completedAt: timestamp }),
                updatedAt: timestamp,
              },
        ),
      };
    });
    const cancelled = new Set<ThreadId>(),
      failures: unknown[] = [];
    for (const agent of pending) {
      if (
        agent.threadLink &&
        agent.parentThreadId &&
        selected.has(agent.parentThreadId) &&
        run.agents.find((a) => a.threadId === agent.parentThreadId)?.threadLink
      )
        continue;
      // A terminal parent's own work is done, but its live descendants still stop.
      const stopped = yield* Effect.gen(function* () {
        const effectiveParent =
          threadAdmissions.get(agent.threadId)?.parentThreadId ?? agent.parentThreadId;
        const parent = effectiveParent
          ? yield* threads.getThreadRecords(effectiveParent, ["subagents"])
          : undefined;
        const task = parent?.subagents.find(
          (t) => t.childThreadId === agent.threadId && t.origin === "app_owned",
        );
        const admission = threadAdmissions.get(agent.threadId);
        if (
          (agent.status === "planned" || (admission && !admission.launched)) &&
          (yield* threads.getThreadShell(agent.threadId)) === null
        )
          return false;
        if (task && effectiveParent)
          yield* threads.dispatch({
            type: "delegated_task.cancel-requested",
            commandId: CommandId.make(`workflow-cancel-result:${runId}:${agent.threadId}`),
            parentThreadId: effectiveParent,
            taskId: task.id,
          });
        const projection = yield* threads.getThreadRecords(agent.threadId, []);
        yield* threads.interruptThread({
          projectId: projection.thread.projectId,
          threadId: agent.threadId,
          commandId: CommandId.make(`workflow-cancel:${runId}:${agent.threadId}`),
          reason: root ? "Agent stopped" : "Workflow cancelled",
        });
        return true;
      }).pipe(Effect.result);
      if (stopped._tag === "Failure") failures.push(stopped.failure);
      else {
        cancelled.add(agent.threadId);
        if (stopped.success) {
          const admission = threadAdmissions.get(agent.threadId);
          if (admission) yield* saveAdmission({ ...admission, stopApplied: true });
        }
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const agent of pending)
        if (
          agent.threadLink &&
          agent.parentThreadId &&
          cancelled.has(agent.parentThreadId) &&
          !cancelled.has(agent.threadId)
        ) {
          cancelled.add(agent.threadId);
          changed = true;
        }
    }
    yield* update((s) => ({
      ...s,
      runs: s.runs.map((r) =>
        r.id !== runId
          ? r
          : {
              ...r,
              agents: r.agents.map((a) => {
                if (!cancelled.has(a.threadId)) return a;
                const { needs: _needs, ...rest } = a;
                return { ...rest, status: "cancelled" as const, completedAt: timestamp };
              }),
            },
      ),
    }));
    if (failures.length)
      return yield* new WorkflowsError({
        reason: "start",
        message: "Some agents could not be stopped. Retry stop.",
      });
  });
  const retryNotice = (admission: Admission) =>
    Effect.gen(function* () {
      if (
        !admission.parentThreadId ||
        !admission.noticePending ||
        !admission.launched ||
        admission.stopped
      )
        return;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${admission.key}:notice`),
        threadId: admission.parentThreadId,
        messageId: MessageId.make(`${admission.key}:notice`),
        text: `Retry started: ${admission.input.title?.slice(0, 80) ?? "subagent"}.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* saveAdmission({ ...admission, noticePending: false });
    });
  const resumeAdmission = (key: string) =>
    Effect.gen(function* () {
      if (launching.has(key)) return;
      const admission = admissions.get(key);
      if (!admission) return;
      launching.add(key);
      yield* Effect.gen(function* () {
        if (!admission.launched && !admission.stopped) {
          const result = yield* launchAdmission(admission);
          yield* finishAdmission(key, result);
        }
        const current = admissions.get(key)!;
        if (current.stopped) yield* stopAgents(current.runId, current.threadId);
        else yield* retryNotice(current);
        yield* refreshRuns(new Set([current.runId]));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            launching.delete(key);
          }),
        ),
      );
    });
  const retryAgent = Effect.fn("WorkflowsService.retryAgent")(function* (
    runId: WorkflowRunId,
    threadId: ThreadId,
  ) {
    yield* requireEnabled;
    const prepared = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state),
          run = current.runs.find((r) => r.id === runId);
        if (!run)
          return yield* new WorkflowsError({ reason: "notFound", message: "Run not found." });
        const agent = run.agents.find((a) => a.threadId === threadId);
        if (!agent)
          return yield* new WorkflowsError({ reason: "notFound", message: "Agent not found." });
        const retryId = Hex.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(threadId)),
        ).slice(0, 24);
        const key = `workflow-retry:${runId}:${retryId}`;
        if (admissions.has(key)) return { key };
        if (!terminal(agent.status))
          return yield* new WorkflowsError({
            reason: "invalid",
            message: "Stop the agent before retrying.",
          });
        if (run.agents.some((a) => a.retryOf === threadId))
          return yield* new WorkflowsError({
            reason: "invalid",
            message: "Retry the newest agent in this slot.",
          });
        const original = threadAdmissions.get(threadId);
        const parentThreadId = original?.parentThreadId ?? agent.parentThreadId;
        const parent = yield* threads.getThreadRecords(parentThreadId ?? threadId, ["subagents"]);
        const task = parent.subagents.find((t) => t.childThreadId === threadId);
        const child =
          !original && !agent.threadLink && task
            ? yield* threads.getThreadRecords(threadId, ["runs"])
            : undefined;
        const firstRun = child?.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0];
        const placement = firstRun?.workspacePreparation;
        const legacyCommand =
          child && task?.runId
            ? {
                parentRunId: task.runId,
                parentNodeId: task.parentNodeId,
                task: task.prompt,
                modelSelection: firstRun?.modelSelection ?? child.thread.modelSelection,
                runtimeMode: child.thread.runtimeMode,
                interactionMode: child.thread.interactionMode,
                ...(placement ? { workspaceStrategy: placement } : {}),
              }
            : undefined;
        const node = run.snapshot.nodes.find((n) => n.id === agent.nodeId && n.kind === "agent");
        if (
          node?.kind !== "agent" ||
          !node.model ||
          (!original && !task && threadId !== run.leadThreadId)
        )
          return yield* new WorkflowsError({
            reason: "invalid",
            message: "Original task is unavailable.",
          });
        const input: OrchestratorMcpDelegateTaskInput = original?.input ?? {
          task: task?.prompt ?? run.task,
          title: agent.title,
          target: {
            providerInstanceId: node.model.instanceId,
            model: node.model.model,
            ...(node.model.options ? { options: node.model.options } : {}),
          },
          isolation: node.isolation,
          ...(placement?.type === "worktree" && placement.sourcePath
            ? { repositoryPath: placement.sourcePath }
            : {}),
          ...(placement?.type === "existing_worktree"
            ? { repositoryPath: placement.worktreePath }
            : {}),
        };
        // Replace capacity, not history. Order still checks successors and predecessors.
        if (agent.parentThreadId) {
          const planned = planWorkflowDelegation(
            {
              ...run,
              status: "running",
              agents: run.agents.map((a) =>
                a.threadId === agent.parentThreadId ? { ...a, status: "running" } : a,
              ),
            },
            agent.parentThreadId,
            input,
            parent.thread.modelSelection,
            [],
            agent.nodeId,
            agent.threadId,
          );
          if ("error" in planned)
            return yield* new WorkflowsError({ reason: "invalid", message: planned.error! });
        }
        const next: WorkflowRunAgent = {
          ...agent,
          machine: "local",
          isolation: input.isolation ?? node.isolation,
          threadId: childIdentity(key),
          retryOf: threadId,
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const {
          grade: _grade,
          needs: _needs,
          progress: _progress,
          threadLink: _link,
          ...clean
        } = next;
        const admission: Admission = {
          key,
          runId,
          parentThreadId,
          threadId: next.threadId,
          ...(!parentThreadId ? { projectId: parent.thread.projectId } : {}),
          input: { ...input, mode: "async" },
          launched: false,
          noticePending: true,
          ...(!input.withEdits && (original?.command ?? legacyCommand)
            ? { command: (original?.command ?? legacyCommand)! }
            : {}),
        };
        admissions.set(key, admission);
        yield* save({
          ...current,
          runs: current.runs.map((r) =>
            r.id !== runId
              ? r
              : {
                  ...r,
                  ...(threadId === r.leadThreadId ? { leadThreadId: next.threadId } : {}),
                  status: "starting",
                  completedAt: null,
                  agents: [...r.agents, clean],
                },
          ),
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              admissions.delete(key);
            }),
          ),
        );
        return { key };
      }),
    );
    yield* resumeAdmission(prepared.key);
  });
  const mutate = Effect.fn("WorkflowsService.mutate")(function* (operation: WorkflowOperation) {
    yield* ensureStorage;
    if (operation.type === "stopAgent")
      return yield* stopAgents(operation.runId, operation.threadId).pipe(
        Effect.mapError((e) =>
          e._tag === "WorkflowsError"
            ? e
            : new WorkflowsError({ reason: "start", message: "Could not stop agent." }),
        ),
      );
    if (operation.type === "retryAgent")
      return yield* retryAgent(operation.runId, operation.threadId).pipe(
        Effect.mapError((e) =>
          e._tag === "WorkflowsError"
            ? e
            : new WorkflowsError({ reason: "start", message: "Could not retry agent." }),
        ),
      );
    if (operation.type === "cancelRun")
      return yield* stopAgents(operation.runId).pipe(
        Effect.mapError((e) =>
          e._tag === "WorkflowsError"
            ? e
            : new WorkflowsError({ reason: "start", message: "Could not cancel run." }),
        ),
      );
    yield* update((s) => {
      switch (operation.type) {
        case "save":
          return {
            ...s,
            workflows: [
              ...s.workflows.filter((w) => w.id !== operation.workflow.id),
              operation.workflow,
            ],
          };
        case "delete":
          return { ...s, workflows: s.workflows.filter((w) => w.id !== operation.id) };
        case "deleteRun":
          return {
            ...s,
            runs: s.runs.filter(
              (r) =>
                r.id !== operation.runId ||
                !terminal(r.status) ||
                r.agents.some((a) => !terminal(a.status)),
            ),
          };
      }
    });
    if (operation.type === "save") yield* scheduleNaming(operation.workflow.id);
  });

  yield* threads.streamDomainEvents.pipe(
    Stream.filter(
      (e) =>
        e.type === "run.updated" ||
        e.type === "subagent.updated" ||
        e.type === "runtime-request.updated",
    ),
    Stream.map((e) => activeMembership.get(e.threadId)?.id),
    Stream.filter((id): id is WorkflowRunId => id !== undefined),
    // Progress bursts share one write and one canvas update.
    Stream.groupedWithin(64, "100 millis"),
    Stream.runForEach((ids) =>
      refreshRuns(new Set(ids)).pipe(
        Effect.catch(() => Effect.logWarning("Could not update workflow runs.")),
      ),
    ),
    Effect.forkScoped,
  );
  if (Option.isSome(rankings)) {
    let previous = new Map<NodeId, number | undefined>();
    yield* rankings.value.subscribe().pipe(
      Stream.runForEach((snapshot) =>
        Effect.gen(function* () {
          const grades = new Map(snapshot.thumbs.map((r) => [r.taskId, r.grade]));
          const changed = new Set(
            [...grades.keys(), ...previous.keys()].filter(
              (id) => grades.get(id) !== previous.get(id),
            ),
          );
          previous = grades;
          if (!changed.size) return;
          const ids = new Set<WorkflowRunId>();
          for (const taskId of changed) {
            const id = taskMembership.get(taskId);
            if (id) ids.add(id);
          }
          if (ids.size) yield* refreshRuns(ids);
        }),
      ),
      Effect.catch(() => Effect.logWarning("Could not refresh workflow grades.")),
      Effect.forkScoped,
    );
  }
  for (const admission of admissions.values())
    if (
      !admission.launched ||
      admission.noticePending ||
      (admission.stopped && !admission.stopApplied)
    )
      yield* resumeAdmission(admission.key).pipe(
        Effect.catch(() => Effect.logWarning("Could not recover workflow agent.")),
        Effect.forkScoped,
      );
  yield* refresh.pipe(Effect.catch(() => Effect.logWarning("Could not restore workflow runs.")));
  for (const workflow of (yield* SubscriptionRef.get(state)).workflows)
    yield* scheduleNaming(workflow.id);
  const service = WorkflowsService.of({
    subscribe: (input) =>
      Stream.unwrap(
        ensureStorage.pipe(
          Effect.as(
            input?.leadThreadId
              ? SubscriptionRef.changes(state).pipe(
                  Stream.map((s) => ({
                    ...s,
                    workflows: [],
                    runs: s.runs.filter((r) => r.leadThreadId === input.leadThreadId),
                  })),
                )
              : SubscriptionRef.changes(state),
          ),
        ),
      ),
    mutate,
    compile,
    startChild,
    start,
    delegate,
    refresh,
    agentSaved: (workflowId, previousName) =>
      Effect.gen(function* () {
        const workflow = (yield* SubscriptionRef.get(state)).workflows.find(
          (w) => w.id === workflowId,
        );
        if (!workflow) return;
        const userNamed =
          previousName !== undefined &&
          previousName !== UNTITLED_WORKFLOW &&
          autoNamed.get(workflowId)?.name !== previousName;
        if (userNamed) return;
        autoNamed.set(workflowId, { name: workflow.name, content: "" });
        yield* scheduleNaming(workflowId);
      }),
  });
  registerWorkflowsAgentAccess({ service, providers: providers.getProviders });
  yield* Effect.addFinalizer(() => Effect.sync(() => registerWorkflowsAgentAccess(null)));
  return service;
});

export const layer = Layer.effect(WorkflowsService, make);

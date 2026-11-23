import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";
import { SubagentGrade } from "./subagentRankings.ts";

/**
 * Workflows (Beta): a drawn graph of agents. Starting one opens a lead chat that runs
 * the graph with SSHCode subagents, on exactly the models drawn. Definitions and runs
 * live in the server's state dir (`workflows.json`), never in the database. Nothing here
 * reaches a normal chat: agents only see workflow text when they belong to a run.
 */

const IdString = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const WorkflowId = IdString.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;
export const WorkflowNodeId = IdString.pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;
export const WorkflowEdgeId = IdString.pipe(Schema.brand("WorkflowEdgeId"));
export type WorkflowEdgeId = typeof WorkflowEdgeId.Type;
export const WorkflowRunId = IdString.pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WORKFLOW_MAX_NODES = 64;
export const WORKFLOW_MAX_AGENTS_PER_NODE = 16;
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Coordinate = Schema.Finite;
const Size = Schema.Finite.check(Schema.isBetween({ minimum: 24, maximum: 4000 }));

/** Where a box sits on the canvas. Run views and the phone reuse these positions. */
const Frame = {
  x: Coordinate,
  y: Coordinate,
  width: Size,
  height: Size,
};

/**
 * How many agents one box stands for. `upTo` is "many": the parent decides how many
 * to start, never more than `max`.
 */
export const WorkflowAgentCount = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exact"),
    n: PositiveInt.check(Schema.isLessThanOrEqualTo(WORKFLOW_MAX_AGENTS_PER_NODE)),
  }),
  Schema.Struct({
    kind: Schema.Literal("upTo"),
    max: PositiveInt.check(Schema.isLessThanOrEqualTo(WORKFLOW_MAX_AGENTS_PER_NODE)),
  }),
]);
export type WorkflowAgentCount = typeof WorkflowAgentCount.Type;

/** One box that is an agent (or a group of identical agents, see `count`). */
export const WorkflowAgentNode = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: WorkflowNodeId,
  ...Frame,
  /** What the user typed in the box, kept verbatim ("gpt 6.1 sol", "many haiku agents"). */
  text: Text(2_000),
  /** Short role shown as the box title ("Planner", "Frontend"). */
  label: Text(80),
  /** Null until resolved (by the user or the compile step). A run needs every agent resolved. */
  model: Schema.NullOr(ModelSelection),
  /** The brief this agent gets on top of its parent's task. Short; agents read it once. */
  instructions: Text(4_000),
  count: WorkflowAgentCount,
  machine: Schema.Literal("local"),
  /** `worktree` gives each agent its own Git worktree (only meaningful for edits). */
  isolation: Schema.Literals(["shared", "worktree"]),
  /** Accent token for the box; clients map it to their palette. */
  color: Schema.optionalKey(Text(32)),
});
export type WorkflowAgentNode = typeof WorkflowAgentNode.Type;

/**
 * Free text on the canvas. A note attached to an agent (an edge from the note, or
 * `attachedTo`) adds to that agent's brief; a loose note is guidance for the whole run.
 */
export const WorkflowNoteNode = Schema.Struct({
  kind: Schema.Literal("note"),
  id: WorkflowNodeId,
  ...Frame,
  text: Text(4_000),
  attachedTo: Schema.NullOr(WorkflowNodeId),
});
export type WorkflowNoteNode = typeof WorkflowNoteNode.Type;

export const WorkflowNode = Schema.Union([WorkflowAgentNode, WorkflowNoteNode]);
export type WorkflowNode = typeof WorkflowNode.Type;

export const WORKFLOW_MAX_MARKS = 400;
/** Palette tokens for drawn marks; clients map them to their theme. */
export const WorkflowMarkColor = Schema.Literals(["ink", "red", "green", "blue", "orange"]);
export type WorkflowMarkColor = typeof WorkflowMarkColor.Type;

/** Hand-written text on the canvas (the Text tool). Resolve drawing reads it as hints; run agents never see it. */
export const WorkflowTextMark = Schema.Struct({
  kind: Schema.Literal("text"),
  id: WorkflowNodeId,
  x: Coordinate,
  y: Coordinate,
  text: Text(2_000),
  color: WorkflowMarkColor,
  size: Schema.Literals(["s", "m", "l", "xl"]),
});
export type WorkflowTextMark = typeof WorkflowTextMark.Type;

/**
 * A freehand marker line (the Marker tool). `points` is flat x,y pairs relative to
 * `x`,`y`. Decoration: agents never see it.
 */
export const WorkflowStrokeMark = Schema.Struct({
  kind: Schema.Literal("stroke"),
  id: WorkflowNodeId,
  x: Coordinate,
  y: Coordinate,
  points: Schema.Array(Coordinate).check(Schema.isMaxLength(4_000)),
  color: WorkflowMarkColor,
  weight: Schema.Literals(["thin", "bold", "extra"]),
});
export type WorkflowStrokeMark = typeof WorkflowStrokeMark.Type;

export const WorkflowMark = Schema.Union([WorkflowTextMark, WorkflowStrokeMark]);
export type WorkflowMark = typeof WorkflowMark.Type;

/**
 * `delegates`: `from` starts `to` as its subagent (the tree).
 * `then`: `to` starts only after `from` finished and receives its result. Both must be
 * children of the same parent; the parent sequences them.
 */
export const WorkflowEdge = Schema.Struct({
  id: WorkflowEdgeId,
  from: WorkflowNodeId,
  to: WorkflowNodeId,
  kind: Schema.Literals(["delegates", "then"]),
  label: Schema.optionalKey(Text(200)),
});
export type WorkflowEdge = typeof WorkflowEdge.Type;

export const WorkflowDefinition = Schema.Struct({
  version: Schema.Literal(1),
  id: WorkflowId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Text(1_000),
  /** The lead: an agent with no incoming `delegates` edge. Null while drafting. */
  rootNodeId: Schema.NullOr(WorkflowNodeId),
  nodes: Schema.Array(WorkflowNode).check(Schema.isMaxLength(WORKFLOW_MAX_NODES)),
  edges: Schema.Array(WorkflowEdge).check(Schema.isMaxLength(WORKFLOW_MAX_NODES * 2)),
  /** Text and marker drawings around the boxes. Absent on older workflows. */
  marks: Schema.optionalKey(
    Schema.Array(WorkflowMark).check(Schema.isMaxLength(WORKFLOW_MAX_MARKS)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

/** A problem that blocks starting a run, pointing at what to fix on the canvas. */
export const WorkflowIssue = Schema.Struct({
  nodeId: Schema.NullOr(WorkflowNodeId),
  edgeId: Schema.NullOr(WorkflowEdgeId),
  message: Text(300),
});
export type WorkflowIssue = typeof WorkflowIssue.Type;

export const WorkflowAgentStatus = Schema.Literals([
  "planned",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type WorkflowAgentStatus = typeof WorkflowAgentStatus.Type;

/** One real agent (chat) in a run, mapped to the box it fills. */
export const WorkflowRunAgent = Schema.Struct({
  nodeId: WorkflowNodeId,
  /** 0-based slot within the box (a `count` above 1 has several). */
  slot: NonNegativeInt,
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  /** Remote agents open in their owning environment. */
  threadLink: Schema.optionalKey(Text(4_000)),
  title: Text(200),
  model: Schema.NullOr(Schema.String),
  status: WorkflowAgentStatus,
  instanceId: Schema.optionalKey(ProviderInstanceId),
  machine: Schema.optionalKey(WorkflowAgentNode.fields.machine),
  isolation: Schema.optionalKey(WorkflowAgentNode.fields.isolation),
  /** Latest one-line progress, when the agent reports any. */
  progress: Schema.optionalKey(Text(300)),
  /** Set while the agent's chat has an open approval or question card. */
  needs: Schema.optionalKey(Schema.Literals(["approval", "input"])),
  /** The lead's grade for this agent's result (the note stays server-side). */
  grade: Schema.optionalKey(SubagentGrade.fields.score),
  /** Set on an agent started by Retry: the thread it replaced in this slot. */
  retryOf: Schema.optionalKey(ThreadId),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowRunAgent = typeof WorkflowRunAgent.Type;

export const WorkflowRunStatus = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowRunDiagnostic = Schema.Struct({
  kind: Schema.Literals(["missing", "failed", "skipped", "model", "placement", "predecessor"]),
  nodeId: WorkflowNodeId,
  threadId: Schema.NullOr(ThreadId),
  message: Text(300),
});
export type WorkflowRunDiagnostic = typeof WorkflowRunDiagnostic.Type;

export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflowId: WorkflowId,
  /** The definition as it was at start; later edits never change a running run. */
  snapshot: WorkflowDefinition,
  task: Text(20_000),
  /** `chat`: an existing chat used the workflow and leads it; it stays in the normal list. */
  origin: Schema.Literals(["workflows", "chat"]),
  leadThreadId: ThreadId,
  status: WorkflowRunStatus,
  agents: Schema.Array(WorkflowRunAgent),
  diagnostics: Schema.optionalKey(Schema.Array(WorkflowRunDiagnostic)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowsState = Schema.Struct({
  version: Schema.Literal(1),
  workflows: Schema.Array(WorkflowDefinition),
  /** Newest first, bounded by the server. */
  runs: Schema.Array(WorkflowRun),
});
export type WorkflowsState = typeof WorkflowsState.Type;

export const WorkflowOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("save"), workflow: WorkflowDefinition }),
  Schema.Struct({ type: Schema.Literal("delete"), id: WorkflowId }),
  Schema.Struct({ type: Schema.Literal("cancelRun"), runId: WorkflowRunId }),
  Schema.Struct({ type: Schema.Literal("deleteRun"), runId: WorkflowRunId }),
  /** Stops one agent and the agents it started; the rest of the run continues. */
  Schema.Struct({ type: Schema.Literal("stopAgent"), runId: WorkflowRunId, threadId: ThreadId }),
  /** Starts a finished, failed or stopped agent again in the same slot with its original brief. */
  Schema.Struct({ type: Schema.Literal("retryAgent"), runId: WorkflowRunId, threadId: ThreadId }),
]);
export type WorkflowOperation = typeof WorkflowOperation.Type;

/**
 * Ask the compile model (GPT-6.1 Terra when offered, else a ready provider's
 * default) to turn the canvas, a description, or both into a resolved
 * workflow. Returns a proposal; nothing is saved until the client saves it.
 */
export const WorkflowCompileRequest = Schema.Struct({
  workflow: WorkflowDefinition,
  /** Optional words: "Opus leads, two Sol workers, each with many Haiku agents". */
  prompt: Schema.optionalKey(Text(8_000)),
  model: Schema.optionalKey(ModelSelection),
  /** Sketch arrows have coordinates until compile snaps their endpoints to boxes. */
  unboundArrows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: WorkflowEdgeId,
        from: Schema.Struct({ x: Coordinate, y: Coordinate }),
        to: Schema.Struct({ x: Coordinate, y: Coordinate }),
        kind: Schema.Literals(["delegates", "then"]),
      }),
    ).check(Schema.isMaxLength(WORKFLOW_MAX_NODES * 2)),
  ),
});
export type WorkflowCompileRequest = typeof WorkflowCompileRequest.Type;

export const WorkflowCompileResult = Schema.Struct({
  workflow: WorkflowDefinition,
  issues: Schema.Array(WorkflowIssue),
  /** One or two sentences on what the model changed or could not resolve. */
  summary: Text(1_000),
});
export type WorkflowCompileResult = typeof WorkflowCompileResult.Type;

export const WorkflowStartRequest = Schema.Struct({
  workflowId: WorkflowId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  /** Set when a normal chat uses the workflow: that chat becomes the lead. */
  chatThreadId: Schema.optionalKey(ThreadId),
});
export type WorkflowStartRequest = typeof WorkflowStartRequest.Type;

export const WorkflowStartResult = Schema.Struct({
  runId: WorkflowRunId,
  leadThreadId: ThreadId,
});
export type WorkflowStartResult = typeof WorkflowStartResult.Type;

export class WorkflowsError extends Schema.TaggedError<WorkflowsError>()("WorkflowsError", {
  reason: Schema.Literals(["read", "decode", "write", "invalid", "notFound", "compile", "start"]),
  message: Schema.String,
  issues: Schema.optionalKey(Schema.Array(WorkflowIssue)),
}) {}

import type {
  OrchestrationV2ProviderFailure,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpWireSchema from "effect-acp/schema-v1";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { acpToolCallDiffPatch } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

const TOOL_TEXT_LIMIT = 8_000;
const DIFF_PATCH_TEXT_LIMIT = 32_000;
const TOOL_TEXT_TRUNCATED = "[Earlier output truncated]\n\n";
const DIFF_PATCH_TRUNCATED = "\n... [diff truncated]";
const QUESTION_LABEL_LIMIT = 512;

const NativeToolFields = Schema.Struct({
  command: Schema.optional(Schema.String),
  CommandLine: Schema.optional(Schema.String),
  command_line: Schema.optional(Schema.String),
  commandLine: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  Cwd: Schema.optional(Schema.String),
  WorkingDirectory: Schema.optional(Schema.String),
  working_dir: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
  combinedOutput: Schema.optional(Schema.String),
  combined_output: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  exit_code: Schema.optional(Schema.Int),
  imagePath: Schema.optional(Schema.String),
});
const decodeNativeToolFields = Schema.decodeUnknownOption(NativeToolFields);
const decodeSingleAnswer = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Tuple([Schema.String])]),
);
const decodeToolCallContent = Schema.decodeUnknownOption(AcpWireSchema.ToolCallContent);
const isToolCallMeta = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * The agent goes on running a command after its prompt ends, and replies by itself when the
 * command finishes. A daemon may never finish.
 */
export function antigravityCommandOutlivesPrompt(toolCall: AcpToolCallState): boolean {
  const input = toolCall.data.rawInput;
  return toolCall.kind === "execute" && !(Predicate.isObject(input) && input.IsDaemon === true);
}

/**
 * agy's own `schedule` timer. Its call stays in progress until the timer fires, then the agent
 * wakes by itself with no prompt open (agy 1.5.13).
 */
export function isAntigravityScheduleTool(toolCall: AcpToolCallState): boolean {
  const input = toolCall.data.rawInput;
  return (
    toolCall.kind !== "execute" &&
    Predicate.isObject(input) &&
    typeof input.DurationSeconds === "number" &&
    typeof input.Prompt === "string"
  );
}

/** Native questions share the permission method, but their choices are not approvals. */
export function isAntigravityUserInputRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return request.toolCall.toolCallId.startsWith("interaction_");
}

export function selectAntigravityPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel" || isAntigravityUserInputRequest(request)) {
    return undefined;
  }
  const kind =
    decision === "accept" ? "allow_once" : decision === "decline" ? "reject_once" : "allow_always";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() ? option.optionId : undefined;
}

/** Copy truncated text so V8 cannot retain the original large string. */
const SECURITY_WARNING_META_KEY = "agy.security.warning";
const WARNING_TEXT_LIMIT = 512;
const decodeSecurityWarning = Schema.decodeUnknownOption(
  Schema.Struct({
    title: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);

/**
 * The agent marks "Allow Always" on shell and web tools with a prompt injection
 * warning in `_meta`. Surface it as option text so both clients can show it.
 */
function antigravitySecurityWarning(option: EffectAcpSchema.PermissionOption): string | undefined {
  const meta = option._meta;
  if (!Predicate.isObject(meta)) return undefined;
  const warning = Option.getOrUndefined(decodeSecurityWarning(meta[SECURITY_WARNING_META_KEY]));
  const text = warning?.message?.trim() || warning?.title?.trim();
  if (!text) return undefined;
  return text.length > WARNING_TEXT_LIMIT
    ? copyBoundedText(`${text.slice(0, WARNING_TEXT_LIMIT - 3)}...`)
    : text;
}

/** Only advertise decisions that the native request can honor. */
export function antigravityApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  if (isAntigravityUserInputRequest(request)) return [];
  const options: ProviderApprovalOption[] = [];
  const optionWithKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((entry) => entry.kind === kind && entry.optionId.trim());
  const once = optionWithKind("allow_once");
  if (once) {
    options.push({ decision: "accept", label: "Allow once" });
  }
  const always = optionWithKind("allow_always");
  if (always) {
    const warning = antigravitySecurityWarning(always);
    options.push({
      decision: "acceptForSession",
      label: "Allow for this thread",
      ...(warning ? { warning } : {}),
    });
  }
  if (optionWithKind("reject_once")) {
    options.push({ decision: "decline", label: "Deny" });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}

function copyBoundedText(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

function boundQuestionText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "");
  return copyBoundedText(`${prefix}...`);
}

function questionLabel(option: EffectAcpSchema.PermissionOption): string {
  return boundQuestionText(option.name.trim() || option.optionId, QUESTION_LABEL_LIMIT);
}

export function extractAntigravityUserInputQuestion(
  request: EffectAcpSchema.RequestPermissionRequest,
): UserInputQuestion | undefined {
  if (!isAntigravityUserInputRequest(request) || request.options.length === 0) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const option of request.options) {
    if (!option.optionId.trim() || ids.has(option.optionId)) {
      return undefined;
    }
    ids.add(option.optionId);
  }
  const question = request.toolCall.title?.trim() || "Choose an option.";
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question: boundQuestionText(question, TOOL_TEXT_LIMIT),
    multiSelect: false,
    allowCustomAnswer: false,
    options: request.options.map((option) => ({
      value: option.optionId,
      label: questionLabel(option),
      description: questionLabel(option),
    })),
  };
}

/** Return undefined for an invalid answer so the adapter keeps the question open. */
export function makeAntigravityUserInputResponse(
  request: EffectAcpSchema.RequestPermissionRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.RequestPermissionResponse | undefined {
  if (extractAntigravityUserInputQuestion(request) === undefined) {
    return undefined;
  }
  const answer = Option.getOrUndefined(decodeSingleAnswer(answers[request.toolCall.toolCallId]));
  const value = typeof answer === "string" ? answer : answer?.[0];
  if (value === undefined) {
    return undefined;
  }
  const exact = request.options.find((option) => option.optionId === value);
  if (exact) {
    return { outcome: { outcome: "selected", optionId: exact.optionId } };
  }
  const matchingLabels = request.options.filter((option) => questionLabel(option) === value);
  const option = matchingLabels.length === 1 ? matchingLabels[0] : undefined;
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
}

function boundText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit
    ? text
    : copyBoundedText(`${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`);
}

function boundCommandOutput(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + TOOL_TEXT_TRUNCATED.length && text.startsWith(TOOL_TEXT_TRUNCATED))
  ) {
    return text;
  }
  const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, "");
  return copyBoundedText(`${TOOL_TEXT_TRUNCATED}${tail}`);
}

function boundDiffPatch(text: string, limit = DIFF_PATCH_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + DIFF_PATCH_TRUNCATED.length && text.endsWith(DIFF_PATCH_TRUNCATED))
  ) {
    return text;
  }
  const head = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  return copyBoundedText(`${head}${DIFF_PATCH_TRUNCATED}`);
}

/**
 * Computes a compact unified patch for ACP v1 diffs whose `oldText`/`newText` exceed
 * `TOOL_TEXT_LIMIT` before tail-truncation can erase early edits, and head-bounds v2
 * `patch.text` so diff headers (`---`/`+++`/`@@`) stay intact on subsequent sanitizations.
 */
function sanitizeAntigravityDiffContent(
  entry: Record<string, unknown>,
  updateKind: EffectAcpSchema.ToolKind | null | undefined,
  budget: ToolPayloadBudget,
): EffectAcpSchema.ToolCallContent | undefined {
  if (Array.isArray(entry.changes)) {
    const changes = entry.changes.flatMap((candidate) => {
      if (!Predicate.isObject(candidate)) return [];
      const operation =
        candidate.operation === "add" ||
        candidate.operation === "modify" ||
        candidate.operation === "delete"
          ? candidate.operation
          : undefined;
      const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
      if (operation === undefined || path.length === 0) return [];
      const boundedPath = boundText(path);
      return [{ operation, path: boundedPath }];
    });
    if (changes.length === 0) return undefined;
    const rawPatch = Predicate.isObject(entry.patch) ? entry.patch : undefined;
    const rawPatchText = typeof rawPatch?.text === "string" ? rawPatch.text : undefined;
    const boundedPatch =
      rawPatchText !== undefined && budget.text > 0
        ? boundDiffPatch(rawPatchText, Math.min(DIFF_PATCH_TEXT_LIMIT, budget.text))
        : undefined;
    if (boundedPatch !== undefined) {
      budget.text -= boundedPatch.length;
    }
    const format =
      typeof rawPatch?.format === "string" && rawPatch.format.trim().length > 0
        ? boundText(rawPatch.format.trim(), 64)
        : "unified";
    return {
      type: "diff",
      changes,
      ...(boundedPatch === undefined ? {} : { patch: { format, text: boundedPatch } }),
    };
  }
  if (typeof entry.path !== "string" || typeof entry.newText !== "string") {
    return undefined;
  }
  const path = entry.path.trim();
  if (path.length === 0) return undefined;
  const oldText = typeof entry.oldText === "string" ? entry.oldText : undefined;
  const rawLength = (oldText?.length ?? 0) + entry.newText.length;
  if (
    (oldText?.length ?? 0) <= TOOL_TEXT_LIMIT &&
    entry.newText.length <= TOOL_TEXT_LIMIT &&
    rawLength <= budget.text
  ) {
    return Option.getOrUndefined(decodeToolCallContent(sanitizeToolValue(entry, budget, 0)));
  }
  const patchText = acpToolCallDiffPatch([entry]);
  const boundedPatch =
    patchText !== undefined && budget.text > 0
      ? boundDiffPatch(patchText, Math.min(DIFF_PATCH_TEXT_LIMIT, budget.text))
      : undefined;
  if (boundedPatch !== undefined) {
    budget.text -= boundedPatch.length;
  }
  const operation = updateKind === "delete" ? "delete" : oldText === undefined ? "add" : "modify";
  return {
    type: "diff",
    changes: [{ operation, path: boundText(path) }],
    ...(boundedPatch === undefined ? {} : { patch: { format: "unified", text: boundedPatch } }),
  };
}

// 1.5 runtimes report command output as `output` and repeat it as content `text`.
const OUTPUT_TEXT_FIELDS = new Set(["combinedOutput", "combined_output", "output", "text"]);

interface ToolPayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(
  value: unknown,
  budget: ToolPayloadBudget,
  depth: number,
  field?: string,
): unknown {
  if (depth > 12 || budget.nodes-- <= 0) {
    return undefined;
  }
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || budget.text <= 0) {
      return undefined;
    }
    const bound =
      field !== undefined && OUTPUT_TEXT_FIELDS.has(field) ? boundCommandOutput : boundText;
    const text = bound(value, Math.min(TOOL_TEXT_LIMIT, budget.text));
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const sanitized = sanitizeToolValue(entry, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  if (!Predicate.isObject(value)) {
    return value;
  }
  if (value.type === "diff" && Array.isArray(value.changes)) {
    return sanitizeAntigravityDiffContent(value, undefined, budget);
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break;
    if (
      (value.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" &&
        typeof value.mimeType === "string" &&
        value.mimeType.startsWith("image/")) ||
      ((key === "formatted_output" || key === "formattedOutput") &&
        (entry === value.combinedOutput || entry === value.combined_output))
    ) {
      continue;
    }
    const sanitized = sanitizeToolValue(entry, budget, depth + 1, key);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

/** Bound both retained raw events and display data before they enter the event stream. */
export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}

/** The runtime uses this before it retains tool state or dispatches raw callbacks. */
const ANTIGRAVITY_CLIENT_READ_TITLES = new Set([
  "Running client_view_file",
  "Run client_view_file?",
]);

function antigravityClientReadPath(update: {
  readonly title?: string | null;
  readonly locations?: ReadonlyArray<{ readonly path: string }> | null;
  readonly rawInput?: unknown;
}): string | undefined {
  if (!update.title || !ANTIGRAVITY_CLIENT_READ_TITLES.has(update.title)) return undefined;
  const target =
    update.locations?.[0]?.path ??
    (Predicate.isObject(update.rawInput) ? update.rawInput.absolute_path : undefined);
  return typeof target === "string" && target ? target : undefined;
}

/**
 * The agent never completes a subagent's `client_view_file` call, then fails every open call
 * with the next unrelated step error. Report reads T3 served as completed instead.
 */
export function makeAntigravityReadRepair() {
  type Outcome = "served" | "refused";
  const openReads = new Map<
    string,
    { readonly path: string; readonly sessionId: string; outcome?: Outcome }
  >();
  // The agent runs a client tool in a background task, so its request can precede the announcement.
  const earlyOutcomes: Array<{ readonly path: string; readonly outcome: Outcome }> = [];
  return {
    /** Earlier turns' rows are already settled, and their unanswered reads must not take credit. */
    reset: () => {
      openReads.clear();
      earlyOutcomes.length = 0;
    },
    /**
     * Each `fs/read_text_file` request answers the oldest open read of its path, in order.
     * Returns the call a served read completes, so T3 can report it without waiting.
     */
    attempted: (path: string, served: boolean) => {
      const outcome = served ? "served" : "refused";
      for (const [toolCallId, read] of openReads) {
        if (read.path !== path || read.outcome !== undefined) continue;
        read.outcome = outcome;
        return served ? { sessionId: read.sessionId, toolCallId } : undefined;
      }
      earlyOutcomes.push({ path, outcome });
      return undefined;
    },
    repair: (
      notification: EffectAcpSchema.SessionNotification,
    ): EffectAcpSchema.SessionNotification => {
      const update = notification.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return notification;
      }
      const path = antigravityClientReadPath(update);
      if (path !== undefined && !openReads.has(update.toolCallId)) {
        const early = earlyOutcomes.findIndex((entry) => entry.path === path);
        const outcome = early === -1 ? undefined : earlyOutcomes.splice(early, 1)[0]?.outcome;
        const sessionId = notification.sessionId;
        openReads.set(
          update.toolCallId,
          outcome === undefined ? { path, sessionId } : { path, sessionId, outcome },
        );
      }
      const read = openReads.get(update.toolCallId);
      if (update.status === "pending" || update.status === "in_progress") {
        return read?.outcome === "served"
          ? { ...notification, update: { ...update, status: "completed" } }
          : notification;
      }
      if (update.status !== "completed" && update.status !== "failed") return notification;
      openReads.delete(update.toolCallId);
      if (update.status === "completed" || read?.outcome !== "served") return notification;
      const { rawOutput: _stepError, ...rest } = update;
      return { ...notification, update: { ...rest, status: "completed" } };
    },
  };
}

export function normalizeAntigravitySessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return notification;
  }
  const contentBudget = { nodes: 512, text: 32_000 };
  const content = update.content?.flatMap((entry) => {
    if (entry.type === "diff") {
      const sanitizedDiff = sanitizeAntigravityDiffContent(entry, update.kind, contentBudget);
      return sanitizedDiff === undefined ? [] : [sanitizedDiff];
    }
    const decoded = Option.getOrUndefined(
      decodeToolCallContent(sanitizeToolValue(entry, contentBudget, 0)),
    );
    return decoded === undefined ? [] : [decoded];
  });
  const meta = sanitizeAntigravityToolPayload(update._meta);
  return {
    ...notification,
    update: {
      ...update,
      ...(typeof update.title === "string" ? { title: boundText(update.title) } : {}),
      ...(update.rawInput !== undefined
        ? { rawInput: sanitizeAntigravityToolPayload(update.rawInput) }
        : {}),
      ...(update.rawOutput !== undefined
        ? { rawOutput: sanitizeAntigravityToolPayload(update.rawOutput) }
        : {}),
      ...(update.content !== undefined ? { content: content ?? [] } : {}),
      ...(update._meta !== undefined ? { _meta: isToolCallMeta(meta) ? meta : null } : {}),
    },
  };
}

function antigravityUpdateSteps(
  rawInput: unknown,
):
  | Extract<EffectAcpSchema.SessionUpdate, { readonly sessionUpdate: "plan" }>["entries"]
  | undefined {
  if (!Predicate.isObject(rawInput) || !Array.isArray(rawInput.steps)) return undefined;
  const steps: ReadonlyArray<unknown> = rawInput.steps;
  return steps.flatMap((step) =>
    Predicate.isObject(step) && typeof step.title === "string"
      ? [
          {
            content: step.title,
            priority: "medium",
            status:
              step.status === "done"
                ? "completed"
                : step.status === "skipped"
                  ? "cancelled"
                  : step.status === "in_progress"
                    ? "in_progress"
                    : "pending",
          },
        ]
      : [],
  );
}

/**
 * agy reports its update_steps checklist only as tool calls, never as ACP `plan` updates. Each
 * call carrying steps becomes a plan update; its other updates name it by id only and are dropped.
 */
export function makeAntigravityUpdateStepsPlans() {
  const calls = new Set<string>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification | undefined => {
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const key = `${notification.sessionId}\u0000${update.toolCallId}`;
    if (
      typeof update.title === "string" &&
      /^(?:Run|Running) (?:default_api:)?update_steps\??$/.test(update.title) &&
      (update.kind === undefined || update.kind === null || update.kind === "other")
    ) {
      calls.add(key);
    }
    if (!calls.has(key)) return notification;
    if (update.status === "completed" || update.status === "failed") calls.delete(key);
    const entries = antigravityUpdateSteps(update.rawInput);
    return entries === undefined
      ? undefined
      : { ...notification, update: { sessionUpdate: "plan", entries } };
  };
}

function localImagePath(imagePath: string | undefined): string | undefined {
  if (!imagePath || imagePath.length > TOOL_TEXT_LIMIT) {
    return undefined;
  }
  const path = imagePath.trim();
  if (!isWorkspaceImagePreviewPath(path)) {
    return undefined;
  }
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return undefined;
    }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) ? undefined : path;
}

function antigravityOrchestrationToolTitle(
  rawTitle: string | undefined,
  rawInput: unknown,
): string | undefined {
  if (rawTitle === undefined) return undefined;
  const input = Predicate.isObject(rawInput) ? rawInput : undefined;
  if (/^Run(?:ning)? manage_task\b/u.test(rawTitle)) {
    const action = typeof input?.Action === "string" ? input.Action.toLowerCase() : "";
    switch (action) {
      case "list":
        return "List background tasks";
      case "status":
        return "Check background task";
      case "kill":
        return "Stop background task";
      case "send_input":
        return "Send input to background task";
      default:
        return "Manage background task";
    }
  }
  if (/^Run(?:ning)? manage_subagents\b/u.test(rawTitle)) {
    const action = typeof input?.Action === "string" ? input.Action.toLowerCase() : "";
    switch (action) {
      case "list":
        return "List subagents";
      case "kill":
        return "Stop subagent";
      case "kill_all":
        return "Stop all subagents";
      default:
        return "Manage subagents";
    }
  }
  if (/^Run(?:ning)? schedule\b/u.test(rawTitle)) {
    if (typeof input?.DurationSeconds === "number") return "Set timer";
    if (typeof input?.CronExpression === "string") return "Schedule recurring job";
    return "Schedule task";
  }
  return undefined;
}

export function normalizeAntigravityToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  const input = Option.getOrUndefined(decodeNativeToolFields(toolCall.data.rawInput));
  const output = Option.getOrUndefined(decodeNativeToolFields(toolCall.data.rawOutput));
  const nativeCommand =
    input?.CommandLine ??
    input?.command_line ??
    input?.commandLine ??
    input?.command ??
    output?.commandLine ??
    output?.command_line ??
    toolCall.command;
  const command = nativeCommand?.trim() ? boundText(nativeCommand.trim()) : undefined;
  const nativeCwd =
    input?.Cwd ??
    input?.WorkingDirectory ??
    input?.working_dir ??
    input?.workingDir ??
    input?.cwd ??
    output?.workingDir ??
    output?.working_dir;
  const cwd = nativeCwd?.trim() ? boundText(nativeCwd.trim()) : undefined;
  const nativeOutput = output?.combinedOutput ?? output?.combined_output;
  const aggregatedOutput =
    nativeOutput === undefined ? undefined : boundCommandOutput(nativeOutput);
  const exitCode = output?.exitCode ?? output?.exit_code;
  const imagePath = localImagePath(output?.imagePath);
  const sanitizedData = sanitizeAntigravityToolPayload(toolCall.data);
  const data: Record<string, unknown> = Predicate.isObject(sanitizedData) ? sanitizedData : {};
  const kind = toolCall.kind ?? (command !== undefined ? "execute" : undefined);
  if (kind !== undefined) data.kind = kind;
  if (command !== undefined) data.command = command;
  if (cwd !== undefined) data.cwd = cwd;
  if (imagePath !== undefined) data.imagePath = imagePath;
  if (kind === "execute") {
    data.item = {
      ...(Predicate.isObject(data.item) ? data.item : {}),
      ...(command !== undefined ? { command } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(aggregatedOutput !== undefined ? { aggregatedOutput } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  const rawTitle = typeof data.title === "string" ? data.title : toolCall.title;
  const orchestrationTitle = antigravityOrchestrationToolTitle(rawTitle, data.rawInput);
  if (
    orchestrationTitle !== undefined &&
    typeof data.title !== "string" &&
    rawTitle !== undefined
  ) {
    data.title = boundText(rawTitle);
  }
  const title =
    orchestrationTitle ?? (toolCall.title !== undefined ? boundText(toolCall.title) : undefined);
  return {
    ...toolCall,
    ...(kind !== undefined ? { kind } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(command !== undefined
      ? { detail: command }
      : toolCall.detail !== undefined
        ? { detail: boundText(toolCall.detail) }
        : {}),
    data,
  };
}

/** Only commands still running after end_turn become background tasks. */
export function isAntigravityOpenCommand(toolCall: AcpToolCallState): boolean {
  return toolCall.kind === "execute" && toolCall.status === "inProgress";
}

const ANTIGRAVITY_SUBAGENT_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  // agy 1.5 auto-approved calls.
  "Run invoke_subagent",
]);

/** The ACP agent reports subagent calls as ordinary tools without child IDs or models. */
export function classifyAntigravitySubagentToolCall(
  toolCall: AcpToolCallState,
  rawPayload?: unknown,
): "subagent" | "mcp" | undefined {
  if (
    (toolCall.kind !== undefined && toolCall.kind !== "other") ||
    toolCall.title === undefined ||
    !ANTIGRAVITY_SUBAGENT_TITLES.has(toolCall.title)
  )
    return undefined;
  const update = Predicate.isObject(rawPayload) ? rawPayload.update : undefined;
  const meta = Predicate.isObject(update) ? update._meta : toolCall.data.meta;
  return Predicate.isObject(meta) && meta.is_mcp_tool_call === true ? "mcp" : "subagent";
}

/** History sends a completed start before the separate result and its final status. */
export function isAntigravitySubagentReplayStart(rawPayload: unknown): boolean {
  const update = Predicate.isObject(rawPayload) ? rawPayload.update : undefined;
  return (
    Predicate.isObject(update) &&
    update.sessionUpdate === "tool_call" &&
    update.status === "completed" &&
    (update.rawOutput === undefined || update.rawOutput === null)
  );
}

export function antigravitySubagentOutput(toolCall: AcpToolCallState): string | undefined {
  const output = toolCall.data.rawOutput;
  return typeof output === "string" && output.trim() ? boundText(output.trim()) : undefined;
}

/** agy reports each named Swarm launch as a separate tool call. A completed add is a launch ACK. */
export function antigravitySwarmWorker(toolCall: AcpToolCallState) {
  if (
    toolCall.kind !== "other" ||
    !/^Run(?:ning)? swarm\??$/u.test(toolCall.title ?? "") ||
    (Predicate.isObject(toolCall.data.meta) && toolCall.data.meta.is_mcp_tool_call === true)
  ) {
    return undefined;
  }
  const input = toolCall.data.rawInput;
  if (!Predicate.isObject(input) || input.action !== "add") return undefined;
  const title = nonEmptyRawField(input, ["name"]);
  if (title === undefined) return undefined;
  const model = nonEmptyRawField(input, ["model"]);
  return {
    title,
    prompt: nonEmptyRawField(input, ["brief"]) ?? title,
    model: model?.toLowerCase() === "inherit" ? undefined : model,
  };
}

function nonEmptyRawField(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return boundText(value.trim());
  }
  return undefined;
}

/** Extracts Role/TypeName, Prompt, and explicit Model from agy 1.5 `invoke_subagent` input. */
export function antigravitySubagentInput(toolCall: AcpToolCallState): {
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly model: string | undefined;
} {
  const input = toolCall.data.rawInput;
  if (!Predicate.isObject(input)) {
    return { prompt: undefined, title: undefined, model: undefined };
  }
  const prompt = nonEmptyRawField(input, ["Prompt", "prompt"]);
  const title = nonEmptyRawField(input, ["Role", "role", "TypeName", "typeName", "type_name"]);
  const rawModel = nonEmptyRawField(input, ["Model", "model"]);
  const model =
    rawModel !== undefined && rawModel.toLowerCase() !== "inherit" ? rawModel : undefined;
  return { prompt, title, model };
}

/**
 * `agy acp` reports uncached input tokens in `usage.inputTokens` alongside
 * `cachedReadTokens` and `cachedWriteTokens`, so `totalTokens` equals
 * `inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`.
 * `TurnTokenUsage` expects `inputTokens` to include cache read and write tokens.
 */
export function normalizeAntigravityPromptUsage(
  usage: EffectAcpSchema.Usage,
): EffectAcpSchema.Usage {
  const cachedRead = usage.cachedReadTokens ?? 0;
  const cachedWrite = usage.cachedWriteTokens ?? 0;
  if (cachedRead === 0 && cachedWrite === 0) return usage;
  const uncachedTotal = usage.inputTokens + cachedRead + cachedWrite + usage.outputTokens;
  if (usage.totalTokens === uncachedTotal) {
    return {
      ...usage,
      inputTokens: usage.inputTokens + cachedRead + cachedWrite,
    };
  }
  return usage;
}

// The runtime spells the wait to its two largest units, rounded down, or names the UTC minute.
const RUNTIME_QUOTA_NOTICE =
  /^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: Your limit will reset (?:in ((?:\d+ (?:day|hour|minute|second)s?)(?:, \d+ (?:day|hour|minute|second)s?)?)|on ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{2}):(\d{2}) UTC)\.)?$/u;
const RUNTIME_QUOTA_UNIT_MILLIS: Readonly<Record<string, number>> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function runtimeQuotaResetAt(match: RegExpExecArray, now: DateTime.Utc): string | undefined {
  const [, wait, month, day, year, hour, minute] = match;
  if (wait !== undefined) {
    const units = wait.split(", ").map((part) => {
      const [amount, unit] = part.split(" ");
      return {
        amount: Number(amount),
        millis: RUNTIME_QUOTA_UNIT_MILLIS[unit!.replace(/s$/u, "")]!,
      };
    });
    // One more of the smallest unit shown keeps the rounded-down wait from ending early.
    const millis =
      units.reduce((total, unit) => total + unit.amount * unit.millis, 0) +
      Math.min(...units.map((unit) => unit.millis));
    return DateTime.formatIso(DateTime.add(now, { milliseconds: millis }));
  }
  const monthIndex = month === undefined ? -1 : MONTHS.indexOf(month);
  if (monthIndex < 0) return undefined;
  const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day!.padStart(2, "0")}T${hour}:${minute}:00.000Z`;
  return Option.getOrUndefined(Option.map(DateTime.make(iso), DateTime.formatIso));
}

// The agy CLI passes on Google's notice, with the wait as a Go duration ("4h33m33s", "42.5s").
const CLI_QUOTA_NOTICE =
  /^(?:⚠\s*)?Individual quota reached\.[^\n]*?\bResets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?\.?(?:\s*\nError ID: \S+)?$/iu;

function cliQuotaResetAt(match: RegExpExecArray, now: DateTime.Utc): string | undefined {
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;
  const totalSeconds = (Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0);
  return DateTime.formatIso(DateTime.add(now, { milliseconds: Math.round(totalSeconds * 1000) }));
}

/**
 * Antigravity reports a spent quota as an ordinary reply and then ends the prompt. Its managed
 * ACP runtime writes its own notice, "Usage Limit Reached\n\nYou have reached your current
 * quota for this period. Your limit will reset in 4 hours, 33 minutes.", and ends on `refusal`
 * (the SDK's QUOTA_EXHAUSTED stop), or on `end_turn` when the model call threw. The agy CLI
 * passes on Google's notice, "⚠ Individual quota reached. Please upgrade your subscription to
 * increase your limits. Resets in 4h33m33s.", and ends on `end_turn`; Google AI Ultra and Pro
 * word it alike, and Pro has also shown the request's error id on a line below. Only a reply
 * that is a notice and nothing else counts, so an answer quoting one is left alone.
 */
export function antigravityPromptStopFailure(input: {
  readonly stopReason: EffectAcpSchema.StopReason;
  readonly replyText: string | undefined;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderFailure | undefined {
  if (input.stopReason !== "refusal" && input.stopReason !== "end_turn") return undefined;
  const message = input.replyText?.trim();
  if (!message) return undefined;
  let resetAt: string | undefined;
  const runtime = RUNTIME_QUOTA_NOTICE.exec(message);
  if (runtime !== null) {
    resetAt = runtimeQuotaResetAt(runtime, input.now);
  } else {
    const cli = CLI_QUOTA_NOTICE.exec(message);
    resetAt = cli === null ? undefined : cliQuotaResetAt(cli, input.now);
    // The CLI's notice always names its wait.
    if (resetAt === undefined) return undefined;
  }
  return makeProviderFailure({
    class: "usage_limit",
    code: "antigravity_quota",
    message,
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

// agy kills a command through its own `manage_task` tool. It reports the command failed with no
// exit code and nothing printed at the moment the kill call runs, and names no tool call.
const AGENT_KILL_WINDOW_MILLIS = 2_000;
const MANAGED_RUNTIME_KILL_NOTE = /^Killed by manage_task\([^)]*\)$/u;

function isAntigravityKillCall(toolCall: AcpToolCallState): boolean {
  const input = toolCall.data.rawInput;
  const rawTitle =
    typeof toolCall.data.title === "string" ? toolCall.data.title : (toolCall.title ?? "");
  return (
    /^Run(?:ning)? manage_task\b/u.test(rawTitle) &&
    Predicate.isObject(input) &&
    typeof input.Action === "string" &&
    input.Action.toLowerCase() === "kill"
  );
}

/** A failed command with no exit code and no output, or the managed runtime's kill note. */
function antigravityCommandStopShape(toolCall: AcpToolCallState): "silent" | "killed" | undefined {
  if (toolCall.status !== "failed" || toolCall.kind !== "execute") return undefined;
  const { rawOutput, content, item } = toolCall.data;
  if (typeof rawOutput === "string" && MANAGED_RUNTIME_KILL_NOTE.test(rawOutput.trim())) {
    return "killed";
  }
  const reported = Predicate.isObject(item) ? item : {};
  const printed =
    (rawOutput !== undefined && rawOutput !== null && rawOutput !== "") ||
    (Array.isArray(content) && content.length > 0);
  return reported.exitCode === undefined && reported.aggregatedOutput === undefined && !printed
    ? "silent"
    : undefined;
}

/**
 * One turn's matcher for commands the agent stopped itself: a command that fails silently
 * while a `manage_task` kill call runs, or within two seconds of it, was killed, not broken.
 * Returns the tool call ids to show as stopped, including a failure reported just before the
 * kill call that explains it.
 */
export function makeAntigravityStoppedTools() {
  const kills = new Map<string, { readonly from: number; until: number | undefined }>();
  const unexplained = new Map<string, number>();
  const killedAt = (at: number) =>
    [...kills.values()].some(
      (kill) =>
        at >= kill.from - AGENT_KILL_WINDOW_MILLIS &&
        (kill.until === undefined || at <= kill.until + AGENT_KILL_WINDOW_MILLIS),
    );
  return (toolCall: AcpToolCallState, nowMillis: number): ReadonlyArray<string> => {
    if (isAntigravityKillCall(toolCall)) {
      if (toolCall.status === "failed") {
        kills.delete(toolCall.toolCallId);
        return [];
      }
      const kill = kills.get(toolCall.toolCallId) ?? { from: nowMillis, until: undefined };
      if (toolCall.status === "completed") kill.until ??= nowMillis;
      kills.set(toolCall.toolCallId, kill);
      const explained = [...unexplained].flatMap(([id, at]) => (killedAt(at) ? [id] : []));
      for (const id of explained) unexplained.delete(id);
      return explained;
    }
    const shape = antigravityCommandStopShape(toolCall);
    if (shape === undefined) return [];
    if (shape === "killed" || killedAt(nowMillis)) return [toolCall.toolCallId];
    unexplained.set(toolCall.toolCallId, nowMillis);
    return [];
  };
}

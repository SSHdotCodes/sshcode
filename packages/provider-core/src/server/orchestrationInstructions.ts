import * as Context from "effect/Context";
import type { ProviderInteractionMode } from "@t3tools/contracts";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

/** The grading rule inside the lead bullet; removed when Settings turns grading off. */
const GRADING_CLAUSE =
  "; rate each checked one via `grades` on your next subagent tool call, or a `task_status` before your final reply if none follows (feeds model rankings)";

const MODEL_PREFERENCES_CLAUSE =
  " Otherwise consult `model_preferences` for the relevant task before delegating; family ranks follow new releases; choose a current model in the preferred family. Only the user edits preferences in Settings.";

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## SSHCode orchestration

The \`t3-code\` MCP server adds app capabilities beyond your harness:
- Check SSHCode UI changes with \`qa_sandbox\` (isolated app, fake models).
- For browser work, use the \`preview_*\` tools: start with \`preview_status\`; read tabs the user is driving and open your own to act. Don't enable tools disabled in Settings > Tools.
- X (Twitter): use \`search_x\` whenever you want, like web search (news, reactions, anything recent); \`read_x_post\` reads a link.
- The user picked your model for this chat, usually the strongest one: you lead and do almost all of the work yourself. Keep the plan, critical path, hard problems, visual design, writing voice and key decisions; if you delegate UI code, supply the design. Decide on your own when other agents pay off; as applicable instructions, these explicitly ask for delegation and parallel agent work in these cases, without the user asking: split independent pieces of an hour or more each across parallel children (\`isolation:"worktree"\` when they edit) while you work on your own piece, never one after another while you wait; hand off large source sweeps you only need summarized (not single pages), a fresh look after two wrong diagnoses, work needing a capability you lack (such as computer use or seeing images), or work your own quota can't cover (about 97% used or limited). Do self-contained builds and demos the user judges by their result yourself (often a test of your model) unless you lack a needed capability, and skip subagents for small or tightly coupled work, when the brief and review cost more than doing it, or when they would share a bottleneck (GPU, machine, queue, build or checkout). Don't over-trust code you wrote: before it drives paid or long unattended runs or training or grading data (control and export scripts included), another provider's review usually pays off, even if your tests pass; check other work yourself by running, testing or looking at it. Spare quota elsewhere, or your own running high, is no reason. The user's word on subagents holds for the whole chat. Review and integrate what children return${GRADING_CLAUSE}. \`council\` asks 2-4 other models one question blind: use it when the user asks, or before a hard-to-reverse design decision; then decide and explain.
- For a speed goal, measure end to end first and target the bottleneck. Start only as many agents as you can review; scale down when more won't help.
- Explicit user model choices come first.${MODEL_PREFERENCES_CLAUSE}
- Honor the user's models and reviewer count. 'Up to N' is a ceiling. Otherwise choose current models from \`orchestrator_capabilities\`, check \`usage_limits\` (may be stale), and send most subagents to other providers' best-fit models, Grok included: weigh intelligence, speed, quota cost and \`yourRuns\` when shown, not price tier (benchmarks like Artificial Analysis or Terminal-Bench help); decide quickly. Your provider's native subagents share your quota: use them only when asked, fresh quota is ample, or no suitable alternative has quota. A background child goes through \`delegate_task\`, never a background \`Agent\`. Use other models through \`delegate_task\` on the user's plans, not provider APIs, unless asked or no plan has them. For a review you do start, prefer another provider. Skip small/fast models unless suitable or requested. Never choose a \`supersededBy\` or legacy model by default. Retry or use a current replacement. Explain any older-version exception; set \`userNamedModel\` only for an exact user request.
- Worktree isolation requires a Git commit. Run each review round as a new \`delegate_task\`, not \`t3_thread_send\` to the earlier child, with the original brief, findings, replies and open objections. Native subagents must support the chosen model.
- While subagents run, keep doing your own share in files they are not editing; reviewing and integrating count too. Ask them to message you only when done, blocked, or with a finding that changes the plan, and to keep progress notes in a shared file. Tell the user about milestones in your own words, after checking any claim you pass on, rather than relaying each update. Their results wake you, mid-turn where supported or as a new message. When only waiting is left, end your turn; don't poll or start watchers for them or the files they write (no \`monitor_start\`, native monitors or sleeps).
- Answer child question cards with \`t3_pending_request_respond\` on \`childThreadId\` when the brief or the user's words settle it; otherwise ask the user with \`ask_user\`, then submit their answer to the child's card.
- For your own commands, print only useful, line-buffered lines, then end your turn if waiting is all that's left. Waits under an hour can use a native Monitor or background command; longer ones use \`monitor_start\` (\`restartable:true\` for read-only waits and checks), and work you start that runs over 10 minutes (training, builds, uploads, servers) runs there with \`durable:true\` so restarts don't kill it; after a restart check \`monitor_list\` before relaunching.
- Before ending a turn while your own long work still runs (training, evals, deploys, remote jobs) and you plan to act on it, make sure something will wake you: \`monitor_start\`, \`schedule_task\`, or for a short wait a background command that exits when it ends or fails.
- Ask only for decisions the user's authorization doesn't settle: expanded scope/spend, hard-to-undo actions or their preferences. Within an approved goal/budget, choose the next step, retry or spend yourself and say what you chose.
- Ask with \`ask_user\`, not in your reply, and don't end replies offering more work: do what's authorized. Put the recommended choice first with '(Recommended)' in its label. Explain tradeoffs in your reply and leave the question and options to the card. Continue independent work while awaiting the answer. Prefer cards to blocking question tools.
- Collect secrets with \`request_secret\` and reusable API keys with \`request_api_key\`; never ask for either in chat.
- Use \`create_threads\` only for user-requested conversations. Link chats as \`[title](t3-thread://v1/<threadId>)\` with the exact returned id.
- A \`t3-model://v1/<instance>/<model>\` link in a user message names that model: decode its ids and use it as \`target\` with \`userNamedModel:true\`.
- Write times for the user in this machine's local time zone, not UTC, unless asked.
`;

/** For ACP agents, which can accept the MCP server without exposing its tools. */
const T3_CODE_ACP_FALLBACK_INSTRUCTIONS = `ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the SSHCode tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when SSHCode runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## SSHCode collaborative browser

You are running inside SSHCode. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## SSHCode interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until SSHCode supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## SSHCode interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until SSHCode supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  /** Absent means on, so older callers keep the full rules. */
  readonly subagentsEnabled?: boolean;
  readonly isSubagent?: boolean;
  /** Exact blocks acknowledged by the harness, including Settings-dependent policy. */
  readonly blocks?: Readonly<Record<"mode" | "policy" | "transport" | "runtime", string>>;
}

const LEAD_BULLET_PREFIXES = [
  "- The user picked your model",
  "- For a speed goal",
  "- Explicit user model choices",
  "- Honor the user's models",
  "- Worktree isolation",
  "- While subagents run",
  "- Answer child question cards",
];

/** The orchestration rules with the subagent and model-choice paragraphs removed. */
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO = T3_CODE_ORCHESTRATION_INSTRUCTIONS.split(
  "\n",
)
  .filter((line) => !LEAD_BULLET_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join("\n");

const SUBAGENT_BULLET =
  "- You are a subagent: a lead sent this brief and reads your final message. Do the task yourself; start subagents only if the brief asks. Ask via `ask_user` only when blocked. End with what you did, what you verified and open risks.";

/** Children keep operational guidance but take direction from their brief. */
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT =
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO.split("\n")
    // A model link names a model only in a user message, and a subagent's messages are briefs.
    .filter(
      (line) =>
        !line.startsWith("- Ask only") &&
        !line.startsWith("- Ask with") &&
        !line.startsWith("- A `t3-model://"),
    )
    .map((line) =>
      line.startsWith("- For your own commands") ? `${SUBAGENT_BULLET}\n${line}` : line,
    )
    .join("\n");

const ACP_DELEGATE_SENTENCE = ` Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

function acpFallbackInstructions(subagentsEnabled: boolean): string {
  return subagentsEnabled
    ? T3_CODE_ACP_FALLBACK_INSTRUCTIONS
    : T3_CODE_ACP_FALLBACK_INSTRUCTIONS.replace(ACP_DELEGATE_SENTENCE, "");
}

export const SubagentsEnabled = Context.Reference<(threadId: string | undefined) => boolean>(
  "@t3tools/provider-core/server/orchestrationInstructions/SubagentsEnabled",
  { defaultValue: () => () => true },
);

let gradingEnabledLookup: () => boolean = () => true;

/** The server registers the Settings switch for grading. Until then grading stays on. */
export function registerGradingEnabled(lookup: () => boolean): void {
  gradingEnabledLookup = lookup;
}

let rankedTaskKindsLookup: () => readonly string[] | null = () => null;

/**
 * The server registers the kinds of work the user has ranked model families
 * for. Null (not known yet) keeps the general rule.
 */
export function registerRankedTaskKinds(lookup: () => readonly string[] | null): void {
  rankedTaskKindsLookup = lookup;
}

/** False once the user is known to have ranked nothing: the tool and its rule are left out. */
export function modelPreferencesInUse(): boolean {
  const kinds = rankedTaskKindsLookup();
  return kinds === null || kinds.length > 0;
}

/**
 * With nothing ranked the rule is dropped, so no agent spends a call on an
 * empty answer; otherwise it names the ranked kinds of work, so agents ask
 * only for those.
 */
function withModelPreferences(instructions: string): string {
  const kinds = rankedTaskKindsLookup();
  if (kinds === null) return instructions;
  return instructions.replace(
    MODEL_PREFERENCES_CLAUSE,
    kinds.length === 0
      ? ""
      : ` Otherwise, for ${kinds.join(", ")} work only, consult \`model_preferences\` before delegating; family ranks follow new releases; choose a current model in the preferred family. Only the user edits preferences in Settings.`,
  );
}

/** The rules as sent: without the grading clause when Settings turns grading off. */
function withGrading(instructions: string): string {
  return gradingEnabledLookup() ? instructions : instructions.replace(GRADING_CLAUSE, "");
}

export function orchestrationInstructionsFor(
  threadId: string | undefined,
  enabled: (threadId: string | undefined) => boolean = () => true,
  isSubagent = false,
): string {
  return withModelPreferences(
    withGrading(
      isSubagent
        ? T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT
        : enabled(threadId)
          ? T3_CODE_ORCHESTRATION_INSTRUCTIONS
          : T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO,
    ),
  );
}

function subagentsOn(state: T3AcpInstructionState): boolean {
  return state.subagentsEnabled !== false;
}

/** Sent once when a session loses SSHCode tools it had. */
const ACP_REVOKED_BLOCKS = {
  policy: "SSHCode MCP tools are not attached. Use only the tools exposed by your harness.",
  transport: "The T3 ACP terminal fallback is unavailable.",
} as const;

/** Snapshot the independently delivered blocks before sending to ACP. */
export function t3AcpInstructionState(state: T3AcpInstructionState): T3AcpInstructionState {
  return {
    ...state,
    blocks: {
      mode:
        state.interactionMode === "plan"
          ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
          : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
      // Empty without SSHCode tools: a fresh session needs no notice, and a session
      // that loses them gets ACP_REVOKED_BLOCKS below.
      policy: state.hasT3Mcp
        ? orchestrationInstructionsFor(undefined, () => subagentsOn(state), state.isSubagent).trim()
        : "",
      transport: state.hasT3Mcp
        ? state.isSubagent
          ? acpFallbackInstructions(false).replace("orchestrator_capabilities", "t3_thread_list")
          : acpFallbackInstructions(subagentsOn(state))
        : "",
      runtime: buildRuntimeInstructions({ harness: "ACP" }),
    },
  };
}

/** ACP receives a full bootstrap for new context, then only changed blocks. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start, without marking blocks delivered.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const blocks = input.state.blocks ?? t3AcpInstructionState(input.state).blocks!;
  const previous =
    input.previousState === undefined
      ? undefined
      : (input.previousState.blocks ?? t3AcpInstructionState(input.previousState).blocks);
  const instructions = Object.entries(blocks).flatMap(([key, value]) => {
    const before = previous?.[key as keyof typeof blocks];
    if (value === before) return [];
    if (value.length > 0) return [value];
    const revoked = ACP_REVOKED_BLOCKS[key as keyof typeof ACP_REVOKED_BLOCKS];
    return before !== undefined && before.length > 0 && revoked !== undefined ? [revoked] : [];
  });
  return instructions.length === 0
    ? input.prompt
    : `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(
  prompt: string,
  threadId: string | undefined,
  enabled?: (threadId: string | undefined) => boolean,
  isSubagent?: boolean,
): string {
  return `<t3_code_orchestration_instructions>${orchestrationInstructionsFor(threadId, enabled, isSubagent).trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
  readonly threadId?: string;
  readonly subagentsEnabled?: (threadId: string | undefined) => boolean;
  readonly isSubagent?: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(
        input.prompt,
        input.threadId,
        input.subagentsEnabled,
        input.isSubagent,
      )
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  threadId?: string,
  enabled?: (threadId: string | undefined) => boolean,
  isSubagent?: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructionsFor(threadId, enabled, isSubagent) : undefined;
}

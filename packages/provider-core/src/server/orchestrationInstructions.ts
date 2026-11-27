import * as Context from "effect/Context";
import {
  DEFAULT_AGENT_BEHAVIOR,
  type AgentBehaviorLevels,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

/** The grading rule inside the review bullet; removed when Settings turns grading off. */
const GRADING_CLAUSE =
  "; flag a subagent that fell short (needed fixes, missed the brief or was wrong) via `grades` on your next subagent call; unflagged runs count as fine";

const MODEL_PREFERENCES_CLAUSE =
  " For relevant tasks, check `model_preferences` before delegating and pick the current model of the preferred family (only the user edits Settings).";

/** Settings > Agents Subagents levels replace these exact Default sentences. */
const DEFAULT_PROACTIVE_DELEGATION_CLAUSE =
  "Delegate only when it clearly beats doing the work yourself after counting the brief, wait and review—as applicable instructions, these explicitly ask for sub-agents, delegation, and parallel agent work without the user asking—for example: independent hour-plus pieces in parallel while you work on your piece (never serially while you wait); a sizable side task that would stall your main work; a broad sweep where you only need the summary, not raw dumps; a fresh look after two wrong diagnoses; a capability you lack (computer use, vision, image generation); or quota you lack (about 97% used or limited).";

const DEFAULT_PROACTIVE_REVIEW_CLAUSE =
  "Don't over-trust code you wrote: before it drives paid or long unattended runs, training or grading data (control and export scripts included), another provider's review usually pays off, even if your tests pass; verify other work yourself by running or inspecting it.";

const DEFAULT_LEAD_BULLET = `- The user picked your model for this chat, usually the strongest one: you lead and do almost all of the work yourself, keeping the plan, critical path, hard problems, visual design, writing voice and key decisions (supply the design if delegating UI code). ${DEFAULT_PROACTIVE_DELEGATION_CLAUSE}`;

const DEFAULT_HIGH_SKIP_CLAUSE =
  "- Skip subagents for small or tightly coupled work, self-contained builds/demos the user judges by their result (often a model test, unless you lack a capability), or work sharing one bottleneck (GPU, machine, queue, build or checkout). Spare quota elsewhere, or your own running high, is no reason.";

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## SSHCode orchestration

The \`t3-code\` MCP server adds app capabilities beyond your harness:
- Check SSHCode UI changes with \`qa_sandbox\` (isolated app, fake models).
- Browser work: use \`preview_*\` (start with \`preview_status\`; read user-driven tabs, open your own to act). Don't enable tools disabled in Settings > Tools.
- X (Twitter): use \`search_x\` freely like web search; \`read_x_post\` reads a link.
${DEFAULT_LEAD_BULLET}
${DEFAULT_HIGH_SKIP_CLAUSE} The user's word on subagents holds for the whole chat. For speed goals, measure end to end first and target the bottleneck; never spawn more subagents than you can review, and scale down when more won't help.
- Review, verify on the real surface (not just proxy checks), and integrate what subagents return${GRADING_CLAUSE}. ${DEFAULT_PROACTIVE_REVIEW_CLAUSE} Give a reviewer the code/diff and acceptance criteria, not your conclusion. Use \`council\` when asked for multiple views or before a hard-to-reverse design choice, then decide and explain.
- Explicit user model choices and reviewer counts come first ('Up to N' is a ceiling).${MODEL_PREFERENCES_CLAUSE} Otherwise pick current models from \`orchestrator_capabilities\` (check \`recentFailure\`, \`yourRuns\` and \`usage_limits\`), preferring other providers' best-fit models (especially for reviews) by intelligence, speed and quota cost, not price tier (benchmarks like Artificial Analysis or Terminal-Bench help); decide quickly. Native subagents share your quota and must support the chosen model: use only when asked, fresh quota is ample, or no other route has quota. Run background subagents through \`delegate_task\`, never a background \`Agent\`; use other models on the user's plans, not provider APIs, unless asked or no plan has them. Skip \`supersededBy\`/legacy models unless explicitly requested (then set \`userNamedModel:true\`; explain any other exception).
- Make every brief self-contained (goal, repo/base, owned/off-limits files, what's ruled out, verification); if you can't write a clear brief, don't hand it off yet. For parallel edits use \`isolation:"worktree"\` (needs a Git commit; \`withEdits:true\` for uncommitted edits). Run each review round as a new \`delegate_task\`, not \`t3_thread_send\`, with the original brief, findings, replies and open objections.
- Once delegated, don't also do that work yourself; work in other files or review and integrate. Have subagents save notes in a shared file and message mid-run only if blocked or the plan changes. Report milestones in your own words after checking any claim. Results wake you automatically; when only waiting remains, end your turn without narrating, polling, or watching subagents or their files (no \`monitor_start\`, native monitors or sleeps).
- Answer subagent question cards via \`t3_pending_request_respond\` on \`taskId\` when the brief or user settles it; else ask via \`ask_user\` and relay.
- Batch independent reads and searches in one tool round. Save verbose output to a log, preserve the exit status and inspect relevant lines.
- Before ending a turn while your own long work still runs, arrange any follow-up wake you need: waits under an hour can use a native Monitor or background command that exits when done; longer waits use \`monitor_start\`: \`durable:true\` for your own process, else a read-only check with \`restartable:true\` (plus \`silenceMs\` if it can hang) that wakes you to act (durable takes neither); check \`monitor_list\` after a restart, stream line-buffered milestones or \`wakeOn:false\` for exit only; scheduled follow-ups use \`schedule_task\`. End your turn without narrating the wait once only waiting remains.
- Ask only when the user's authorization doesn't settle a decision (scope/spend, hard-to-undo actions, preferences); within an approved goal/budget, choose and state what you chose. Use \`ask_user\`, not prose, and don't end replies offering more work: explain tradeoffs in your reply, put options with '(Recommended)' first on the card, prefer cards to blocking question tools, and continue independent work.
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
  readonly runtimeHarness?: string | undefined;
  /** The chat, so a bot home chat gets its bot block. */
  readonly threadId?: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  /** Absent means on, so older callers keep the full rules. */
  readonly subagentsEnabled?: boolean;
  readonly isSubagent?: boolean;
  readonly toolDiscoveryInstructions?: string | undefined;
  /** Exact blocks acknowledged by the harness, including Settings-dependent policy. */
  readonly blocks?: Readonly<
    Record<"mode" | "policy" | "transport" | "runtime" | "tools" | "bot", string>
  >;
}

const LEAD_BULLET_PREFIXES = [
  "- The user picked your model",
  "- Skip subagents",
  "- Review, verify",
  "- Explicit user model choices",
  "- Make every brief",
  "- Once delegated",
  "- Answer subagent question cards",
];

/** The orchestration rules with the subagent and model-choice paragraphs removed. */
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO = T3_CODE_ORCHESTRATION_INSTRUCTIONS.split(
  "\n",
)
  .filter((line) => !LEAD_BULLET_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join("\n");

const SUBAGENT_BULLET =
  "- You are a subagent: a lead reads your final reply. Do the task yourself; start subagents only if asked. Ask via `ask_user` only when blocked. Commit or save notes as you go. Keep your final reply concise (<5 KB): verdict first, what you did, exact checks run and results, open risks; link commits/files/logs for detail.";

/** Children keep operational guidance but take direction from their brief. */
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT =
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO.split("\n")
    // A model link names a model only in a user message, and a subagent's messages are briefs.
    .filter((line) => !line.startsWith("- Ask only") && !line.startsWith("- A `t3-model://"))
    .map((line) =>
      line.startsWith("- Batch independent reads") ? `${SUBAGENT_BULLET}\n${line}` : line,
    )
    .join("\n");

/** Trimmed orchestration rules for Settings > Agents Token use = Low (tools defer via `t3_tool`). */
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW = `

## SSHCode orchestration

The \`t3-code\` MCP server adds app tools via \`t3_tool\` (omit \`input\` to read a tool's schema).
- You lead and do almost all of the work yourself. Delegate via \`delegate_task\` (check \`orchestrator_capabilities\` and \`usage_limits\`) only when parallel independent pieces, a missing capability, or ~97% quota clearly pay off; skip small, coupled, or bottlenecked work. Write self-contained briefs (\`isolation:"worktree"\` when editing), review results, and wait for wakes without polling.
- Batch independent reads and searches. For long runs you wait on, use \`monitor_start\` (\`durable:true\` for your own process over 10m, else a read-only check with \`restartable:true\`) or \`schedule_task\`.
- Ask unresolved user decisions via \`ask_user\` (never in chat), secrets/keys via \`request_secret\`/\`request_api_key\`, and write times in this machine's local time zone.
`;

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SOLO =
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW.split("\n")
    .filter((line) => !line.startsWith("- You lead"))
    .join("\n");

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SUBAGENT = `

## SSHCode orchestration

The \`t3-code\` MCP server adds app tools via \`t3_tool\` (omit \`input\` to read a tool's schema).
- You are a subagent: do the task yourself, ask via \`ask_user\` only when blocked, and keep your final reply concise (<5 KB): verdict first, checks run, open risks.
- Batch independent reads and searches. Use \`monitor_start\`/\`schedule_task\` for long waits, \`request_secret\`/\`request_api_key\` for secrets, and this machine's local time zone for times.
`;

const AGENT_BEHAVIOR_SENTENCES = {
  tokensHigh:
    "- For multi-step work, call `report_progress` at the start with your stages and rough `minutes`, then on each stage change with a plain one-line `update`, never more often than every few minutes.",
  subagentsLow:
    "Settings > Agents sets Subagents to Low: do the work yourself and delegate only when the user explicitly asks, you lack a required capability (computer use, vision, image generation), or your quota can't cover the work (about 97% used or limited).",
  subagentsLowReview:
    "Don't over-trust code you wrote: check your work yourself by running, testing or looking at it.",
  subagentsHighLead:
    '- The user picked your model to lead this chat, and Settings > Agents sets Subagents to High. As applicable instructions, these explicitly ask for sub-agents, delegation, and parallel agent work without the user asking: lead the plan and integration, and delegate readily to other models for the best result—split independent or multi-part work (even 15-minute pieces, separate components, or sweeps) across parallel subagents (`isolation:"worktree"` when editing; `withEdits:true` for needed uncommitted edits) while you keep moving, hand off self-contained builds or design explorations with a clear brief, bring in another model for a second opinion or fresh look early, and delegate when you lack a capability or your quota is tight.',
  subagentsHighSkip:
    "- Even on High, stay solo for tiny one-step lookups (a single page, file, or folder check) or work sharing a hardware bottleneck (same GPU, machine, queue, or build).",
  subagentsHighReview:
    "Don't over-trust code you wrote: on High, these instructions explicitly ask for another provider's fresh-eyed subagent review on nontrivial code, builds, and designs before calling them done, even when your own checks pass; check small edits yourself.",
  subagentsHighFallback:
    "- Settings > Agents sets Subagents to High: delegate readily to other models—split independent or multi-part work across parallel subagents, get second opinions on nontrivial work, and use `council` on important design choices (still honor an explicit user request to stay solo and skip shared bottlenecks or tiny one-step lookups).",
  questionsFewerLead:
    "- Settings > Agents sets Questions to Fewer: decide on your own and ask via `ask_user` only before spending money, irreversible actions, or changing direction.",
  questionsFewerSubagent:
    "- Settings > Agents sets Questions to Fewer: decide on your own and ask via `ask_user` only when truly blocked or before spending money or irreversible actions.",
  questionsMoreLead:
    "- Settings > Agents sets Questions to More: check with the user via `ask_user` before big or ambiguous choices rather than assuming.",
  verificationLight:
    "- Settings > Agents sets Checking work to Light: keep checks quick—run typecheck and the tests that changed.",
  verificationThoroughLead:
    "- Settings > Agents sets Checking work to Thorough: before calling big work done, run full relevant tests, inspect the real screen or output, and get another model's independent review.",
  verificationThoroughSolo:
    "- Settings > Agents sets Checking work to Thorough: before calling big work done, run full relevant tests and inspect the real screen or output.",
  repliesShort:
    "- Settings > Agents sets Replies to Short: keep your reply to a few lines—what changed and anything the user needs to do.",
  repliesDetailed:
    "- Settings > Agents sets Replies to Detailed: give fuller explanations with your reasoning and evidence.",
} as const;

function withSubagentLevel(
  instructions: string,
  behavior: AgentBehaviorLevels,
  subagentsAllowed: boolean,
  isSubagent: boolean,
): string {
  // Subagents = None turns subagents off through the chat-switch path (solo instructions + tools hidden).
  if (behavior.subagents === "none" || isSubagent || !subagentsAllowed) return instructions;
  if (behavior.subagents === "low") {
    if (instructions.includes(DEFAULT_PROACTIVE_DELEGATION_CLAUSE)) {
      return instructions
        .replace(DEFAULT_PROACTIVE_DELEGATION_CLAUSE, AGENT_BEHAVIOR_SENTENCES.subagentsLow)
        .replace(DEFAULT_PROACTIVE_REVIEW_CLAUSE, AGENT_BEHAVIOR_SENTENCES.subagentsLowReview);
    }
    return `${instructions.trimEnd()}\n- ${AGENT_BEHAVIOR_SENTENCES.subagentsLow}\n`;
  }
  if (behavior.subagents === "high") {
    if (instructions.includes(DEFAULT_LEAD_BULLET)) {
      return instructions
        .replace(DEFAULT_LEAD_BULLET, AGENT_BEHAVIOR_SENTENCES.subagentsHighLead)
        .replace(DEFAULT_HIGH_SKIP_CLAUSE, AGENT_BEHAVIOR_SENTENCES.subagentsHighSkip)
        .replace(DEFAULT_PROACTIVE_REVIEW_CLAUSE, AGENT_BEHAVIOR_SENTENCES.subagentsHighReview);
    }
    return `${instructions.trimEnd()}\n${AGENT_BEHAVIOR_SENTENCES.subagentsHighFallback}\n`;
  }
  return instructions;
}

function agentBehaviorBullets(
  behavior: AgentBehaviorLevels,
  subagentsAllowed: boolean,
  isSubagent: boolean,
): readonly string[] {
  const bullets: string[] = [];
  if (behavior.tokens === "high") {
    bullets.push(AGENT_BEHAVIOR_SENTENCES.tokensHigh);
  }
  if (behavior.questions === "fewer") {
    bullets.push(
      isSubagent
        ? AGENT_BEHAVIOR_SENTENCES.questionsFewerSubagent
        : AGENT_BEHAVIOR_SENTENCES.questionsFewerLead,
    );
  } else if (behavior.questions === "more" && !isSubagent) {
    bullets.push(AGENT_BEHAVIOR_SENTENCES.questionsMoreLead);
  }
  if (behavior.verification === "light") {
    bullets.push(AGENT_BEHAVIOR_SENTENCES.verificationLight);
  } else if (behavior.verification === "thorough") {
    bullets.push(
      !isSubagent && subagentsAllowed
        ? AGENT_BEHAVIOR_SENTENCES.verificationThoroughLead
        : AGENT_BEHAVIOR_SENTENCES.verificationThoroughSolo,
    );
  }
  if (behavior.replies === "short") {
    bullets.push(AGENT_BEHAVIOR_SENTENCES.repliesShort);
  } else if (behavior.replies === "detailed") {
    bullets.push(AGENT_BEHAVIOR_SENTENCES.repliesDetailed);
  }
  return bullets;
}

function withAgentBehavior(
  instructions: string,
  behavior: AgentBehaviorLevels,
  subagentsAllowed: boolean,
  isSubagent: boolean,
): string {
  const withSub = withSubagentLevel(instructions, behavior, subagentsAllowed, isSubagent);
  const bullets = agentBehaviorBullets(behavior, subagentsAllowed, isSubagent);
  return bullets.length === 0 ? withSub : `${withSub.trimEnd()}\n${bullets.join("\n")}\n`;
}

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
      : ` For ${kinds.join(", ")} work only, check \`model_preferences\` before delegating and pick the current model of the preferred family (only the user edits Settings).`,
  );
}

let agentBehaviorLookup: () => AgentBehaviorLevels = () => DEFAULT_AGENT_BEHAVIOR;

/**
 * The server registers Settings > Agents. Until then, or for a server that never does,
 * every level is "default" and agents get today's rules.
 */
export function registerAgentBehavior(lookup: () => AgentBehaviorLevels): void {
  agentBehaviorLookup = lookup;
}

/** The levels in force now, for instruction builders and features that follow them. */
export function currentAgentBehavior(): AgentBehaviorLevels {
  return agentBehaviorLookup();
}

let botThreadLookup: (threadId: string) => boolean = () => false;
let knownBotThreadLookup: (threadId: string) => boolean = () => false;

/**
 * The server registers which threads are active bot home chats (Settings > Bots on). Until then,
 * or while Bots are off, no thread is an active bot chat. Features that add bot behavior
 * (instructions, eager cards, cross-project create_threads) read `isBotThread`.
 */
export function registerBotThreadCheck(lookup: (threadId: string) => boolean): void {
  botThreadLookup = lookup;
}

export function isBotThread(threadId: string | undefined): boolean {
  return threadId !== undefined && botThreadLookup(threadId);
}

/**
 * The server registers every saved bot's home chat, including while Bots are off. Features that
 * hide bot home chats from ordinary chat paths (phone alerts, relay live activities, chat search)
 * read `isKnownBotThread` so turning Bots off never exposes a bot's home chat as an ordinary chat.
 */
export function registerKnownBotThreadCheck(lookup: (threadId: string) => boolean): void {
  knownBotThreadLookup = lookup;
}

export function isKnownBotThread(threadId: string | undefined): boolean {
  return threadId !== undefined && (knownBotThreadLookup(threadId) || botThreadLookup(threadId));
}

let botInstructionsLookup: (threadId: string) => string | null = () => null;

/** The server registers the bot block (who the bot is, how it talks, its memory) per bot chat. */
export function registerBotInstructions(lookup: (threadId: string) => string | null): void {
  botInstructionsLookup = lookup;
}

/** The bot block for a bot home chat; null for every other chat. */
export function botInstructionsFor(threadId: string | undefined): string | null {
  return threadId !== undefined && isBotThread(threadId) ? botInstructionsLookup(threadId) : null;
}

/** The rules as sent: without the grading clause when Settings turns grading off. */
function withGrading(instructions: string): string {
  return gradingEnabledLookup() ? instructions : instructions.replace(GRADING_CLAUSE, "");
}

/**
 * A bot chat also gets its bot block, after the shared rules. Harnesses that resend changed
 * context blocks pass `withBot: false` and send `botInstructionsFor` as a block of its own, so
 * a memory edit resends the small bot block instead of every rule.
 */
export function orchestrationInstructionsFor(
  threadId: string | undefined,
  enabled: (threadId: string | undefined) => boolean = () => true,
  isSubagent = false,
  withBot = true,
): string {
  const behavior = currentAgentBehavior();
  const subagentsAllowed = behavior.subagents !== "none" && enabled(threadId);
  const low = behavior.tokens === "low";
  const base = isSubagent
    ? low
      ? T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SUBAGENT
      : T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT
    : subagentsAllowed
      ? low
        ? T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW
        : T3_CODE_ORCHESTRATION_INSTRUCTIONS
      : low
        ? T3_CODE_ORCHESTRATION_INSTRUCTIONS_LOW_SOLO
        : T3_CODE_ORCHESTRATION_INSTRUCTIONS_SOLO;
  const rules = withAgentBehavior(
    low ? base : withModelPreferences(withGrading(base)),
    behavior,
    subagentsAllowed,
    isSubagent,
  );
  const bot = withBot && !isSubagent ? botInstructionsFor(threadId) : null;
  return bot === null ? rules : `${rules.trimEnd()}\n\n${bot}\n`;
}

function subagentsOn(state: T3AcpInstructionState): boolean {
  return currentAgentBehavior().subagents !== "none" && state.subagentsEnabled !== false;
}

/** Sent once when a session loses SSHCode tools it had. */
const ACP_REVOKED_BLOCKS = {
  policy: "SSHCode MCP tools are not attached. Use only the tools exposed by your harness.",
  transport: "The T3 ACP terminal fallback is unavailable.",
  tools: "The previous t3-code tool catalog is no longer available.",
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
        ? orchestrationInstructionsFor(
            state.threadId,
            () => subagentsOn(state),
            state.isSubagent,
            false,
          ).trim()
        : "",
      transport: state.hasT3Mcp
        ? state.isSubagent
          ? acpFallbackInstructions(false).replace("orchestrator_capabilities", "t3_thread_list")
          : acpFallbackInstructions(subagentsOn(state))
        : "",
      runtime: buildRuntimeInstructions({ harness: state.runtimeHarness ?? "ACP" }),
      tools: state.hasT3Mcp ? (state.toolDiscoveryInstructions ?? "") : "",
      bot: state.hasT3Mcp && !state.isSubagent ? (botInstructionsFor(state.threadId) ?? "") : "",
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

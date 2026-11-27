import type {
  BotMemoryEntry,
  BotPermissions,
  BotsError,
  BotWatch,
  BotWatchEvent,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/**
 * What the rest of the server reads about Bots without depending on BotService: whether any
 * bot exists (so other chats get `message_bot`), each bot chat's permissions, and the hooks
 * BotService registers for paused routines and tool calls. Everything reads "no bots" until
 * BotService starts, and while Bots are off.
 */
interface BotThreadInfo {
  readonly permissions: BotPermissions;
}

let active = false;
let threads: ReadonlyMap<string, BotThreadInfo> = new Map();

export function setBotThreads(next: {
  readonly active: boolean;
  readonly threads: ReadonlyMap<string, BotThreadInfo>;
}) {
  active = next.active;
  threads = next.active ? next.threads : new Map();
}

/** On with at least one bot. */
export const botsActive = () => active;

export function botThreadInfo(threadId: string | undefined): BotThreadInfo | undefined {
  return threadId === undefined ? undefined : threads.get(threadId);
}

/** The tools a bot without "Manage chats" cannot see or call. */
export const MANAGE_CHAT_TOOLS: ReadonlySet<string> = new Set([
  "create_threads",
  "t3_thread_send",
  "t3_thread_update",
  "t3_thread_interrupt",
  "t3_workflow_stop",
  "t3_thread_organize",
  "t3_queue",
]);

/** Tools only a bot's own chat sees. */
export const BOT_CHAT_TOOLS: ReadonlySet<string> = new Set([
  "bot_memory",
  "watch_chats",
  "unwatch_chats",
]);

export const MESSAGE_BOT_TOOL = "message_bot";

/** Whether a tool is listed for this caller, as far as Bots decide. Undefined defers to the rest. */
export function botToolVisible(
  name: string,
  scope: Pick<McpInvocationScope, "thread"> | undefined,
): boolean | undefined {
  const threadId = scope?.thread?.threadId;
  if (name === MESSAGE_BOT_TOOL) return active && threadId !== undefined && !threads.has(threadId);
  if (BOT_CHAT_TOOLS.has(name)) return botThreadInfo(threadId) !== undefined;
  if (MANAGE_CHAT_TOOLS.has(name)) {
    const bot = botThreadInfo(threadId);
    return bot === undefined || bot.permissions.manageChats ? undefined : false;
  }
  return undefined;
}

/** A bot with "Use subagents" off has subagents off in its chat. */
export function botAllowsSubagents(threadId: string): boolean {
  return threads.get(threadId)?.permissions.startSubagents ?? true;
}

type RoutineGate = (threadId: string, prompt: string) => Effect.Effect<boolean>;
let routineGate: RoutineGate | null = null;

export function registerBotRoutineGate(gate: RoutineGate | null) {
  routineGate = gate;
}

/** True when the routine's chat is a paused bot, which holds it instead. */
export const holdBotRoutine = (threadId: string, prompt: string) =>
  routineGate === null ? null : routineGate(threadId, prompt);

/** A refusal message for a tool call, or undefined to let it run. */
type ToolGuard = (
  scope: McpInvocationScope,
  toolName: string,
  payload: unknown,
) => Effect.Effect<string | undefined>;
let toolGuard: ToolGuard | null = null;

export function registerBotToolGuard(guard: ToolGuard | null) {
  toolGuard = guard;
}

export function guardBotToolCall(scope: McpInvocationScope, toolName: string, payload: unknown) {
  if (toolGuard === null || botThreadInfo(scope.thread?.threadId) === undefined) return null;
  return toolGuard(scope, toolName, payload);
}

/** What the bot MCP tools call; BotService registers it while it runs. */
export interface BotTools {
  readonly memory: (
    botThreadId: ThreadId,
    input: {
      readonly add?: string | undefined;
      readonly replace?: { readonly id: string; readonly text: string } | undefined;
      readonly remove?: string | undefined;
    },
  ) => Effect.Effect<ReadonlyArray<BotMemoryEntry>, BotsError>;
  readonly watch: (
    botThreadId: ThreadId,
    input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly events?: ReadonlyArray<BotWatchEvent> | undefined;
      readonly until?: string | undefined;
    },
  ) => Effect.Effect<ReadonlyArray<BotWatch & { readonly title: string }>, BotsError>;
  readonly unwatch: (
    botThreadId: ThreadId,
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<BotWatch & { readonly title: string }>, BotsError>;
  readonly messageBot: (
    fromThreadId: ThreadId,
    input: {
      readonly text: string;
      readonly bot?: string | undefined;
      readonly urgent?: boolean | undefined;
    },
  ) => Effect.Effect<
    { readonly bot: string; readonly delivery: "now" | "soon" | "held" },
    BotsError
  >;
}

let tools: BotTools | null = null;

export function registerBotTools(next: BotTools | null) {
  tools = next;
}

export const botTools = () => tools;

let showCard = false;

/** Set from the registered MCP tools: bot instructions mention cards only when they exist. */
export function setShowCardAvailable(value: boolean) {
  showCard = value;
}

export const showCardAvailable = () => showCard;

/** For tests. */
export function resetBotsRuntimeForTests() {
  active = false;
  threads = new Map();
  routineGate = null;
  toolGuard = null;
  tools = null;
  showCard = false;
}

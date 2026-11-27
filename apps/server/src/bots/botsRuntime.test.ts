import { afterEach, describe, expect, it } from "@effect/vitest";
import { DEFAULT_AGENT_TOOL_POLICY, DEFAULT_BOT_PERMISSIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  agentToolListVisible,
  callerIsClaudeBot,
  withBotAlwaysLoad,
} from "../mcp/AgentToolCatalog.ts";
import * as AgentToolPolicy from "../mcp/AgentToolPolicy.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import { resetBotsRuntimeForTests, setBotThreads } from "./botsRuntime.ts";

const BOT = "thread:bot:test";
const scope = (threadId: string) =>
  ({
    thread: { threadId, providerInstanceId: "codex" },
    capabilities: new Set(["orchestration"]),
  }) as unknown as McpInvocationContext.McpInvocationScope;
const visible = (name: string, threadId: string) =>
  agentToolListVisible(DEFAULT_AGENT_TOOL_POLICY, name, scope(threadId), ChatControls.make().store);

describe("bot tool visibility", () => {
  afterEach(() => resetBotsRuntimeForTests());

  it("lists bot tools only in a bot's chat and message_bot only elsewhere", () => {
    setBotThreads({
      active: true,
      threads: new Map([[BOT, { permissions: DEFAULT_BOT_PERMISSIONS }]]),
    });
    expect(visible("bot_memory", BOT)).toBe(true);
    expect(visible("watch_chats", "chat")).toBe(false);
    expect(visible("message_bot", "chat")).toBe(true);
    expect(visible("message_bot", BOT)).toBe(false);
    expect(visible("create_threads", BOT)).toBe(true);
    resetBotsRuntimeForTests();
    expect(visible("message_bot", "chat")).toBe(false);
  });

  it.effect("a bot without Manage chats can't list or call chat-changing tools", () =>
    Effect.gen(function* () {
      setBotThreads({
        active: true,
        threads: new Map([
          [
            BOT,
            {
              permissions: {
                ...DEFAULT_BOT_PERMISSIONS,
                manageChats: false,
                startSubagents: false,
              },
            },
          ],
        ]),
      });
      for (const name of [
        "create_threads",
        "t3_thread_send",
        "t3_thread_update",
        "t3_thread_interrupt",
      ])
        expect(visible(name, BOT), name).toBe(false);
      expect(visible("t3_thread_read", BOT)).toBe(true);
      // Other chats keep them.
      expect(visible("create_threads", "chat")).toBe(true);
      // Use subagents off turns subagents off in the bot's chat only.
      const controls = ChatControls.make().store;
      expect(controls.subagentsEnabled(BOT)).toBe(false);
      expect(controls.subagentsEnabled("chat")).toBe(true);
      // A session that cached the list is refused at call time.
      const refused = yield* AgentToolPolicy.refuseUnavailableAgentTool("t3_thread_send").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope(BOT)),
      );
      expect(refused?.content).toEqual([
        { type: "text", text: "Managing chats is off for this bot in Settings > Bots." },
      ]);
    }),
  );

  it("asks Claude Code to load a bot's everyday tools up front, only in its own chat", () => {
    setBotThreads({
      active: true,
      threads: new Map([[BOT, { permissions: DEFAULT_BOT_PERMISSIONS }]]),
    });
    const instances = { claudeAgent_2: { driver: "claudeAgent" }, codex: { driver: "codex" } };
    const on = (threadId: string, providerInstanceId: string) =>
      callerIsClaudeBot(instances, { thread: { threadId, providerInstanceId } } as never);
    expect(on(BOT, "claudeAgent_2")).toBe(true);
    expect(on(BOT, "claudeAgent")).toBe(true);
    expect(on(BOT, "codex")).toBe(false);
    expect(on("chat", "claudeAgent_2")).toBe(false);
    expect(withBotAlwaysLoad({ name: "watch_chats", _meta: { other: 1 } })).toEqual({
      name: "watch_chats",
      _meta: { other: 1, "anthropic/alwaysLoad": true },
    });
    expect(withBotAlwaysLoad({ name: "delegate_task" })).toEqual({ name: "delegate_task" });
  });
});

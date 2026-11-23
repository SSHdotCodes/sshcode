import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DeviceToolkit } from "../mcp/toolkits/device/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectListToolkit } from "../mcp/toolkits/project/tools.ts";
import { PendingRequestToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  AGENT_SURFACE_T3_MCP_TOOLS,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_T3_MCP_TOOLS,
  overviewClaudeQueryOptions,
  overviewPromptText,
} from "./overviewAgent.ts";
import { OVERVIEW_STATUS_CONTEXT_KEY } from "./statusText.ts";

const message = (text: string) => ({ text });

describe("Overview agent", () => {
  it("knows every tool on the agent MCP surface", () => {
    // McpHttpServer's agent `layer` registers exactly these toolkits.
    const registered = [
      ...Object.values(OrchestratorToolkit.tools),
      ...Object.values(PendingRequestToolkit.tools),
      ...Object.values(ProjectListToolkit.tools),
      ...Object.values(DeviceToolkit.tools),
    ]
      .map((tool) => `mcp__t3-code__${tool.name}`)
      .sort();
    assert.deepEqual([...AGENT_SURFACE_T3_MCP_TOOLS].sort(), registered);
    assert.deepEqual(OVERVIEW_T3_MCP_TOOLS, [
      "mcp__t3-code__t3_thread_read",
      "mcp__t3-code__t3_thread_list",
      "mcp__t3-code__t3_pending_request_list",
      "mcp__t3-code__t3_pending_request_read",
      "mcp__t3-code__usage_limits",
      "mcp__t3-code__list_scheduled_tasks",
    ]);
    for (const tool of OVERVIEW_T3_MCP_TOOLS) assert.include(registered, tool);
  });

  it("runs on its own prompt with read tools only and none of the user's settings", () => {
    const base = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      nativeThreadId: "native-overview",
      resume: false,
      cwd: "/scratch/overview",
      mcpServers: {
        "t3-code": { type: "http", url: "http://127.0.0.1/mcp", headers: {} },
      },
      allowedTools: [ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD],
      permissionMode: "bypassPermissions",
    });
    const options = overviewClaudeQueryOptions(base);

    assert.strictEqual(options.model, "claude-haiku-5-5");
    assert.strictEqual(options.effort, "high");
    assert.deepEqual(options.tools, []);
    assert.strictEqual(options.systemPrompt, OVERVIEW_SYSTEM_PROMPT);
    assert.deepEqual(options.settingSources, []);
    assert.isTrue(options.strictMcpConfig);
    assert.deepEqual(options.allowedTools, [...OVERVIEW_T3_MCP_TOOLS]);
    const disallowed = options.disallowedTools ?? [];
    assert.include(disallowed, "mcp__t3-code__delegate_task");
    assert.include(disallowed, "mcp__t3-code__t3_thread_send");
    for (const tool of OVERVIEW_T3_MCP_TOOLS) assert.notInclude(disallowed, tool);
    assert.lengthOf(
      options.disallowedTools ?? [],
      AGENT_SURFACE_T3_MCP_TOOLS.length - OVERVIEW_T3_MCP_TOOLS.length,
    );
  });

  it("checks chat content before giving up and labels general knowledge", () => {
    assert.include(OVERVIEW_SYSTEM_PROMPT, "fromEnd=true");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "search for the topic with query");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "beforePosition");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "Read relevant matches in full with itemId");
    assert.include(
      OVERVIEW_SYSTEM_PROMPT,
      "Only say you don't know after checking the chat's latest messages and searching",
    );
    assert.include(OVERVIEW_SYSTEM_PROMPT, "answer briefly from general knowledge");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "not something from the chats");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "can't browse the web");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "You can only look");
    assert.include(OVERVIEW_SYSTEM_PROMPT, "t3-thread://v1/<id>");
    assert.notInclude(OVERVIEW_SYSTEM_PROMPT, "If the status and tools don't tell you");
  });

  it("puts the live status ahead of an Overview question only", () => {
    const appContext = [{ key: OVERVIEW_STATUS_CONTEXT_KEY, text: "2 chats working." }];
    assert.strictEqual(
      overviewPromptText({
        threadId: ThreadId.make("overview-1"),
        appContext,
        message: message("What's going on?"),
      }),
      "<sshcode_status>\nFull snapshot (replaces earlier status):\n2 chats working.\n</sshcode_status>\n\nWhat's going on?",
    );
    assert.strictEqual(
      overviewPromptText({
        threadId: ThreadId.make("overview-1"),
        appContext,
        message: message("/compact"),
      }),
      "/compact",
    );
    assert.strictEqual(
      overviewPromptText({
        threadId: ThreadId.make("thread-1"),
        appContext,
        message: message("Hi"),
      }),
      "Hi",
    );
  });
});

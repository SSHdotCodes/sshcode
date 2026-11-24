import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpWireSchema from "effect-acp/schema-v1";

import {
  extractAntigravityUserInputQuestion,
  isAntigravityOpenCommand,
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  isAntigravitySubagentReplayStart,
  antigravityPromptStopFailure,
  classifyAntigravitySubagentToolCall,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravityPromptUsage,
  normalizeAntigravitySessionUpdate,
  makeAntigravityReadRepair,
  makeAntigravityStoppedTools,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  selectAntigravityPermissionOptionId,
} from "./AntigravityProtocol.ts";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";
import { acpToolCallDiffPatch } from "@t3tools/provider-acp/server/adapter";

const isSessionNotification = Schema.is(AcpWireSchema.SessionNotification);

describe("native Antigravity subagent tools", () => {
  it("recognizes only native invocation titles and excludes MCP tools", () => {
    const toolCall = { toolCallId: "trajectory:4", kind: "other", data: {} };
    for (const title of [
      "Running start_subagent",
      "Run start_subagent?",
      "Running invoke_subagent",
      "Run invoke_subagent?",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBe("subagent");
      expect(
        classifyAntigravitySubagentToolCall(
          { ...toolCall, title },
          { update: { _meta: { is_mcp_tool_call: true } } },
        ),
      ).toBe("mcp");
    }
    for (const title of [
      "Running subagent",
      "start_subagent",
      "Run command",
      "Running manage_task",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBeUndefined();
    }
    expect(
      classifyAntigravitySubagentToolCall(
        { ...toolCall, title: "Running start_subagent", kind: "execute" },
        {},
      ),
    ).toBeUndefined();
  });

  it("recognizes history starts and bounds the launch output", () => {
    expect(
      isAntigravitySubagentReplayStart({
        update: { sessionUpdate: "tool_call", status: "completed", rawOutput: "Done." },
      }),
    ).toBe(false);
    expect(
      isAntigravitySubagentReplayStart({
        update: { sessionUpdate: "tool_call", status: "completed" },
      }),
    ).toBe(true);
    expect(
      isAntigravitySubagentReplayStart({
        update: { sessionUpdate: "tool_call_update", status: "completed" },
      }),
    ).toBe(false);
    expect(
      antigravitySubagentOutput({
        toolCallId: "trajectory:4",
        data: { rawOutput: "  Finished review.  " },
      }),
    ).toBe("Finished review.");
    const result = antigravitySubagentOutput({
      toolCallId: "trajectory:4",
      data: { rawOutput: `${"x".repeat(16_000)}The result.` },
    });
    expect(result?.length).toBeLessThan(8_100);
    expect(result?.endsWith("The result.")).toBe(true);
    expect(
      antigravitySubagentOutput({ toolCallId: "trajectory:4", data: { rawOutput: {} } }),
    ).toBeUndefined();
  });
});

const questionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "interaction_9960062f",
    status: "pending",
    title: "Which result label should be used for the verification?",
    rawInput: {},
  },
  options: [
    { optionId: "1", name: "Verified", kind: "allow_once" },
    { optionId: "2", name: "Needs review", kind: "allow_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

const commandStarted = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "fc28d0af6ad14be8bbba20f4258d4d3e",
    title: "run_command",
    kind: "execute",
    status: "in_progress",
    rawInput: { CommandLine: "cat probe.txt", Cwd: "/workspace" },
  },
} satisfies EffectAcpSchema.SessionNotification;

const commandCompleted = {
  sessionId: "session-1",
  update: {
    toolCallId: commandStarted.update.toolCallId,
    status: "completed",
    rawOutput: {
      commandLine: "cat probe.txt",
      workingDir: "/workspace",
      exitCode: 0,
      exit_code: 0,
      combinedOutput: "after\n",
      formatted_output: "after\n",
    },
    sessionUpdate: "tool_call_update",
  },
} satisfies EffectAcpSchema.SessionNotification;

function parseToolUpdate(notification: EffectAcpSchema.SessionNotification) {
  const result = parseSessionUpdateEvent(normalizeAntigravitySessionUpdate(notification));
  const event = result.events[0];
  if (event?._tag !== "ToolCallUpdated") {
    throw new Error("Expected a tool update.");
  }
  return event;
}

describe("Antigravity commands the agent stops", () => {
  // agy 1.5.13 frames: a command ends `failed` with nothing it printed and no exit code at the
  // moment the agent's own `manage_task` kill call runs.
  const command = (toolCallId: string, rawOutput?: unknown) =>
    normalizeAntigravityToolCall({
      toolCallId,
      kind: "execute",
      title: "npm run dev",
      status: "failed",
      data: {
        toolCallId,
        rawInput: { CommandLine: "npm run dev" },
        ...(rawOutput === undefined ? {} : { rawOutput }),
      },
    });
  const kill = (status: "inProgress" | "completed" | "failed", action = "kill") =>
    normalizeAntigravityToolCall({
      toolCallId: "call_kill",
      kind: "other",
      title: "Run manage_task",
      status,
      data: { toolCallId: "call_kill", rawInput: { Action: action, TaskId: "aa85bc44-0bb" } },
    });

  it("stops a silent failure that ends while the kill call runs", () => {
    const stopped = makeAntigravityStoppedTools();
    expect(stopped(kill("inProgress"), 1_000)).toEqual([]);
    expect(stopped(command("call_server"), 1_000)).toEqual(["call_server"]);
    expect(stopped(kill("completed"), 1_010)).toEqual([]);
  });

  it("stops a silent failure reported just before the kill call", () => {
    const stopped = makeAntigravityStoppedTools();
    expect(stopped(command("call_server"), 1_000)).toEqual([]);
    expect(stopped(kill("completed"), 1_400)).toEqual(["call_server"]);
  });

  it("counts only the commands that end within the kill's window", () => {
    const stopped = makeAntigravityStoppedTools();
    expect(stopped(command("call_early"), 1_000)).toEqual([]);
    expect(stopped(kill("inProgress"), 10_000)).toEqual([]);
    expect(stopped(kill("completed"), 10_005)).toEqual([]);
    expect(stopped(command("call_server"), 10_010)).toEqual(["call_server"]);
    expect(stopped(command("call_later"), 20_000)).toEqual([]);
  });

  it("leaves failures with output, an exit code, or no kill alone", () => {
    const stopped = makeAntigravityStoppedTools();
    expect(stopped(command("call_alone"), 1_000)).toEqual([]);
    expect(stopped(kill("inProgress", "status"), 5_000)).toEqual([]);
    expect(stopped(command("call_status"), 5_000)).toEqual([]);
    expect(stopped(kill("inProgress"), 9_000)).toEqual([]);
    expect(
      stopped(command("call_printed", { combinedOutput: "Error: listen EADDRINUSE\n" }), 9_000),
    ).toEqual([]);
    expect(stopped(command("call_exit", { exitCode: 1 }), 9_000)).toEqual([]);
    const refused = makeAntigravityStoppedTools();
    expect(refused(kill("failed"), 1_000)).toEqual([]);
    expect(refused(command("call_server"), 1_000)).toEqual([]);
  });

  it("stops a command the managed runtime says manage_task killed", () => {
    const stopped = makeAntigravityStoppedTools();
    expect(stopped(command("call_server", "Killed by manage_task(aa85bc44-0bb)"), 1_000)).toEqual([
      "call_server",
    ]);
  });
});

describe("Antigravity runtime quota stops", () => {
  const notice = (reset: string) =>
    `Usage Limit Reached\n\nYou have reached your current quota for this period.${reset}`;
  const now = DateTime.makeUnsafe("2026-11-20T02:07:27.000Z");

  it.each([
    // Google AI Pro through the managed runtime, 2026-11-20: the reply, then `refusal`.
    ["refusal", " Your limit will reset in 4 hours, 33 minutes.", "2026-11-20T06:41:27.000Z"],
    // The runtime spells the wait to its two largest units and rounds it down.
    ["refusal", " Your limit will reset in 4 days, 1 hour.", "2026-11-24T04:07:27.000Z"],
    ["refusal", " Your limit will reset in 42 seconds.", "2026-11-20T02:08:10.000Z"],
    // A model call that throws on the quota sends the same notice and ends on end_turn.
    ["end_turn", " Your limit will reset on Nov 21, 2026 14:05 UTC.", "2026-11-21T14:05:00.000Z"],
    ["end_turn", "", undefined],
  ] as const)("fails a %s on the notice as a usage limit (%j)", (stopReason, reset, resetAt) => {
    expect(
      antigravityPromptStopFailure({ stopReason, replyText: `\n${notice(reset)}\n`, now }),
    ).toEqual({
      class: "usage_limit",
      code: "antigravity_quota",
      message: notice(reset),
      retryable: false,
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  });

  it("leaves other replies and stop reasons to the generic handling", () => {
    const quota = notice(" Your limit will reset in 4 hours, 33 minutes.");
    for (const [stopReason, replyText] of [
      ["refusal", "I can't help with that."],
      ["refusal", undefined],
      ["refusal", `Here is what the runtime said:\n\n${quota}`],
      ["max_tokens", quota],
      ["cancelled", quota],
    ] as const) {
      expect(antigravityPromptStopFailure({ stopReason, replyText, now })).toBeUndefined();
    }
  });
});

describe("Antigravity permissions and questions", () => {
  const permissionRequest = {
    sessionId: "session-1",
    toolCall: { toolCallId: "command-1", kind: "execute", title: "Run command" },
    options: [
      { optionId: "remember-this-command", name: "Allow always", kind: "allow_always" },
      { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
      { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("uses only the option IDs offered for each approval decision", () => {
    expect(selectAntigravityPermissionOptionId(permissionRequest, "accept")).toBe("run-this-time");
    expect(selectAntigravityPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "remember-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "acceptAlways")).toBe(
      "remember-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "decline")).toBe(
      "stop-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "cancel")).toBeUndefined();
  });

  it("surfaces the agent's prompt injection warning on the remembered approval", () => {
    const risky = {
      ...permissionRequest,
      options: [
        {
          optionId: "remember-this-command",
          name: "Allow Always (risky)",
          kind: "allow_always",
          _meta: {
            "agy.security.warning": {
              severity: "high",
              risk: "prompt_injection",
              title: "Allowing always can be risky",
              message: "Untrusted files could re-run this action without asking.",
            },
          },
        },
        { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
        { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(antigravityApprovalOptions(risky)).toEqual([
      { decision: "accept", label: "Allow once" },
      {
        decision: "acceptForSession",
        label: "Allow for this thread",
        warning: "Untrusted files could re-run this action without asking.",
      },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
    expect(antigravityApprovalOptions(permissionRequest)[1]).not.toHaveProperty("warning");
  });

  it("does not replace unsupported remembered approval with a single approval", () => {
    const request = {
      ...permissionRequest,
      options: permissionRequest.options.filter((option) => option.kind !== "allow_always"),
    };
    expect(selectAntigravityPermissionOptionId(request, "acceptAlways")).toBeUndefined();
    expect(selectAntigravityPermissionOptionId(request, "acceptForSession")).toBeUndefined();
    expect(selectAntigravityPermissionOptionId(request, "accept")).toBe("run-this-time");
    expect(
      selectAntigravityPermissionOptionId({ ...request, options: [] }, "decline"),
    ).toBeUndefined();
  });

  it("routes the captured native question to single-choice input, not approval", () => {
    expect(isAntigravityUserInputRequest(questionRequest)).toBe(true);
    expect(selectAntigravityPermissionOptionId(questionRequest, "accept")).toBeUndefined();
    expect(extractAntigravityUserInputQuestion(questionRequest)).toEqual({
      id: "interaction_9960062f",
      header: "Question",
      question: "Which result label should be used for the verification?",
      multiSelect: false,
      allowCustomAnswer: false,
      options: [
        { value: "1", label: "Verified", description: "Verified" },
        { value: "2", label: "Needs review", description: "Needs review" },
      ],
    });
    expect(extractAntigravityUserInputQuestion(permissionRequest)).toBeUndefined();
  });

  it("returns exact opaque IDs and accepts a unique label from an older client", () => {
    for (const answer of ["1", ["1"], "Verified"]) {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toEqual({ outcome: { outcome: "selected", optionId: "1" } });
    }
    const request = {
      ...questionRequest,
      options: [{ optionId: " choice: opaque ", name: "Keep", kind: "allow_once" as const }],
    };
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: " choice: opaque " }),
    ).toEqual({ outcome: { outcome: "selected", optionId: " choice: opaque " } });
  });

  it("does not treat a question's reject choice as cancellation", () => {
    const request = {
      ...questionRequest,
      options: [{ optionId: "deny", name: "Do not trust", kind: "reject_once" as const }],
    };
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "deny" })).toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
  });

  it("preserves duplicate labels and rejects ambiguous label answers", () => {
    const request = {
      ...questionRequest,
      options: questionRequest.options.map((option) => ({ ...option, name: "Same label" })),
    };
    expect(
      extractAntigravityUserInputQuestion(request)?.options.map((option) => option.value),
    ).toEqual(["1", "2"]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: "Same label" }),
    ).toBeUndefined();
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "2" })).toEqual({
      outcome: { outcome: "selected", optionId: "2" },
    });
  });

  it.each([undefined, null, "", "arbitrary answer", [], ["1", "2"], { answer: "1" }, 1])(
    "keeps the question open for an unsupported answer: %j",
    (answer) => {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toBeUndefined();
    },
  );

  it("rejects missing or duplicate native option IDs", () => {
    for (const optionId of ["", "1"]) {
      const request = {
        ...questionRequest,
        options: [questionRequest.options[0]!, { ...questionRequest.options[1]!, optionId }],
      };
      expect(extractAntigravityUserInputQuestion(request)).toBeUndefined();
      expect(
        makeAntigravityUserInputResponse(request, { interaction_9960062f: "1" }),
      ).toBeUndefined();
    }
  });

  it("bounds question text without changing choice IDs", () => {
    const title = "Q".repeat(7_994) + "🧪";
    const label = "O".repeat(506) + "🧪";
    const request = {
      ...questionRequest,
      toolCall: { ...questionRequest.toolCall, title: title + "🚀 continued" },
      options: [
        { optionId: "stable-choice", name: label + "🚀 continued", kind: "allow_once" as const },
      ],
    };
    const question = extractAntigravityUserInputQuestion(request);
    expect(question?.question).toBe(title + "...");
    expect(question?.options).toEqual([
      { value: "stable-choice", label: label + "...", description: label + "..." },
    ]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: label + "..." }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "stable-choice" } });
  });
});

describe("Antigravity tool results", () => {
  it("normalizes the captured command and completed output for the existing clients", () => {
    const initial = parseToolUpdate(commandStarted).toolCall;
    const completed = parseToolUpdate(commandCompleted).toolCall;
    const toolCall = normalizeAntigravityToolCall(mergeToolCallState(initial, completed));

    expect(toolCall).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "cat probe.txt",
      detail: "cat probe.txt",
      data: {
        command: "cat probe.txt",
        cwd: "/workspace",
        item: {
          command: "cat probe.txt",
          cwd: "/workspace",
          aggregatedOutput: "after\n",
          exitCode: 0,
        },
      },
    });
    expect(toolCall.data.rawOutput).not.toHaveProperty("formatted_output");
    expect(commandCompleted.update.rawOutput.formatted_output).toBe("after\n");
  });

  it.each([
    { CommandLine: "pwd", Cwd: "/one" },
    { CommandLine: "pwd", WorkingDirectory: "/one" },
    { command_line: "pwd", working_dir: "/one" },
    { commandLine: "pwd", workingDir: "/one" },
    { command: "pwd", cwd: "/one" },
  ])("handles native command input aliases: %j", (rawInput) => {
    const event = parseToolUpdate({
      ...commandStarted,
      update: { ...commandStarted.update, rawInput },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      command: "pwd",
      detail: "pwd",
      data: { item: { command: "pwd", cwd: "/one" } },
    });
  });

  it("recovers command fields from history and keeps nonzero exits separate from tool failure", () => {
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          command_line: "test -f missing.txt",
          working_dir: "/workspace",
          combined_output: "",
          exit_code: 1,
        },
      },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "test -f missing.txt",
      data: { item: { cwd: "/workspace", aggregatedOutput: "", exitCode: 1 } },
    });
  });

  it.each([
    { name: "ASCII", boundary: "x", kept: "x", field: "combinedOutput" },
    { name: "split emoji", boundary: "🚀", kept: "", field: "combinedOutput" },
    { name: "split emoji (snake case)", boundary: "🚀", kept: "", field: "combined_output" },
  ])("bounds both canonical and retained raw output at $name", ({ boundary, kept, field }) => {
    const tail = `${"x".repeat(7_989)}last line\n`;
    const output = `${"output line\n".repeat(20_000)}${boundary}${tail}`;
    const expected = `[Earlier output truncated]\n\n${kept}${tail}`;
    const { combinedOutput: _combinedOutput, ...rawOutput } = commandCompleted.update.rawOutput;
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          ...rawOutput,
          [field]: output,
          formatted_output: output,
        },
      },
    });
    const toolCall = normalizeAntigravityToolCall(event.toolCall);
    expect(toolCall.data).toMatchObject({
      item: { aggregatedOutput: expected },
      rawOutput: { [field]: expected },
    });
    expect(event.toolCall.data.rawOutput).toMatchObject({ [field]: expected });
    expect(JSON.stringify(toolCall).length).toBeLessThan(20_000);
    expect(JSON.stringify(event.rawPayload).length).toBeLessThan(10_000);
    expect(JSON.stringify(event.rawPayload)).not.toContain("formatted_output");
  });

  it("keeps 1.5 command output and its content text valid Unicode when cut", () => {
    const tail = `${"x".repeat(7_982)}build completed\r\n`;
    const output = `Command output:\nprefix\r\n🚀${tail}`;
    const expected = `[Earlier output truncated]\n\n${tail}`;
    const toolCall = normalizeAntigravityToolCall(
      parseToolUpdate({
        ...commandCompleted,
        update: {
          ...commandCompleted.update,
          rawOutput: { output, exit_code: 0 },
          content: [{ type: "content", content: { type: "text", text: output } }],
        },
      }).toolCall,
    );
    expect(toolCall.data).toMatchObject({
      rawOutput: { output: expected },
      content: [{ content: { text: expected.trimEnd() } }],
    });
  });

  it("removes inline images while preserving valid tool content and the local image path", () => {
    const inlineImage = "inline-image-bytes".repeat(50_000);
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "image-1",
        status: "completed",
        rawOutput: { imageName: "result", imagePath: "file:///workspace/brain/result%20image.png" },
        content: [
          { type: "content", content: { type: "image", mimeType: "image/png", data: inlineImage } },
          { type: "content", content: { type: "text", text: "Saved the image." } },
          { type: "diff", path: "/workspace/note.txt", oldText: "old", newText: "new" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification;
    const normalized = normalizeAntigravitySessionUpdate(notification);
    expect(isSessionNotification(normalized)).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain("inline-image-bytes");
    expect(normalized.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "Saved the image." } },
        { type: "diff", path: "/workspace/note.txt", oldText: "old", newText: "new" },
      ],
    });
    expect(normalizeAntigravityToolCall(parseToolUpdate(normalized).toolCall).data.imagePath).toBe(
      "/workspace/brain/result image.png",
    );
  });

  it.each([
    ["/workspace/result.png", "/workspace/result.png"],
    ["C:\\work\\result.png", "C:\\work\\result.png"],
    ["file:///C:/work/result.png", "C:/work/result.png"],
    ["https://example.com/result.png", undefined],
    ["file://another-host/result.png", undefined],
    ["data:image/png;base64,AAAA", undefined],
  ])("only promotes local image references: %s", (imagePath, expected) => {
    const toolCall = normalizeAntigravityToolCall({
      toolCallId: "image-1",
      data: { rawOutput: { imagePath } },
    });
    expect(toolCall.data.imagePath).toBe(expected);
  });

  it("bounds nested tool data and drops image blobs and data URLs", () => {
    const payload = sanitizeAntigravityToolPayload({
      rawOutput: {
        text: "a".repeat(100_000),
        result: { mimeType: "image/png", blob: "image-blob".repeat(100_000) },
        image: { type: "image", data: "inline-image".repeat(100_000) },
        uri: "data:image/png;base64,inline-data-url",
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(9_000);
    expect(serialized).not.toContain("image-blob");
    expect(serialized).not.toContain("inline-image");
    expect(serialized).not.toContain("inline-data-url");
  });

  it("keeps large assistant replies and startup command metadata unchanged", () => {
    const notifications = [
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "a".repeat(20_000) },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Make a plan" }],
        },
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionNotification>;
    for (const notification of notifications) {
      expect(normalizeAntigravitySessionUpdate(notification)).toBe(notification);
    }
  });

  it("tracks only commands that have passed approval and are still running", () => {
    const running = normalizeAntigravityToolCall(parseToolUpdate(commandStarted).toolCall);
    expect(isAntigravityOpenCommand(running)).toBe(true);
    expect(isAntigravityOpenCommand({ ...running, status: "pending" })).toBe(false);
    expect(isAntigravityOpenCommand({ ...running, kind: "read" })).toBe(false);
    const completed = normalizeAntigravityToolCall(
      mergeToolCallState(running, parseToolUpdate(commandCompleted).toolCall),
    );
    expect(isAntigravityOpenCommand(completed)).toBe(false);
  });
});

describe("Antigravity served reads", () => {
  const flush = (reads: ReturnType<typeof makeAntigravityReadRepair>, toolCallId: string) =>
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: "Tool execution failed",
      },
    }).update;

  it("credits a read T3 served before the agent announced it", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    const announced = reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_late",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    expect(announced.update).toMatchObject({ status: "completed" });
    expect(flush(reads, "call_late")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_late",
      status: "completed",
    });
  });

  it("forgets an earlier turn's unannounced served read", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    reads.reset();
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_refused",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    reads.attempted("/repo/a.ts", false);
    expect(flush(reads, "call_refused")).toMatchObject({ status: "failed" });
  });

  it("drops an earlier turn's unanswered read so a new turn's served read gets the credit", () => {
    const reads = makeAntigravityReadRepair();
    const announce = (toolCallId: string) =>
      reads.repair({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Running client_view_file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/a.ts" }],
        },
      });
    announce("call_abandoned");
    reads.reset();
    announce("call_current");
    reads.attempted("/repo/a.ts", true);
    expect(flush(reads, "call_current")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_current",
      status: "completed",
    });
  });
});

describe("Antigravity CLI quota stops", () => {
  const notice = (reset: string) =>
    `⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${reset}.`;
  const now = DateTime.makeUnsafe("2026-11-21T21:52:58.990Z");

  it.each([
    // Google AI Ultra through the agy CLI, 2026-11-21: the whole reply, wrapped in newlines.
    [`\n${notice("4h33m33s")}\n`, "2026-11-22T02:26:31.990Z"],
    // Google AI Pro, 2026-11-21: the same notice with the request's error id under it.
    [
      `${notice("1h24m31s")}\nError ID: 4deb0bab-0266-4e73-b09c-9832e171ca9a-339`,
      "2026-11-21T23:17:29.990Z",
    ],
    // Go formats the wait: no days, and no hours or minutes once they run out.
    [notice("120h0m0s"), "2026-11-26T21:52:58.990Z"],
    [notice("12m5s"), "2026-11-21T22:05:03.990Z"],
    [notice("42.5s"), "2026-11-21T21:53:41.490Z"],
  ])("fails an end_turn on %j as a usage limit", (replyText, resetAt) => {
    expect(antigravityPromptStopFailure({ stopReason: "end_turn", replyText, now })).toEqual({
      class: "usage_limit",
      code: "antigravity_quota",
      message: replyText.trim(),
      retryable: false,
      resetAt,
    });
  });

  it.each([
    `The CLI said "${notice("4h33m33s")}" and stopped.`,
    `${notice("4h33m33s")}\nSwitching to Gemini instead.`,
    "⚠ Individual quota reached. Please upgrade your subscription to increase your limits.",
    notice("soon"),
    "⚠ Model capacity exhausted. Resets in 5m0s.",
  ])("leaves %j to the generic handling", (replyText) => {
    expect(
      antigravityPromptStopFailure({ stopReason: "end_turn", replyText, now }),
    ).toBeUndefined();
  });
});

describe("normalizeAntigravityPromptUsage", () => {
  it("folds agy uncached inputTokens with cachedReadTokens and cachedWriteTokens into inclusive inputTokens", () => {
    expect(
      normalizeAntigravityPromptUsage({
        inputTokens: 4280,
        outputTokens: 38,
        cachedReadTokens: 13705,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 18023,
      }),
    ).toEqual({
      inputTokens: 17985,
      outputTokens: 38,
      cachedReadTokens: 13705,
      cachedWriteTokens: 0,
      thoughtTokens: 0,
      totalTokens: 18023,
    });

    expect(
      normalizeAntigravityPromptUsage({
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 200,
        cachedWriteTokens: 40,
        thoughtTokens: 20,
        totalTokens: 390,
      }),
    ).toEqual({
      inputTokens: 340,
      outputTokens: 50,
      cachedReadTokens: 200,
      cachedWriteTokens: 40,
      thoughtTokens: 20,
      totalTokens: 390,
    });
  });

  it("leaves already-inclusive inputTokens and zero-cache usage unchanged", () => {
    const inclusive = {
      inputTokens: 17985,
      outputTokens: 38,
      cachedReadTokens: 13705,
      cachedWriteTokens: 0,
      thoughtTokens: 0,
      totalTokens: 18023,
    };
    expect(normalizeAntigravityPromptUsage(inclusive)).toEqual(inclusive);

    const noCache = {
      inputTokens: 8857,
      outputTokens: 717,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      thoughtTokens: 714,
      totalTokens: 9574,
    };
    expect(normalizeAntigravityPromptUsage(noCache)).toEqual(noCache);
  });
});

describe("normalizeAntigravitySessionUpdate large file diffs", () => {
  it("preserves exact unified diff and structured change when editing early lines of a >8KB file", () => {
    const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}: ${"x".repeat(48)}`);
    const newLines = [...oldLines];
    newLines[4] = `line 5: EDITED ${"x".repeat(48)}`;
    const oldText = `${oldLines.join("\n")}\n`;
    const newText = `${newLines.join("\n")}\n`;
    expect(oldText.length).toBeGreaterThan(15_000);

    const normalized = normalizeAntigravitySessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-large-1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/workspace/large.txt",
            oldText,
            newText,
          },
        ],
      },
    });
    const parsed = parseSessionUpdateEvent(normalized).events[0];
    if (parsed?._tag !== "ToolCallUpdated") {
      throw new Error("Expected ToolCallUpdated event");
    }
    const toolCall = normalizeAntigravityToolCall(parsed.toolCall);
    const patch = acpToolCallDiffPatch(toolCall.data.content);
    expect(patch).toBeDefined();
    expect(patch).toContain("@@ -2,7 +2,7 @@");
    expect(patch).toContain("-line 5:");
    expect(patch).toContain("+line 5: EDITED");
    // Bound retained state so full >15KB file bodies are not kept in memory.
    expect(JSON.stringify(toolCall.data.content).length).toBeLessThan(2_000);
  });

  it("preserves add patch headers for a large newly written file without tail-truncating headers", () => {
    const newText = `${Array.from({ length: 300 }, (_, i) => `created line ${i + 1}: ${"y".repeat(40)}`).join("\n")}\n`;
    expect(newText.length).toBeGreaterThan(15_000);

    const normalized = normalizeAntigravitySessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "write-large-1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/workspace/created.txt",
            newText,
          },
        ],
      },
    });
    const parsed = parseSessionUpdateEvent(normalized).events[0];
    if (parsed?._tag !== "ToolCallUpdated") {
      throw new Error("Expected ToolCallUpdated event");
    }
    const toolCall = normalizeAntigravityToolCall(parsed.toolCall);
    const patch = acpToolCallDiffPatch(toolCall.data.content);
    expect(patch).toBeDefined();
    expect(patch?.startsWith("--- /dev/null\n+++ /workspace/created.txt\n@@ -0,0 +1,300 @@")).toBe(
      true,
    );
    expect(patch).toContain("+created line 1:");
  });
});

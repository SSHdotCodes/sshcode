// @effect-diagnostics nodeBuiltinImport:off -- dev-only synthetic case-file validation.
import { assert, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

import {
  parseCompletion,
  canonicalCall,
  compatibleRequest,
  buildBase,
  buildMessages,
  failedEarly,
  executeCodex,
  gradeSample,
  requiredSamples,
  regressedCases,
  failedToRun,
  makeSample,
  ranCalls,
  McpToolUseCase,
  mockOutput,
  normalizeToolInput,
  normalizeToolName,
  type SampleRun,
  shellOutput,
  shellRequest,
  t3SystemAppend,
} from "./run.ts";

const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));

it("loads every synthetic case without contradictory required and forbidden calls", () => {
  const directory = new URL("./cases/", import.meta.url);
  const ids = new Set<string>();
  for (const name of NodeFS.readdirSync(directory).filter((name) => name.endsWith(".ndjson"))) {
    for (const line of NodeFS.readFileSync(new URL(name, directory), "utf8").trim().split("\n")) {
      const testCase = decodeCase(line);
      expect(ids.has(testCase.id), testCase.id).toBe(false);
      ids.add(testCase.id);
      const forbidden = new Set(testCase.expect.notCalls);
      for (const call of testCase.expect.calls ?? []) {
        expect(
          call.tool.split("|").every((tool) => forbidden.has(tool)),
          testCase.id,
        ).toBe(false);
      }
    }
  }
  expect(ids.size).toBeGreaterThan(100);
});

it("grades Codex shell and subagent calls with the shared rules", () => {
  const calls = [
    { name: "exec_command", input: { cmd: "sleep 60" } },
    { name: "collaboration.spawn_agent", input: { task: "review" } },
    { name: "mcp__t3_code__delegate_task", input: {} },
  ].map(({ name, input }) => ({
    step: 0,
    tool: normalizeToolName(name),
    input: normalizeToolInput(name, input),
  }));
  assert.deepEqual(
    calls.map((c) => c.tool),
    ["Bash", "Agent", "delegate_task"],
  );
  assert.deepEqual(
    failed(
      {
        calls: [{ tool: "Bash", args: { command: "~sleep" } }],
        notCalls: ["Agent"],
        shellMustNot: ["sleep"],
      },
      { calls, text: "", stopReason: "end_turn" },
    ),
    ["notCalls Agent", "shellMustNot /sleep/"],
  );
});

it("accepts any tool listed as an alternative", () => {
  const expect = { calls: [{ tool: "link_pull_request|watch_pull_request" }] };
  const run = (tool: string): SampleRun => ({
    calls: [{ step: 0, tool, input: {} }],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, run("watch_pull_request")), []);
  assert.deepEqual(failed(expect, run("list_thread_pull_requests")), [
    "calls link_pull_request|watch_pull_request",
  ]);
});

it("does not count a crashed CLI as a passing no-call control", () => {
  assert.deepEqual(
    failed(
      { notCalls: ["delegate_task"] },
      {
        calls: [],
        text: "",
        stopReason: "cli_error",
      },
    ),
    ["CLI completed"],
  );
});

it("resumes a changed outcome for its third sample and preserves completed regressions", () => {
  const failed = { id: "passing-before", pass: false };
  const baseline = new Map([[failed.id, 1]]);
  expect(requiredSamples([failed, failed], { baseline: 1 })).toBe(3);
  expect(regressedCases([failed, failed], baseline)).toEqual([]);
  expect(regressedCases([failed, failed, failed], baseline)).toEqual([failed.id]);
  expect(requiredSamples([{ pass: true }, { pass: true }], { baseline: 1 })).toBe(2);
  expect(requiredSamples([{ pass: true }, { pass: false }])).toBe(3);
  expect(requiredSamples([], { samples: 1, baseline: 1 })).toBe(1);
});

it("separates CLI capacity and transport failures from graded tool-use failures", () => {
  expect(failedToRun({ stopReason: "cli_error" })).toBe(true);
  expect(failedToRun({ error: "Model API 429" })).toBe(true);
  expect(failedToRun({ stopReason: "end_turn" })).toBe(false);
  expect(failedToRun({ stopReason: "failed_early" })).toBe(false);
});

it("runs code-mode calls without exposing host capabilities, including after await", async () => {
  const catalog = [{ name: "mock", description: "mock" }];
  const result = await executeCodex(
    "text((await tools.mock({n: 2})).n); text([typeof process, typeof require, typeof fetch]);",
    catalog,
    async (_, input) => input,
  );
  assert.include(result, "2\n");
  assert.include(result, '["undefined","undefined","undefined"]');
  assert.include(
    await executeCodex('text.constructor("return process")()', catalog, async () => null),
    "Code generation from strings disallowed",
  );
  await expect(
    executeCodex("await tools.mock({}); while (true) {}", catalog, async () => null),
  ).rejects.toThrow("Script execution timed out");
});

it("answers a code-mode call the cell does not await", async () => {
  const answered: Array<unknown> = [];
  const catalog = [{ name: "mock", description: "mock" }];
  await executeCodex('tools.mock({n: 1}); text("done");', catalog, async (_, input) => {
    answered.push(input);
    return null;
  });
  assert.deepEqual(answered, [{ n: 1 }]);
});

const failed = (expect: Parameters<typeof gradeSample>[0], run: SampleRun) =>
  gradeSample(expect, run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

it("passes a good run and names every rule a bad run breaks", () => {
  const expect = {
    calls: [{ tool: "delegate_task", args: { task: "~FINDING", "target.options": "~max" } }],
    callsMustNot: [{ tool: "delegate_task", args: { runtimeMode: "approval-required" } }],
    notCalls: ["t3_thread_send"],
    order: ["orchestrator_capabilities", "delegate_task"],
    minCalls: { orchestrator_capabilities: 1 },
    maxCalls: { task_status: 0 },
    endsTurnAfter: "delegate_task",
    shellMustNot: ["\\bsleep\\b"],
    textMust: ["t3-thread://v1/"],
    textMustNot: ["Paste .*token"],
    linked: ["~/pull/124"],
  };
  const good: SampleRun = {
    calls: [
      { step: 0, tool: "orchestrator_capabilities", input: {} },
      {
        step: 1,
        tool: "delegate_task",
        input: { task: "Prior findings: ...", target: { options: { reasoningEffort: "max" } } },
      },
    ],
    text: "Started [Review](t3-thread://v1/11111111-1111-4111-8111-111111111111). Do not paste a token.",
    stopReason: "end_turn",
    linked: ["https://github.com/acme/app/pull/124"],
  };
  assert.deepEqual(failed(expect, good), []);

  const bad: SampleRun = {
    calls: [
      {
        step: 0,
        tool: "delegate_task",
        input: { task: "Review again", runtimeMode: "approval-required" },
      },
      { step: 1, tool: "t3_thread_send", input: {} },
      { step: 2, tool: "Monitor", input: { command: "sleep 60" } },
      { step: 3, tool: "task_status", input: { taskId: "task-1" } },
    ],
    text: "Paste your token here.",
    stopReason: "max_steps",
  };
  assert.deepEqual(failed(expect, bad), [
    'calls delegate_task {"task":"~FINDING","target.options":"~max"}',
    'callsMustNot delegate_task {"runtimeMode":"approval-required"}',
    "notCalls t3_thread_send",
    "order orchestrator_capabilities > delegate_task",
    "minCalls orchestrator_capabilities >= 1",
    "maxCalls task_status <= 0",
    "endsTurnAfter delegate_task",
    "shellMustNot /\\bsleep\\b/",
    "textMust /t3-thread://v1//",
    "textMustNot /Paste .*token/",
    "linked ~/pull/124",
  ]);
});

it("bounds numbers and reads target.options in either schema form", () => {
  const expect = {
    calls: [
      { tool: "t3_thread_read", args: { limit: "<=20" } },
      { tool: "delegate_task", args: { "target.options.effort": "max", timeoutMs: ">=60000" } },
    ],
  };
  const run = (limit: unknown, options: unknown, timeoutMs: number): SampleRun => ({
    calls: [
      { step: 0, tool: "t3_thread_read", input: { limit } },
      { step: 0, tool: "delegate_task", input: { target: { options }, timeoutMs } },
    ],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, run(20, [{ id: "effort", value: "max" }], 60_000)), []);
  assert.deepEqual(failed(expect, run(5, { effort: "max" }, 90_000)), []);
  assert.lengthOf(failed(expect, run(21, [{ id: "effort", value: "high" }], 59_999)), 2);
  assert.lengthOf(failed(expect, run("10", {}, 60_000)), 2);
});

const template = {
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
    { type: "text", text: "You are Claude Code." },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\n# currentDate\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\n# gitStatus\nmain\n</system-reminder>" },
        {
          type: "text",
          text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>",
        },
        { type: "text", text: "The captured prompt." },
      ],
    },
    {
      role: "system",
      content:
        "Main prompt.\n - Primary working directory: /home/alice/app\n\n<runtime_info>old</runtime_info>\n\n## SSHCode orchestration\nold text",
    },
    {
      role: "system",
      content:
        "You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\nmcp__t3-code__retired_tool\n\nAfter the list.",
    },
    { role: "assistant", content: [{ type: "text", text: "A later turn." }] },
  ],
  tools: [
    { name: "mcp__host__term_Bash", input_schema: { type: "object" } },
    { name: "mcp__host__clown_ToolSearch", input_schema: { type: "object" } },
    { name: "mcp__t3-code__retired_tool", input_schema: { type: "object" }, defer_loading: true },
  ],
};

const childCase: McpToolUseCase = {
  id: "child-links-its-pr",
  area: "pull-requests",
  kind: "guard",
  pattern: "delegated child watches PR",
  experience: "A delegated child must link its PR and report back, not watch it.",
  setup: {
    role: "delegated-child",
    delegateRole: "implementation",
    world: { branch: "fix/date-format", files: { "src/date.ts": "export const format = 1;\n" } },
    priorTurns: [
      {
        role: "assistant",
        toolCalls: [{ tool: "Bash", input: { command: "git push" }, result: "pushed" }],
      },
    ],
    shellMocks: [{ match: "^gh pr create", output: "https://github.com/acme/app/pull/124" }],
  },
  prompt: "Push the fix, open a PR against main, and report the PR URL.",
  expect: { calls: [{ tool: "link_pull_request" }], notCalls: ["watch_pull_request"] },
};

it("rebuilds the template from this checkout and sends a child T3's brief as written", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const system = base.system.map((block) => String(block.text));
  assert.deepEqual(system.slice(0, 2), [
    "You are Claude Code.",
    `Main prompt.\n - Primary working directory: /home/user/app\n\n${t3SystemAppend("claude-sonnet-5-5")}`,
  ]);
  assert.equal(base.environment.cwd, "/home/user/app");
  assert.include(
    system[2],
    "model named claude-sonnet-5-5. The exact model ID is claude-sonnet-5-5.",
  );
  const deferred = system[2]?.split("Load them first:\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
  assert.includeMembers(deferred, [
    "Monitor",
    "mcp__t3-code__delegate_task",
    "mcp__t3-code__preview_snapshot",
    "mcp__t3-code__computer_action",
    "mcp__t3-code__model_preferences",
  ]);
  for (const name of ["preview_snapshot", "computer_action", "model_preferences"]) {
    const tool = base.t3.find((tool) => tool.name === `mcp__t3-code__${name}`);
    assert.isDefined(tool?.input_schema, `agent eval schema: ${name}`);
    assert.equal(normalizeToolName(name), name);
  }
  assert.notInclude(deferred, "mcp__t3-code__retired_tool");
  // A delegated child is never offered the tools T3 hides from subagents.
  assert.notInclude(deferred, "mcp__t3-code__watch_pull_request");
  const child = buildBase(template, {
    model: "claude-sonnet-5-5",
    keepUserInstructions: false,
    subagent: true,
  });
  assert.notInclude(String(child.system[2]?.text), "mcp__t3-code__watch_pull_request");
  assert.notInclude(
    child.t3.map((tool) => tool.name),
    "mcp__t3-code__unwatch_pull_request",
  );
  const reminders = buildMessages(makeSample(childCase, base))[0]?.content.map((b) => b.text);
  assert.equal(reminders?.[0], "<system-reminder>\n# currentDate\n</system-reminder>");
  assert.include(reminders?.[1], "Current branch: fix/date-format");
  assert.notInclude(reminders?.join(), "Codebase and user instructions");

  const prompt = buildMessages(makeSample(childCase, base)).at(-1)?.content.at(-1);
  // A subagent receives its brief as written; the role is data on the task.
  assert.equal(prompt?.text, childCase.prompt);
});

it("replays earlier capability results with the model under test as the caller", () => {
  const base = buildBase(template, { model: "claude-opus-5-5", keepUserInstructions: false });
  const capabilities = {
    inheritedProviderInstanceId: "claudeAgent",
    inheritedModel: "claude-sonnet-5-5",
  };
  const testCase: McpToolUseCase = {
    ...childCase,
    setup: {
      role: "top",
      priorTurns: [
        {
          role: "assistant",
          toolCalls: [{ tool: "orchestrator_capabilities", input: {}, result: capabilities }],
        },
      ],
    },
  };
  const replayed = buildMessages(makeSample(testCase, base))
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && String(block.content).includes("inherited"));
  assert.include(String(replayed?.content), '"inheritedModel":"claude-opus-5-5"');
});

it("does not record a deferred tool called before it was loaded", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const sample = makeSample(childCase, base);
  const use = (name: string) => ({ type: "tool_use" as const, id: name, name, input: {} });
  const ran = ranCalls(sample, 0, [
    use("mcp__t3-code__link_pull_request"),
    use("mcp__host__term_Bash"),
  ]);
  assert.deepEqual(
    ran.map((call) => call.tool),
    ["Bash"],
  );
});

it("answers simple mocked commands itself and gives the simulator the sample's history", () => {
  const sample = makeSample(
    childCase,
    buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false }),
  );
  assert.equal(mockOutput(sample, "gh pr create --fill"), "https://github.com/acme/app/pull/124");
  assert.isUndefined(mockOutput(sample, "git push && gh pr create --fill"));
  assert.isUndefined(mockOutput(sample, "git status"));

  const call = { tool: "Bash", input: { command: "git push && gh pr create --fill" } };
  const [machine, history] =
    shellRequest(sample, call, "claude-haiku-5-5").messages[0]?.content ?? [];
  assert.include(machine?.text, "Working directory: /home/user/app");
  assert.include(machine?.text, '"src/date.ts":"export const format = 1;\\n"');
  assert.include(machine?.text, "^gh pr create");
  assert.include(machine?.text, childCase.prompt);
  assert.equal(
    history?.text,
    '<call>Bash {"command":"git push"}</call>\n<output>\npushed\n</output>\n\nNew call:\n<call>Bash {"command":"git push && gh pr create --fill"}</call>',
  );
});

it("does not pretend this fork auto-links a PR created by a shell command", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const bash = (command: string, result: string) => ({ tool: "Bash", input: { command }, result });
  const sample = makeSample(
    {
      ...childCase,
      setup: {
        ...childCase.setup,
        priorTurns: [
          {
            role: "assistant",
            toolCalls: [
              bash("gh pr create --fill", "https://github.com/acme/app/pull/124"),
              bash("gh pr view 123 --json url -q .url", "https://github.com/acme/app/pull/123"),
            ],
          },
        ],
      },
    },
    base,
  );
  assert.deepEqual([...sample.linked], []);
});

it("reads the tool output from the simulator's JSON reply", () => {
  const reply = (value: string) => [{ type: "thinking" }, { type: "text", text: value }];
  assert.equal(
    shellOutput(reply('{"facts":"PR 124 is new","output":"https://x/pull/124\\n"}')),
    "https://x/pull/124",
  );
  assert.equal(shellOutput(reply("plain output\n")), "plain output");
});

it("stops a sample only once a must-not check has failed", () => {
  const run = (tool: string, text = ""): SampleRun => ({
    calls: [{ step: 0, tool, input: {} }],
    text,
    stopReason: "tool_use",
  });
  const expect = { calls: [{ tool: "link_pull_request" }], notCalls: ["watch_pull_request"] };
  assert.isFalse(failedEarly(expect, run("Bash")));
  assert.isTrue(failedEarly(expect, run("watch_pull_request")));
  assert.isTrue(failedEarly({ textMustNot: ["paste"] }, run("Bash", "paste it here")));
});

it("grades dotted paths through arrays, including important question cards", () => {
  const expect = { calls: [{ tool: "ask_user", args: { "questions.0.important": true } }] };
  const sample = (important: boolean): SampleRun => ({
    calls: [{ step: 0, tool: "ask_user", input: { questions: [{ important }] } }],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, sample(true)), []);
  assert.lengthOf(failed(expect, sample(false)), 1);
});

it("grades old tool names and merged actions against the same expectations", () => {
  assert.deepEqual(
    canonicalCall("mcp__t3_code__t3_queue", { action: "reorder", beforeRunId: null }),
    { tool: "t3_queue_reorder", input: { action: "reorder", beforeRunId: null } },
  );
  assert.equal(
    canonicalCall("schedule_task", { scheduledTaskId: "schedule-1", enabled: false }).tool,
    "update_scheduled_task",
  );
  assert.equal(canonicalCall("t3_thread_configure", {}).tool, "t3_thread_configuration");
  assert.equal(canonicalCall("preview_act", { action: "click" }).tool, "preview_click");
});

it("translates code-mode calls and their results for OpenAI-compatible endpoints", () => {
  const request = compatibleRequest({
    model: "test-model",
    reasoning: { effort: "low" },
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            name: "functions",
            tools: [{ type: "custom", name: "exec", description: "Execute code" }],
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "owned context" }],
      },
      { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "text(1)" },
      { type: "custom_tool_call_output", call_id: "call-1", output: "1" },
    ],
  });
  assert.equal(request.reasoning_effort, "low");
  assert.deepEqual(request.messages, [
    { role: "system", content: "owned context" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "exec", arguments: '{"code":"text(1)"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "1" },
  ]);
});

it("reassembles streamed function arguments and token usage", () => {
  const raw =
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "example", arguments: '{"action":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "done",
              tool_calls: [{ index: 0, function: { arguments: '"read"}' } }],
            },
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  assert.deepEqual(parseCompletion(raw), {
    choices: [
      {
        message: {
          content: "done",
          tool_calls: [
            { id: "call-1", function: { name: "example", arguments: '{"action":"read"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
});

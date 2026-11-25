import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { NodeId } from "./baseSchemas.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";

import {
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "./orchestratorMcp.ts";

const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeTaskStatusInput = Schema.decodeUnknownSync(OrchestratorMcpTaskStatusInput);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

describe("orchestrator MCP contracts", () => {
  it("publishes grading guidance for work against the brief in every grading input", () => {
    for (const schema of [
      OrchestratorMcpDelegateTaskInput,
      OrchestratorMcpTaskStatusInput,
      OrchestratorMcpThreadSendInput,
    ]) {
      expect(JSON.stringify(Schema.toJsonSchemaDocument(schema).schema)).toContain(
        "Rate work against the brief, not findings",
      );
    }
  });
  it("decodes a JSON-stringified delegate target as the same object", () => {
    const target = {
      providerInstanceId: "codex",
      model: "gpt-6.2-sol",
      options: { reasoningEffort: "medium" },
    };
    const structured = decodeDelegateTaskInput({ task: "Inspect", target });
    expect(decodeDelegateTaskInput({ task: "Inspect", target: JSON.stringify(target) })).toEqual(
      structured,
    );
    for (const invalidTarget of ["{model:", '{"model":42}'])
      expect(() => decodeDelegateTaskInput({ task: "Inspect", target: invalidTarget })).toThrow();
  });
  it("opts into parent edits for worktree delegation", () => {
    expect(decodeDelegateTaskInput({ task: "Work" }).withEdits).toBeUndefined();
    expect(
      decodeDelegateTaskInput({ task: "Work", isolation: "worktree", withEdits: true }).withEdits,
    ).toBe(true);
    expect(() => decodeDelegateTaskInput({ task: "Work", withEdits: "true" })).toThrow();
  });
  it("accepts malformed optional grades without rejecting the primary call", () => {
    expect(decodeTaskStatusInput({ taskId: "task" })).toEqual({ taskId: "task" });
    expect(
      decodeTaskStatusInput({
        taskId: "task",
        grades: [{ taskId: "child", score: 4, note: "Useful review" }],
      }),
    ).toMatchObject({ grades: [{ taskId: "child", score: 4, note: "Useful review" }] });
    for (const grades of [null, {}, 42, "bad"]) {
      expect(decodeDelegateTaskInput({ task: "Work", grades }).task).toBe("Work");
    }
    for (const grade of [
      { taskId: "child", score: 0 },
      { taskId: "child", score: 11 },
      { taskId: "child", score: 2.5 },
      { taskId: "child", score: "4" },
      { taskId: "child", score: 4, note: "x".repeat(81) },
      { score: 4 },
    ]) {
      expect(decodeTaskStatusInput({ taskId: "task", grades: [grade] }).taskId).toBe("task");
      expect(decodeDelegateTaskInput({ task: "Work", grades: [grade] }).task).toBe("Work");
    }
  });
  it("preserves typed input fields when publishing their descriptions", () => {
    const request = decodeDelegateTaskInput({
      task: "Review",
      target: { providerInstanceId: "provider" },
    });
    const status = decodeTaskStatusInput({ taskId: "task" });
    expectTypeOf(request.task).toEqualTypeOf<string>();
    expectTypeOf(request.target?.providerInstanceId).toEqualTypeOf<
      ProviderInstanceId | undefined
    >();
    expectTypeOf(status.taskId).toEqualTypeOf<NodeId>();
  });

  it("accepts optional tail and search inputs without changing forward calls", () => {
    expect(decodeThreadReadInput({ threadId: "thread-read" })).toEqual({ threadId: "thread-read" });
    expect(
      decodeThreadReadInput({
        threadId: "thread-read",
        fromEnd: true,
        beforePosition: 20,
        query: "developer mode",
        limit: 5,
      }),
    ).toMatchObject({ fromEnd: true, beforePosition: 20, query: "developer mode", limit: 5 });
    for (const fields of [
      { beforePosition: -1 },
      { beforePosition: 1.5 },
      { fromEnd: "true" },
      { query: "a".repeat(1_001) },
      { limit: 101 },
    ]) {
      expect(() => decodeThreadReadInput({ threadId: "thread-read", ...fields })).toThrow();
    }
  });

  it("accepts explicit worktree isolation and keeps shared delegation as the default", () => {
    expect(decodeDelegateTaskInput({ task: "Review changes" }).isolation).toBeUndefined();
    expect(
      decodeDelegateTaskInput({ task: "Review changes", isolation: "worktree" }).isolation,
    ).toBe("worktree");
    expect(() => decodeDelegateTaskInput({ task: "Review changes", isolation: "copy" })).toThrow();
    expect(
      decodeDelegateTaskInput({
        task: "Review changes",
        isolation: "worktree",
        repositoryPath: "/work/project",
      }).repositoryPath,
    ).toBe("/work/project");
    expect(() =>
      decodeDelegateTaskInput({ task: "Review changes", repositoryPath: " " }),
    ).toThrow();
  });
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
    });
    // A running task omits every field with no value yet.
    const running = decodeDelegateTaskResult({
      taskId: "node-task-2",
      status: "running",
      workState: "working",
      providerInstanceId: "claudeAgent",
    });
    expect(running.summary).toBeUndefined();
    expect(running.hasPendingQuestion).toBeUndefined();

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(
      decodeDelegateTaskResult({
        ...result,
        status: "failed",
        failure: {
          class: "provider_error",
          code: "serverOverloaded",
          message: "Capacity unavailable",
          retryable: true,
        },
      }).failure?.retryable,
    ).toBe(true);
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          // Must fail loudly instead of being dropped like legacy persistence.
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("clamps a thread list limit above its maximum instead of rejecting it", () => {
    expect(decodeThreadListInput({ limit: 200 }).limit).toBe(100);
    expect(decodeThreadListInput({ limit: 7 }).limit).toBe(7);
    expect(() => decodeThreadListInput({ limit: 0 })).toThrow();
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });
});

it("accepts old thread results and optional background work", () => {
  for (const fields of [OrchestratorMcpThreadListItem.fields, OrchestratorMcpThreadDetail.fields]) {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({
        blockedOnThreadWait: fields.blockedOnThreadWait,
        pendingBackgroundTasks: fields.pendingBackgroundTasks,
      }),
    );
    expect(decode({})).toEqual({});
    const work = {
      blockedOnThreadWait: true,
      pendingBackgroundTasks: [
        { taskId: "watch", kind: "monitor", description: "Tests" },
        { taskId: "child", kind: "subagent", childThreadId: "thread:child" },
      ],
    };
    expect(decode(work)).toEqual(work);
    expect(() =>
      decode({ pendingBackgroundTasks: [{ taskId: "watch", kind: "unknown" }] }),
    ).toThrow();
  }
});

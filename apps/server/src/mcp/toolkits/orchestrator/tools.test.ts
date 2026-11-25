import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Context from "effect/Context";
import { ProjectToolkit } from "../project/tools.ts";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  // These left the always-on orchestration rules on 2026-11-13: the tool an agent loads before
  // calling it carries them, so they must stay in these descriptions.
  it("carries the card, monitor and secret rules the orchestration rules leave to tools", () => {
    const text = (tool: Tool.Any) => JSON.stringify(Tool.getJsonSchema(tool)) + tool.description;
    const tools = OrchestratorToolkit.tools;
    for (const [tool, guidance] of [
      [tools.ask_user, "'(Recommended)'"],
      [tools.ask_user, "10 minutes"],
      [tools.ask_user, "spending beyond what they approved"],
      [tools.ask_user, "hard to undo"],
      [tools.monitor_start, "durable:true"],
      [tools.monitor_start, "restartable:true"],
      [tools.monitor_start, "silenceMs"],
      [tools.monitor_start, "persistent:true"],
      [tools.request_secret, "delivery:'file'"],
      [tools.request_secret, "sudo password"],
      [tools.delegate_task, "Git repository at its current local commit"],
    ] as const)
      assert.include(text(tool), guidance, `${tool.name}: ${guidance}`);
  });

  it("keeps internal source paths out of the public thread launch tool", () => {
    const schema = Tool.getJsonSchema(ProjectToolkit.tools.t3_thread_launch);
    assert.notInclude(JSON.stringify(schema), '"sourcePath"');
  });

  it("explains tail paging and bounded all-words search", () => {
    const tool = OrchestratorToolkit.tools.t3_thread_read;
    for (const guidance of [
      "afterPosition=nextPosition",
      "fromEnd=false",
      "~30k chars",
      "beforePosition=prevPosition",
      "all whitespace-separated words",
      "newest first",
      "snippet",
      "at most 1000 items",
      "null when the scan bound",
    ]) {
      assert.include(tool.description ?? "", guidance);
    }
  });

  it("advertises bounded quota refreshes without making spare quota a reason to delegate", () => {
    const tool = OrchestratorToolkit.tools.usage_limits;
    assert.isTrue(Context.get(tool.annotations, Tool.Readonly));
    assert.isFalse(Context.get(tool.annotations, Tool.Destructive));
    assert.isFalse(Context.get(tool.annotations, Tool.OpenWorld));
    assert.include(tool.description ?? "", "Provider quotas");
    assert.include(tool.description ?? "", "Refreshes stale readings for up to 3s");
    assert.include(tool.description ?? "", "choose subagent providers");
    assert.include(tool.description ?? "", "spare quota is no reason to delegate");
    assert.include(
      OrchestratorToolkit.tools.orchestrator_capabilities.description ?? "",
      "usage_limits",
    );
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required ?? [], []);
    assert.hasAllKeys(schema.properties ?? {}, ["providerInstanceId"]);
  });

  it("directs subagent requests to delegation instead of ordinary threads", () => {
    for (const guidance of [
      "child owned by this thread",
      "no parent history",
      "scratch chat",
      "repositoryPath",
      "waitTimedOut",
      "new clientRequestId",
      "independent review round",
      "t3_thread_send with its taskId",
    ])
      assert.include(DelegateTaskTool.description ?? "", guidance);
    assert.include(CreateThreadsTool.description ?? "", "only when the user asks");
    assert.include(CreateThreadsTool.description ?? "", "delegate_task");
    assert.include(CreateThreadsTool.description ?? "", "No project");
    assert.include(CreateThreadsTool.description ?? "", "t3_project_list");
    assert.include(
      OrchestratorToolkit.tools.t3_thread_send.description ?? "",
      "completed task gets a new short taskId",
    );
    assert.include(OrchestratorToolkit.tools.task_cancel.description ?? "", "later child turns");
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Defaults to async");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("accepts short task handles, full ids, and unique request ids", () => {
    for (const tool of [
      OrchestratorToolkit.tools.task_status,
      OrchestratorToolkit.tools.task_cancel,
    ]) {
      const schema = JSON.stringify(Tool.getJsonSchema(tool));
      assert.include(schema, "Task handle, full taskId, or unique clientRequestId");
      assert.notInclude(schema, "Do not pass clientRequestId");
    }
  });

  it("publishes delegation hints on the encoded strings agents actually receive", () => {
    const schema = JSON.stringify(Tool.getJsonSchema(DelegateTaskTool));
    for (const guidance of [
      "Self-contained task",
      "Absolute path the child works in",
      "Exact orchestrator_capabilities model id, not its label",
      "unique delegation keys also reference tasks",
      "Configured provider instance id",
    ])
      assert.include(schema, guidance);
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.include(JSON.stringify(schema.properties?.schedule), "Trigger object");
    assert.include(JSON.stringify(schema.properties?.schedule), "{type:'once', runAt}");
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "schedule is an object");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("says council members are told to stay read-only, not enforced", () => {
    const description = OrchestratorToolkit.tools.council.description ?? "";
    assert.include(description, "told to stay read-only");
    assert.notInclude(description, "as a read-only delegated task");
  });

  it("accepts one or several key names in prepare_api_key", () => {
    const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.prepare_api_key) as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly anyOf?: ReadonlyArray<{
              readonly type?: unknown;
              readonly minItems?: unknown;
              readonly maxItems?: unknown;
            }>;
          }
        >
      >;
    };
    assert.deepEqual(schema.required ?? [], []);
    assert.hasAllKeys(schema.properties ?? {}, ["name", "names"]);
    const names = schema.properties?.names?.anyOf?.find((branch) => branch.type === "array");
    assert.equal(names?.minItems, 1);
    assert.equal(names?.maxItems, 20);
    assert.include(
      OrchestratorToolkit.tools.prepare_api_key.description ?? "",
      "one-use, 60-second ticket",
    );
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "runId",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch unsupported");
  });
});

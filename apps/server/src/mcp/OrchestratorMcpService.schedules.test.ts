import * as LocalFiles from "../assets/LocalFileAttachments.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as ScheduleState from "../scheduledTasks/ScheduledTaskState.testkit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Usage from "../usage/UsageLimitSources.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as Mcp from "./OrchestratorMcpService.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(LocalFiles.LocalFileAttachments)({}),
  ScheduleState.layer,
  Sqlite.layerMemory,
  ServerSettings.layerTest(),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(Projects.ProjectService)({}),
  Layer.mock(Providers.ProviderRegistry)({}),
  Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({}),
  Layer.mock(Threads.ThreadManagementService)({}),
  Layer.mock(Launch.ThreadLaunchService)({}),
  Layer.mock(Git.GitVcsDriver)({}),
  Layer.mock(Secrets.SecretRequests)({}),
  Layer.mock(Usage.UsageLimitSources)({}),
  Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
);
const client: McpInvocationScope = {
  environmentId: EnvironmentId.make("schedule-test"),
  requestNamespace: "client",
  thread: undefined,
  client: { sessionId: "client", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const fixture = Effect.gen(function* () {
  const schedules = yield* Schedules.ScheduledTaskService;
  const { task } = yield* schedules.upsert({
    title: "Scheduled review",
    prompt: "Review",
    projectId: ProjectId.make("project"),
    schedule: { type: "interval", everyMs: 60_000 },
    enabled: true,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    accountPinned: true,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  return { schedules, id: task.id };
});
const layer = Schedules.layer.pipe(Layer.provideMerge(dependencies));

it.effect("an MCP edit cannot recreate a concurrently deleted schedule", () =>
  Effect.gen(function* () {
    const { schedules, id } = yield* fixture;
    const editing = {
      ...schedules,
      list: () => schedules.list().pipe(Effect.tap(() => schedules.delete({ id }))),
    };
    const result = yield* Mcp.OrchestratorMcpService.pipe(
      Effect.flatMap((mcp) =>
        mcp.updateScheduledTask(client, { scheduledTaskId: id, enabled: false }),
      ),
      Effect.provide(Mcp.layer),
      Effect.provideService(Schedules.ScheduledTaskService, editing),
      Effect.result,
    );
    expect((yield* schedules.list()).tasks).toEqual([]);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("editing the prompt keeps the provider account the user pinned", () =>
  Effect.gen(function* () {
    const { schedules, id } = yield* fixture;
    yield* Mcp.OrchestratorMcpService.pipe(
      Effect.flatMap((mcp) =>
        mcp.updateScheduledTask(client, { scheduledTaskId: id, prompt: "Edited" }),
      ),
      Effect.provide(Mcp.layer),
    );
    expect((yield* schedules.list()).tasks[0]).toMatchObject({
      prompt: "Edited",
      accountPinned: true,
    });
  }).pipe(Effect.provide(layer)),
);

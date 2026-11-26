import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  MonitorError,
  OrchestratorMcpFailure,
  type MonitorListResult,
  type MonitorStartInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { monitorBufferingProblem } from "../monitors/monitorCommandBuffering.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { makeRepeatChecks, unchangedNotice } from "./repeatChecks.ts";
import { assertFullAccess, assertLiveCaller, readCaller, unavailable } from "./threadAccess.ts";

export class MonitorMcpService extends Context.Service<
  MonitorMcpService,
  {
    readonly start: (
      scope: McpInvocationContext.McpInvocationScope,
      input: MonitorStartInput,
    ) => Effect.Effect<
      {
        readonly monitorId: string;
        readonly logPath?: string;
        readonly wakePolicy: string;
        readonly warning?: string;
      },
      OrchestratorMcpFailure
    >;
    readonly stop: (
      scope: McpInvocationContext.McpInvocationScope,
      monitorId: string,
    ) => Effect.Effect<{ readonly stopped: boolean }, OrchestratorMcpFailure>;
    readonly list: (
      scope: McpInvocationContext.McpInvocationScope,
      includeOutput: boolean,
    ) => Effect.Effect<typeof MonitorListResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/mcp/MonitorMcpService") {}

const monitorFailure = (error: MonitorError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "spawn" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const make = Effect.gen(function* () {
  const monitors = yield* MonitorService.MonitorService;
  const projects = yield* ProjectService.ProjectService;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const withCaller = <A>(
    scope: McpInvocationContext.McpInvocationScope,
    operation: string,
    run: (
      thread: NonNullable<import("./threadAccess.ts").Caller["caller"]>,
    ) => Effect.Effect<A, OrchestratorMcpFailure>,
  ) =>
    Effect.gen(function* () {
      const threadScope = yield* McpInvocationContext.requireThreadScope(scope, operation);
      return yield* executor.withLock(
        threadScope.thread.threadId,
        Effect.gen(function* () {
          const caller = yield* readCaller();
          yield* assertLiveCaller(caller);
          if (operation === "monitor_start")
            yield* assertFullAccess(
              caller,
              "Starting shell monitors requires a full-access/default thread.",
            );
          return yield* run(caller.caller!);
        }).pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        ),
      );
    });

  const repeatListChecks = makeRepeatChecks();

  return MonitorMcpService.of({
    start: (scope, input) =>
      withCaller(scope, "monitor_start", (thread) =>
        Effect.gen(function* () {
          const project = yield* projects
            .getById(thread.projectId)
            .pipe(Effect.mapError(unavailable));
          const cwd =
            thread.worktreePath ??
            (project._tag === "Some" ? project.value.workspaceRoot : undefined);
          if (cwd === undefined) return yield* unavailable();
          const started = yield* monitors
            .start({ ...input, threadId: thread.id, cwd, requestNamespace: scope.requestNamespace })
            .pipe(Effect.mapError(monitorFailure));
          // Shell is too flexible to refuse on a guess: start it and say why it may stay silent.
          const warning = monitorBufferingProblem(input.command);
          const wakePolicy =
            typeof input.wakeOn === "string"
              ? "Matches + exit"
              : input.wakeOn === false || input.durable === true
                ? "Exit only"
                : "Throttled output + exit";
          return { ...started, wakePolicy, ...(warning === undefined ? {} : { warning }) };
        }),
      ),
    stop: (scope, monitorId) =>
      withCaller(scope, "monitor_stop", (thread) =>
        monitors.stop(thread.id, monitorId).pipe(
          Effect.map((stopped) => ({ stopped })),
          Effect.mapError(monitorFailure),
        ),
      ),
    list: (scope, includeOutput) =>
      withCaller(scope, "monitor_list", (thread) =>
        Effect.gen(function* () {
          const listed = (yield* monitors.list(thread.id)).map(
            ({ threadId: _threadId, output, ...monitor }) => ({
              ...monitor,
              ...(includeOutput && output !== undefined ? { output } : {}),
            }),
          );
          if (includeOutput || listed.length === 0) return { monitors: listed };
          const since = repeatListChecks(
            thread.id,
            listed.map((monitor) => `${monitor.monitorId}:${monitor.state ?? "running"}`).join(","),
            yield* Clock.currentTimeMillis,
          );
          return since === undefined
            ? { monitors: listed }
            : {
                monitors: listed,
                notice: unchangedNotice(since, "Monitor exit (or output selected by its policy)"),
              };
        }),
      ),
  });
});

export const layer = Layer.effect(MonitorMcpService, make);

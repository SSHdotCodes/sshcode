import * as MonitorMcpService from "../../MonitorMcpService.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as ApiKeyStore from "../../../secrets/ApiKeyStore.ts";
import { requireThreadScope } from "../../McpInvocationContext.ts";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

import { compactDelegateTaskResult } from "../../delegateTaskDetails.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const handlers = {
  monitor_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* MonitorMcpService.MonitorMcpService;
      return yield* service.start(scope, input);
    }),
  ),
  monitor_stop: McpToolAccess.actsAsCaller(({ monitorId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* MonitorMcpService.MonitorMcpService;
      return yield* service.stop(scope, monitorId);
    }),
  ),
  monitor_list: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* MonitorMcpService.MonitorMcpService;
      return yield* service.list(scope);
    }),
  ),
  orchestrator_capabilities: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope, input);
    }),
  ),
  usage_limits: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.usageLimits(scope, input);
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller(({ grades, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const feedback = yield* service.gradeTasks(scope, grades);
      const result = compactDelegateTaskResult(yield* service.delegateTask(scope, input));
      return feedback.skipped.length ? { ...result, grades: feedback } : result;
    }),
  ),
  council: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.council(scope, input);
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId, grades }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const feedback = yield* service.gradeTasks(scope, grades);
      const status = compactDelegateTaskResult(yield* service.taskStatus(scope, taskId));
      const rated =
        Array.isArray(grades) &&
        grades.some(
          (grade: unknown) =>
            grade !== null &&
            typeof grade === "object" &&
            "taskId" in grade &&
            grade.taskId === taskId,
        );
      // Grading a task means its result was read, even if the grade itself was skipped.
      const {
        summary: _readSummary,
        latestTerminalSummary: _readTerminalSummary,
        ...withoutResult
      } = status;
      const result = rated ? withoutResult : status;
      return feedback.skipped.length ? { ...result, grades: feedback } : result;
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  t3_workflow_stop: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads } = yield* readCaller();
        return yield* threads.stopWorkflow(input).pipe(
          Effect.as({}),
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code:
                  cause.reason === "unavailable" || cause.reason === "stop-failed"
                    ? "orchestration_error"
                    : "invalid_request",
                message: cause.message,
              }),
          ),
        );
      }),
  ),
  schedule_task: McpToolAccess.either(
    (input) => input.scheduledTaskId === undefined,
    McpToolAccess.startsThreads(
      () => ({}),
      ({ prompt, schedule, ...input }) =>
        Effect.gen(function* () {
          if (prompt === undefined || schedule === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "A new scheduled task needs `prompt` and `schedule`.",
            });
          }
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.scheduleTask(scope, { ...input, prompt, schedule });
        }),
    ),
    McpToolAccess.writes(
      ({ scheduledTaskId, prompt, title, schedule, enabled, bindToCurrentThread }) =>
        Effect.gen(function* () {
          if (scheduledTaskId === undefined) return yield* Effect.die("unreachable");
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.updateScheduledTask(scope, {
            scheduledTaskId,
            prompt,
            title,
            schedule,
            enabled,
            bindToCurrentThread,
          });
        }),
    ),
  ),
  scheduled_task_runs: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTaskRuns(scope, input);
    }),
  ),
  webhook_preview: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.previewScheduledTaskWebhook(scope, input);
    }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  ask_user: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.askUser(scope, input);
    }),
  ),
  request_api_key: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, {
        label: input.label,
        reason: input.reason,
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        apiKey: {
          name: input.name,
          ...(input.suggestedScope === undefined ? {} : { suggestedScope: input.suggestedScope }),
          ...(input.suggestedExpiresAt === undefined
            ? {}
            : { suggestedExpiresAt: input.suggestedExpiresAt }),
        },
      });
    }),
  ),
  list_api_keys: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "list_api_keys",
      );
      return yield* (yield* ApiKeyStore.ApiKeyStore)
        .list(scope.thread.threadId)
        .pipe(
          Effect.map((items) =>
            items.map(({ name, scope, expiresAt }) => ({ name, scope, expiresAt })),
          ),
        );
    }),
  ),
  prepare_api_key: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "prepare_api_key",
      );
      const names = input.names ?? (input.name === undefined ? undefined : [input.name]);
      if (names === undefined || (input.name !== undefined && input.names !== undefined))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass either name (one key) or names (several keys).",
        });
      const serverOption = yield* Effect.serviceOption(HttpServer.HttpServer);
      if (Option.isNone(serverOption))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "API key shell access needs a running local server.",
        });
      const server = serverOption.value;
      if (!NetAddress.isInetAddress(server.address))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "API key shell access requires a local TCP server.",
        });
      const host = NetAddress.isUnspecified(server.address.address)
        ? "127.0.0.1"
        : NetAddress.formatIp(server.address.address);
      if (!["127.0.0.1", "::1"].includes(host))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "API key shell access requires the server to listen on loopback or a wildcard address.",
        });
      const store = yield* ApiKeyStore.ApiKeyStore;
      const endpoint = `http://${host === "::1" ? "[::1]" : host}:${server.address.port}/mcp/api-key`;
      const cli = yield* store.secretRunCommand;
      // One single-use ticket per name; a batch never shares or widens a ticket.
      const commands = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const ticket = yield* store.prepare(name, scope.thread.threadId);
          return {
            name,
            command: `${cli} --endpoint '${endpoint}' --ticket '${ticket}' --env ${name} -- <command> [args...]`,
          };
        }),
      );
      return input.names === undefined ? { command: commands[0]!.command } : { commands };
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listThreads(scope, input);
    }),
  ),
  // Reading a child's finished result also acknowledges its delivery to the
  // reader's own thread. That is bookkeeping on the caller's own subagent, not
  // a change to anything it reads, so this stays a read.
  t3_thread_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  ),
  t3_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  t3_thread_send: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    ({ grades, ...input }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const feedback = yield* service.gradeTasks(scope, grades);
        const result = yield* service.sendToThread(scope, input);
        return feedback.skipped.length ? { ...result, grades: feedback } : result;
      }),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  ),
  t3_thread_interrupt: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.interruptThread(scope, input);
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);

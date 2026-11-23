import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ScheduledTaskShells from "./ScheduledTaskShells.ts";
import * as ScheduledTaskStateTest from "./ScheduledTaskState.testkit.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect(
  "tracks the earliest enabled bound recurrence through edits, disabling and deletion",
  () =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const shells = yield* ScheduledTaskShells.ScheduledTaskShells;
      const threadId = ThreadId.make("scheduled-chat");
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:recurring",
        title: "Review",
        prompt: "Review the work",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project",
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const first = (yield* service.upsert(input)).task;
      expect(shells.nextRunAt(threadId)).toBe(first.nextRunAt);
      const later = (yield* service.upsert({
        ...input,
        id: undefined,
        schedule: { type: "interval", everyMs: 120_000 },
      })).task;
      expect(shells.nextRunAt(threadId)).toBe(first.nextRunAt);
      yield* service.setEnabled({ id: first.id, enabled: false });
      expect(shells.nextRunAt(threadId)).toBe(later.nextRunAt);
      yield* service.delete({ id: later.id });
      expect(shells.nextRunAt(threadId)).toBeNull();
      yield* service.setEnabled({ id: first.id, enabled: true });
      yield* service.upsert({ ...input, threadId: null });
      expect(shells.nextRunAt(threadId)).toBeNull();
      yield* service.upsert({
        ...input,
        schedule: { type: "once", runAt: "2099-01-01T00:00:00Z" },
      });
      expect(shells.nextRunAt(threadId)).toBeNull();
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provideMerge(ScheduledTaskShells.layer),
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              ScheduledTaskStateTest.layer,
            ),
          ),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);

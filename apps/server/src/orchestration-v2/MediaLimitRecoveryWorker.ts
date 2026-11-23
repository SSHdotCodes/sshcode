import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Gets chats past a provider's limit on images in one request.
 *
 * Harnesses resend every image in the conversation with each request, so an
 * agent that keeps viewing screenshots or rendered frames eventually passes
 * the provider's total (OpenCode Zen: "inlined media exceeds the 33554432 byte
 * total limit"), and every later turn fails the same way. Compacting replaces
 * the history, and its images, with a summary. The worker compacts with the
 * harness's own command, then continues the chat.
 */

/** The provider wording, kept loose enough for other gateways' versions of it. */
export const MEDIA_LIMIT_MESSAGE = "media exceeds";
const MINUTE_MS = 60_000;
/** Older failures are left for the user; the chat may have moved on. */
const FAILURE_WINDOW_MS = 30 * MINUTE_MS;
/** The scheduler ticks every few seconds; the database is read this often. */
const SWEEP_INTERVAL_MS = 10_000;
/**
 * A compaction that keeps the images (or a chat that refills them at once)
 * fails the same way; one automatic try per chat per window, then the error
 * stays for the user.
 */
const RECOVERY_WINDOW_MS = 30 * MINUTE_MS;

/** The harness's compaction command: `/compact`, or Qwen Code's `/compress`. */
export function compactionCommand(provider: ServerProvider | undefined): string | null {
  const names = new Set((provider?.slashCommands ?? []).map((command) => command.name));
  if (names.has("compact")) return "/compact";
  if (names.has("compress")) return "/compress";
  return null;
}

export function mediaLimitRecoveryCommands(
  stop: { readonly threadId: ThreadId; readonly runId: string },
  command: string,
): ReadonlyArray<OrchestrationV2Command> {
  // One recovery per failed run, even if a sweep repeats or the server restarts.
  const compactId = `media-limit-compact:${stop.runId}`;
  const continueId = `media-limit-continue:${stop.runId}`;
  return [
    {
      type: "message.dispatch",
      commandId: CommandId.make(compactId),
      messageId: MessageId.make(compactId),
      threadId: stop.threadId,
      text: command,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "Compacting: the chat's images passed the provider's size limit",
      },
      attachments: [],
      // Server notices must queue; the chat is idle, so this starts at once
      // and the continue below waits for it.
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make(continueId),
      messageId: MessageId.make(continueId),
      threadId: stop.threadId,
      text: "Continue where you left off. The chat was compacted because its images passed the provider's size limit; from now on, view images at a smaller size (downscale renders and screenshots first) and only when you need to.",
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "Continuing after compacting",
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    },
  ];
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  let lastSweepMs = Number.NEGATIVE_INFINITY;
  const recovered = new Map<ThreadId, number>();

  return Effect.fn("MediaLimitRecoveryWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = nowMs;
    for (const [threadId, atMs] of recovered) {
      if (nowMs - atMs >= RECOVERY_WINDOW_MS) recovered.delete(threadId);
    }
    const stops = yield* projections.getSignedOutStops({
      since: DateTime.makeUnsafe(nowMs - FAILURE_WINDOW_MS),
      messageContains: MEDIA_LIMIT_MESSAGE,
    });
    if (stops.length === 0) return;
    const snapshots = yield* providers.getProviders;
    for (const stop of stops) {
      if (recovered.has(stop.threadId)) continue;
      const command = compactionCommand(
        snapshots.find((provider) => provider.instanceId === stop.providerInstanceId),
      );
      if (command === null) continue;
      if (
        !ProjectionStore.isCurrentRecoveryStop(
          stop,
          yield* projections.getThreadShell(stop.threadId),
          yield* DateTime.now,
        )
      )
        continue;
      recovered.set(stop.threadId, nowMs);
      // A continue without its compaction would hit the same limit at once.
      yield* Effect.forEach(mediaLimitRecoveryCommands(stop, command), threads.dispatch, {
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.media-limit-recovery.dispatch-failed", {
            threadId: stop.threadId,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("media-limit-recovery", sweep());
  }),
);

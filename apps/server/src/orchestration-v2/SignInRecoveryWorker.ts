import {
  CommandId,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  MessageId,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { CLAUDE_SIGNED_OUT_PREFIX } from "../provider/Drivers/ClaudeHome.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Gets chats past a Claude sign-out.
 *
 * With a fallback token saved (ClaudeLogin.ts), a chat that just stopped on
 * the regular login switches the instance to the token: its Claude processes
 * restart and the chats it stopped continue at once. Once the user signs in
 * again, new processes go back to the login, so usage and claude.ai
 * connectors return. Neither step spends any usage.
 *
 * Without a fallback, chats continue only with "Continue stopped chats" on,
 * once Claude works again. Claude's own status check still reports an account
 * when its login no longer works, so the worker asks the instance for a tiny
 * reply, and a reply is the proof: signing in again, a new token, a restart.
 */

const MINUTE_MS = 60_000;
/** Older stops are left for the user; the chat may have moved on. */
const SIGNED_OUT_WINDOW_MS = 24 * 60 * MINUTE_MS;
/** The scheduler ticks every few seconds; the database is read this often. */
const SWEEP_INTERVAL_MS = MINUTE_MS;
/**
 * The first check waits a little after the newest stop, so a chat that just
 * failed is not retried at once. Each failed check waits longer.
 */
const CHECK_DELAYS_MS = [2, 5, 10, 15, 30].map((minutes) => minutes * MINUTE_MS);
/**
 * A chat that fails again right after a check passed would otherwise go
 * around forever, so each chat continues at most this often per window.
 */
const MAX_RESUMES_PER_THREAD = 2;
/** Only chats this fresh switch to the token and continue; older ones wait for the user. */
const FALLBACK_STOP_WINDOW_MS = 30 * MINUTE_MS;

export interface InstanceChecks {
  readonly failed: number;
  readonly lastCheckMs: number;
}

/** When the instance's next sign-in check is due. */
export function nextCheckDueMs(newestStopMs: number, checks: InstanceChecks | undefined): number {
  if (checks === undefined || checks.lastCheckMs < newestStopMs) {
    return newestStopMs + CHECK_DELAYS_MS[0]!;
  }
  return checks.lastCheckMs + CHECK_DELAYS_MS[Math.min(checks.failed, CHECK_DELAYS_MS.length - 1)]!;
}

export function signInResumeCommand(stop: {
  readonly threadId: ThreadId;
  readonly runId: string;
}): OrchestrationV2Command {
  // One continuation per stopped run, even if a sweep repeats.
  const identity = `signin-resume:${stop.threadId}:${stop.runId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: stop.threadId,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  let lastSweepMs = Number.NEGATIVE_INFINITY;
  const checks = new Map<ProviderInstanceId, InstanceChecks>();
  const resumes = new Map<ThreadId, Array<number>>();
  /** When each instance last switched to its token or back to its login. */
  const switchedAt = new Map<ProviderInstanceId, number>();

  const resume = Effect.fn("SignInRecoveryWorker.resume")(function* (
    stops: ReadonlyArray<ProjectionStore.ProjectionSignedOutStop>,
    nowMs: number,
    restartSession = false,
  ) {
    const stillStopped = Effect.fnUntraced(function* (
      stop: ProjectionStore.ProjectionSignedOutStop,
    ) {
      return ProjectionStore.isCurrentRecoveryStop(
        stop,
        yield* projections.getThreadShell(stop.threadId),
        yield* DateTime.now,
      );
    });
    for (const stop of stops) {
      if (!(yield* stillStopped(stop))) continue;
      const times = resumes.get(stop.threadId) ?? [];
      if (times.length >= MAX_RESUMES_PER_THREAD) continue;
      if (restartSession) {
        const records = yield* projections.getThreadRecords(stop.threadId, [
          "runs",
          "providerThreads",
        ]);
        const run = records.runs.find((run) => run.id === stop.runId);
        const sessionId = records.providerThreads.find(
          (thread) => thread.id === run?.providerThreadId,
        )?.providerSessionId;
        // Only the failed chat restarts. Other processes keep their credentials
        // until their active turn and background work finish.
        if (sessionId != null) {
          yield* sessions.close(sessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.sign-in-recovery.close-failed", {
                threadId: stop.threadId,
                cause,
              }),
            ),
          );
        }
        if (!(yield* stillStopped(stop))) continue;
      }
      resumes.set(stop.threadId, [...times, nowMs]);
      yield* threads.dispatch(signInResumeCommand(stop)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.sign-in-recovery.dispatch-failed", {
            threadId: stop.threadId,
            cause,
          }),
        ),
      );
    }
  });

  /** Back to the regular login once the user signs in again. */
  const tryLoginAgain = Effect.fn("SignInRecoveryWorker.tryLoginAgain")(function* (nowMs: number) {
    for (const instance of yield* registry.listInstances) {
      const fallback = instance.loginFallback;
      if (fallback === undefined || !(yield* fallback.usingFallback)) continue;
      if (!(yield* fallback.loginRenewed)) continue;
      switchedAt.set(instance.instanceId, nowMs);
      // Running processes keep the token until they end; new ones use the login.
      yield* fallback.useLogin;
      yield* Effect.logInfo("orchestration-v2.sign-in-recovery.login-restored", {
        instanceId: instance.instanceId,
      });
    }
  });

  const signedIn = Effect.fn("SignInRecoveryWorker.signedIn")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    const model =
      instance === undefined
        ? undefined
        : DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind];
    const rewrite = instance?.enabled ? instance.textGeneration.rewriteProse : undefined;
    // Without a way to check, the chats wait for the user.
    if (rewrite === undefined || model === undefined) return false;
    return yield* rewrite({
      cwd: stateDir,
      prompt: "Reply with the single word OK.",
      modelSelection: { instanceId, model },
    }).pipe(
      Effect.timeout("2 minutes"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  return Effect.fn("SignInRecoveryWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = nowMs;
    yield* tryLoginAgain(nowMs);
    const autoResume = (yield* settings.getSettings).autoResumeLimitedThreads;

    const stops = yield* projections.getSignedOutStops({
      since: DateTime.makeUnsafe(nowMs - SIGNED_OUT_WINDOW_MS),
      messagePrefix: CLAUDE_SIGNED_OUT_PREFIX,
    });
    const byInstance = Map.groupBy(stops, (stop) => stop.providerInstanceId);
    for (const instanceId of checks.keys()) {
      if (!byInstance.has(instanceId)) checks.delete(instanceId);
    }
    for (const [threadId, times] of resumes) {
      const recent = times.filter((time) => nowMs - time < SIGNED_OUT_WINDOW_MS);
      if (recent.length === 0) resumes.delete(threadId);
      else resumes.set(threadId, recent);
    }

    for (const [instanceId, instanceStops] of byInstance) {
      const newestStopMs = Math.max(
        ...instanceStops.map((stop) => DateTime.toEpochMillis(stop.completedAt)),
      );
      const fallback = (yield* registry.getInstance(instanceId))?.loginFallback;
      if (
        fallback !== undefined &&
        nowMs - newestStopMs <= FALLBACK_STOP_WINDOW_MS &&
        // A stop from before the login came back must not switch again.
        newestStopMs > (switchedAt.get(instanceId) ?? Number.NEGATIVE_INFINITY) &&
        (yield* fallback.useFallback)
      ) {
        switchedAt.set(instanceId, nowMs);
        yield* Effect.logInfo("orchestration-v2.sign-in-recovery.using-fallback-token", {
          instanceId,
        });
        // New processes use the token, so the login's sign-out no longer keeps work away.
        // Should the token fail too, its own failed run records that.
        const failure = (yield* providers.getProviders).find(
          (provider) => provider.instanceId === instanceId,
        )?.recentFailure;
        if (failure?.kind === "authentication_error")
          yield* providers.setProviderRecentFailure({ instanceId, failure: null });
        yield* resume(
          instanceStops.filter(
            (stop) => nowMs - DateTime.toEpochMillis(stop.completedAt) <= FALLBACK_STOP_WINDOW_MS,
          ),
          nowMs,
          true,
        );
        continue;
      }
      if (!autoResume) continue;
      const previous = checks.get(instanceId);
      if (nowMs < nextCheckDueMs(newestStopMs, previous)) continue;
      if (!(yield* signedIn(instanceId))) {
        checks.set(instanceId, {
          failed:
            previous !== undefined && previous.lastCheckMs >= newestStopMs
              ? previous.failed + 1
              : 1,
          lastCheckMs: nowMs,
        });
        continue;
      }
      checks.delete(instanceId);
      yield* resume(instanceStops, nowMs);
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("sign-in-recovery", sweep());
  }),
);

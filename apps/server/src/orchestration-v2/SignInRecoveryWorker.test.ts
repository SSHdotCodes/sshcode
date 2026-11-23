import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { makeClaudeLoginFallback, splitClaudeToken } from "../provider/Drivers/ClaudeLogin.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeSweep, nextCheckDueMs, signInResumeCommand } from "./SignInRecoveryWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MINUTE = 60_000;

describe("sign-in recovery", () => {
  it("checks shortly after a stop, then less often while it stays signed out", () => {
    const stop = 1_000 * MINUTE;
    expect(nextCheckDueMs(stop, undefined)).toBe(stop + 2 * MINUTE);
    let checks = { failed: 0, lastCheckMs: stop + 2 * MINUTE };
    const waits: Array<number> = [];
    for (let failed = 1; failed <= 6; failed++) {
      checks = { failed, lastCheckMs: checks.lastCheckMs };
      const due = nextCheckDueMs(stop, checks);
      waits.push((due - checks.lastCheckMs) / MINUTE);
      checks = { failed, lastCheckMs: due };
    }
    expect(waits).toEqual([5, 10, 15, 30, 30, 30]);
  });

  it("starts over when a chat stops after the last check", () => {
    const checks = { failed: 4, lastCheckMs: 100 * MINUTE };
    expect(nextCheckDueMs(110 * MINUTE, checks)).toBe(112 * MINUTE);
  });

  it("continues each stopped run once", () => {
    const threadId = ThreadId.make("thread-a");
    const first = signInResumeCommand({ threadId, runId: "run-1" });
    expect(first).toMatchObject({
      type: "message.dispatch",
      threadId,
      text: "Continue where you left off.",
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "server",
    });
    expect(signInResumeCommand({ threadId, runId: "run-1" }).commandId).toBe(first.commandId);
    expect(signInResumeCommand({ threadId, runId: "run-2" }).commandId).not.toBe(first.commandId);
  });
});

describe("sign-in recovery with a saved token", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const threadId = ThreadId.make("thread-signed-out");

  it.effect("restarts only signed-out sessions when switching to the fallback token", () =>
    Effect.gen(function* () {
      // The stored login's expiry; signing in again writes a new one.
      let storedLogin: number | undefined = 1_000;
      const fallback = yield* makeClaudeLoginFallback(
        "sk-ant-oat01-test",
        Effect.sync(() => (storedLogin === undefined ? undefined : { expiresAt: storedLogin })),
      );
      const sessionId = ProviderSessionId.make("session-signed-out");
      const liveSessions = new Set([sessionId, "session-active", "session-background"]);
      const closed: Array<string> = [];
      const dispatched: Array<string> = [];
      const cleared: Array<string> = [];
      const instance = {
        instanceId,
        loginFallback: {
          usingFallback: fallback.usingToken,
          useFallback: fallback.useToken,
          useLogin: fallback.useLogin,
          loginRenewed: fallback.loginRenewed,
        },
      };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const stop = {
        threadId,
        runId: RunId.make("run-signed-out"),
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        completedAt: DateTime.makeUnsafe(now),
      };
      const childId = ThreadId.make("signed-out-child");
      const sweep = yield* makeSweep.pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          getSignedOutStops: () => Effect.succeed([stop, { ...stop, threadId: childId }]),
          getThreadShell: (id: ThreadId) =>
            Effect.succeed({
              id,
              lineage: { relationshipToParent: id === childId ? "subagent" : null },
              creationSource: id === childId ? "mcp" : "web",
              latestRunId: stop.runId,
              providerInstanceId: instanceId,
              modelSelection: stop.modelSelection,
              status: "failed",
              pendingRuntimeRequest: null,
              archivedAt: null,
              deletedAt: null,
              settledOverride: null,
            }),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: stop.runId, providerThreadId: "provider-thread-signed-out" }],
              providerThreads: [{ id: "provider-thread-signed-out", providerSessionId: sessionId }],
            }),
        } as never),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          dispatch: (command: { readonly commandId: string }) =>
            Effect.sync(() => void dispatched.push(command.commandId)),
        } as never),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({ autoResumeLimitedThreads: false }),
        } as never),
        Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () => Effect.succeed(instance),
          listInstances: Effect.succeed([instance]),
        } as never),
        Effect.provideService(ProviderRegistry, {
          getProviders: Effect.sync(() => [
            { instanceId, recentFailure: { kind: "authentication_error" } },
          ]),
          setProviderRecentFailure: (input: {
            readonly instanceId: string;
            readonly failure: unknown;
          }) => Effect.sync(() => void (input.failure === null && cleared.push(input.instanceId))),
        } as never),
        Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
          close: (id: string) =>
            Effect.sync(() => {
              closed.push(id);
              liveSessions.delete(id);
            }),
          closeInstance: (id: string) =>
            Effect.sync(() => {
              closed.push(id);
              liveSessions.clear();
            }),
        } as never),
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-sign-in-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );

      // Until a sign-in fails, no process gets the token.
      expect(yield* fallback.environment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });

      // A fresh stop on the login: the token takes over and the chat continues,
      // even with "Continue stopped chats" off.
      yield* sweep();
      expect(yield* fallback.usingToken).toBe(true);
      expect(closed).toEqual([sessionId]);
      expect([...liveSessions]).toEqual(["session-active", "session-background"]);
      expect(dispatched).toEqual([`signin-resume:${threadId}:run-signed-out`]);
      // The login's sign-out no longer describes the account its new processes use.
      expect(cleared).toEqual([instanceId]);
      expect(yield* fallback.environment({ PATH: "/bin" })).toEqual({
        PATH: "/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      });

      // The same stop never switches or continues twice, and an unchanged
      // (or wiped) login keeps the token.
      yield* TestClock.adjust("2 minutes");
      yield* sweep();
      storedLogin = undefined;
      yield* TestClock.adjust("2 minutes");
      yield* sweep();
      expect(yield* fallback.usingToken).toBe(true);
      expect(closed).toHaveLength(1);
      expect(dispatched).toHaveLength(1);

      // Signing in again stores a new login: back to it within a minute.
      storedLogin = 2_000;
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      expect(yield* fallback.usingToken).toBe(false);
      expect(yield* fallback.environment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });

      // That old stop must not switch it back to the token.
      yield* TestClock.adjust("1 minute");
      yield* sweep();
      expect(yield* fallback.usingToken).toBe(false);
      expect(closed).toHaveLength(1);
    }),
  );
});

describe("a saved token without any stored login", () => {
  it.effect("is used from the first process until a login is stored", () =>
    Effect.gen(function* () {
      // A remote machine gets only the token, never a copy of the Mac's login.
      let storedLogin: { readonly expiresAt: number | undefined } | undefined;
      const fallback = yield* makeClaudeLoginFallback(
        "sk-ant-oat01-test",
        Effect.sync(() => storedLogin),
      );
      expect(yield* fallback.environment({ PATH: "/bin" })).toEqual({
        PATH: "/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      });
      expect(yield* fallback.useToken).toBe(false);
      expect(yield* fallback.loginRenewed).toBe(false);
      storedLogin = { expiresAt: 3_000 };
      expect(yield* fallback.loginRenewed).toBe(true);
    }),
  );
});

describe("splitClaudeToken", () => {
  it("takes the token out and drops pasted whitespace", () => {
    expect(
      splitClaudeToken({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-ab\n cd " }),
    ).toEqual({ environment: { PATH: "/bin" }, token: "sk-ant-oat01-abcd" });
    expect(splitClaudeToken({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "  " })).toEqual({
      environment: { PATH: "/bin" },
      token: undefined,
    });
  });
});

describe("sign-in recovery revalidation", () => {
  it.effect.each([
    "unchanged",
    "delegated task",
    "expired snooze",
    "new run",
    "provider",
    "model",
    "snooze",
    "settled",
    "pending request",
    "active",
    "archived",
    "deleted",
  ])("does not resume after an auth check when the chat changed: %s", (change) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const threadId = ThreadId.make("signin-revalidate");
      const now = yield* DateTime.now;
      const stop = {
        threadId,
        runId: RunId.make("signin-revalidate:failed"),
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        completedAt: DateTime.subtract(now, { minutes: 3 }),
      };
      const entered = yield* Deferred.make<void>();
      const checked = yield* Deferred.make<void>();
      let deleted = false;
      const thread = {
        id: threadId,
        lineage: { relationshipToParent: change === "delegated task" ? "subagent" : null },
        creationSource: change === "delegated task" ? "mcp" : "web",
        providerInstanceId: instanceId,
        modelSelection: stop.modelSelection,
        latestRunId: stop.runId,
        status: "failed",
        pendingRuntimeRequest: null,
        settledOverride: null,
        snoozedUntil: null,
        archivedAt: null,
        deletedAt: null,
      } as Record<string, unknown>;
      const dispatched: Array<unknown> = [];
      const sweep = yield* makeSweep.pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          getSignedOutStops: () => Effect.succeed([stop]),
          getThreadShell: () => Effect.sync(() => (deleted ? null : thread)),
        } as never),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          dispatch: (command: unknown) => Effect.sync(() => void dispatched.push(command)),
        } as never),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({ autoResumeLimitedThreads: true }),
        } as never),
        Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          listInstances: Effect.succeed([]),
          getInstance: () =>
            Effect.succeed({
              instanceId,
              driverKind: "claudeAgent",
              enabled: true,
              textGeneration: {
                rewriteProse: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(checked)),
                    Effect.as("OK"),
                  ),
              },
            }),
        } as never),
        Effect.provideService(ProviderRegistry, {} as never),
        Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {} as never),
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-signin-revalidate-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      if (change === "delegated task") {
        // Its lead can already have removed the checkout after seeing the failure.
        yield* Deferred.succeed(checked, undefined);
        yield* sweep();
        expect(yield* Deferred.isDone(entered)).toBe(false);
        expect(dispatched).toHaveLength(0);
        return;
      }
      const fiber = yield* sweep().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      switch (change) {
        case "deleted":
          deleted = true;
          break;
        case "expired snooze":
          thread.snoozedUntil = DateTime.subtract(now, { hours: 1 });
          break;
        case "new run":
          thread.latestRunId = RunId.make("signin-revalidate:new");
          break;
        case "provider":
          thread.providerInstanceId = ProviderInstanceId.make("other");
          break;
        case "model":
          thread.modelSelection = { ...stop.modelSelection, model: "other-model" };
          break;
        case "snooze":
          thread.snoozedUntil = DateTime.add(now, { hours: 1 });
          break;
        case "settled":
          thread.settledOverride = "settled";
          break;
        case "pending request":
          thread.pendingRuntimeRequest = {};
          break;
        case "active":
          thread.status = "running";
          break;
        case "archived":
          thread.archivedAt = now;
          break;
      }
      yield* Deferred.succeed(checked, undefined);
      yield* Fiber.join(fiber);
      expect(dispatched).toHaveLength(
        change === "unchanged" || change === "expired snooze" ? 1 : 0,
      );
    }),
  );
});

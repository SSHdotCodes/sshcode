import { EnvironmentId, WS_METHODS, type ClientActivityReportInput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  observeBackgroundActivitySubscription,
  reportEnvironmentActivity,
  retainedBackgroundScopes,
  sessionConnectSignals,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("reportEnvironmentActivity", () => {
  it.effect("sends activity only to an environment with a live session", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined } });
      vi.stubGlobal("document", {
        visibilityState: "visible",
        hasFocus: () => true,
      });
      const reports: Array<ClientActivityReportInput> = [];
      const client = {
        [WS_METHODS.serverReportClientActivity]: (input: ClientActivityReportInput) =>
          Effect.sync(() => {
            reports.push(input);
          }),
      };
      const session = Option.some({
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      } as unknown as RpcSession);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
      const retryCount = yield* Ref.make(0);
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("environment-studio"),
          label: "Studio",
          httpBaseUrl: "https://studio.example.test",
          wsBaseUrl: "wss://studio.example.test",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: activeSession,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Ref.update(retryCount, (count) => count + 1),
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const input = { lastInteractionAtMs: 1_000, observedAtMs: 2_000 };

      // A disconnected environment has no session: no report is sent.
      yield* reportEnvironmentActivity(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(reports).toEqual([]);

      // A live session receives the activity report.
      yield* SubscriptionRef.set(activeSession, session);
      yield* reportEnvironmentActivity(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(reports.length).toBe(1);
      vi.unstubAllGlobals();
    }),
  );
});

describe("sessionConnectSignals", () => {
  it.effect("signals once per reconnect, and not on a session swap", () =>
    Effect.gen(function* () {
      const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
      const signals = yield* sessionConnectSignals(session).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      // Let the watcher subscribe and consume the replayed absent state.
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow;

      // None -> Some is a reconnect: one signal.
      yield* SubscriptionRef.set(session, Option.some({} as unknown as RpcSession));
      // A live session replaced by another live session is not a reconnect.
      yield* SubscriptionRef.set(session, Option.some({} as unknown as RpcSession));
      // Disconnect then reconnect again: a second signal.
      yield* SubscriptionRef.set(session, Option.none());
      yield* SubscriptionRef.set(session, Option.some({} as unknown as RpcSession));

      const collected = yield* Fiber.join(signals);
      expect(Array.from(collected)).toEqual([true, true]);
    }),
  );
});

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

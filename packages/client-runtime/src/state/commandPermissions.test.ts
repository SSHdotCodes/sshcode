import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthSourceControlWriteScope,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("only provider managers can clear a credit warning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, WS_METHODS.serverRefreshProviders);
        const input = { clearOutOfCredit: true };
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), permissions: [AuthOrchestrationReadScope] }),
        );
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        expect(registry.get(permission.permissionAtom(env, input))).toBe(false);
        expect(permission.requiredScopes(input)).toEqual([
          AuthOrchestrationReadScope,
          AuthProvidersManageScope,
        ]);
        expect((yield* permission.authorize(registry, env, input).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            permissions: [AuthOrchestrationReadScope, AuthProvidersManageScope],
          }),
        );
        expect(registry.get(permission.permissionAtom(env, input))).toBe(true);
        yield* permission.authorize(registry, env, input);
      }),
    ),
  );

  it.effect("requires settings permission on the destination for owner feedback", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      for (const method of [
        WS_METHODS.serverRecordAutoModelFeedback,
        WS_METHODS.serverDecideAutoModelTask,
      ]) {
        const permission = createCommandPermissions(runtime, method);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect(permission.requiredScopes({})).toEqual([AuthSettingsWriteScope]);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), permissions: [AuthSettingsWriteScope] }),
        );
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(other))).toBe(false);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("requires a destination provider-settings grant for provider key replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(
          runtime,
          WS_METHODS.serverReplaceProviderCredential,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect(
          permission.requiredScopes({ credentialRef: "opaque-ref", value: "test-only-key" }),
        ).toEqual([AuthProvidersManageScope]);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), permissions: [AuthProvidersManageScope] }),
        );
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(other))).toBe(false);
      }),
    ),
  );
  it.effect("model ranking edits require settings access to the destination environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, WS_METHODS.serverUpdateSettings);
        const input = { patch: { modelRankings: [] }, expectedModelRankings: [] };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(env, input))).toBe(false);
        expect(permission.requiredScopes(input)).toEqual([AuthSettingsWriteScope]);
        expect(
          permission.requiredScopes({
            patch: { providerInstances: {} },
            expectedModelRankings: [],
          }),
        ).toEqual([AuthProvidersManageScope]);
        expect(
          permission.requiredScopes({ patch: { providerInstances: {}, modelRankings: [] } }),
        ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
        const denied = yield* permission.authorize(registry, env, input).pipe(Effect.exit);
        expect(denied._tag).toBe("Failure");
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), permissions: [AuthSettingsWriteScope] }),
        );
        expect(registry.get(permission.permissionAtom(env, input))).toBe(true);
        yield* permission.authorize(registry, env, input);
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(registry.get(permission.permissionAtom(other, input))).toBe(false);
      }),
    ),
  );

  it.effect("protects computer setup separately from stop and resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const install = createCommandPermissions(runtime, WS_METHODS.computerSetup);
        const stop = createCommandPermissions(runtime, WS_METHODS.computerStop);
        const resume = createCommandPermissions(runtime, WS_METHODS.computerResume);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(install.permissionAtom(env))).toBe(false);
        expect(registry.get(stop.permissionAtom(env))).toBe(true);
        expect(registry.get(resume.permissionAtom(env))).toBe(true);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(stop.permissionAtom(env))).toBe(false);
        expect(registry.get(resume.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(true), permissions: [AuthSettingsWriteScope] }),
        );
        expect(registry.get(install.permissionAtom(env))).toBe(true);
      }),
    ),
  );

  it.effect("requires the operate grant to open a native session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const nativeOpen = createCommandPermissions(runtime, WS_METHODS.nativeSessionsOpen);
        expect(registry.get(nativeOpen.permissionAtom(env))).toBe(true);
        const settingsGrant = {
          ...grant(false),
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(settingsGrant));
        expect(registry.get(nativeOpen.permissionAtom(env))).toBe(false);
      }),
    ),
  );

  it.effect("guards both Terminal handoff directions with the destination operate grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        for (const tag of [
          WS_METHODS.terminalHandoffOpen,
          WS_METHODS.terminalHandoffReturn,
          WS_METHODS.claudeRcCommand,
        ] as const) {
          const permission = createCommandPermissions(runtime, tag);
          expect(registry.get(permission.permissionAtom(env))).toBe(false);
          expect(registry.get(permission.permissionAtom(other))).toBe(true);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(permission.permissionAtom(env))).toBe(true);
          registry.set(sessions(env), AsyncResult.success(grant(false)));
        }
      }),
    ),
  );

  it.effect.each([WS_METHODS.notesMutate, WS_METHODS.casualVoice])(
    "guards %s with the destination orchestration grant",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const notes = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          registry.set(sessions(other), AsyncResult.success(grant(true)));
          expect(registry.get(notes.permissionAtom(env))).toBe(false);
          expect((yield* notes.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          expect(registry.get(notes.permissionAtom(other))).toBe(true);
          yield* notes.authorize(registry, other);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(notes.permissionAtom(env))).toBe(true);
          yield* notes.authorize(registry, env);
        }),
      ),
  );
  it.effect("requires the destination operate grant to stop monitors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const monitor = createCommandPermissions(runtime, ORCHESTRATION_V2_WS_METHODS.stopMonitor);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(monitor.permissionAtom(env))).toBe(false);
        expect((yield* monitor.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(monitor.permissionAtom(env))).toBe(true);
        yield* monitor.authorize(registry, env);
      }),
    ),
  );
  it.effect("requires the destination settings grant to edit harness defaults", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.harnessDefaultsUpdate);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );
  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to rebuild the chat search index", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(
          runtime,
          ORCHESTRATION_V2_WS_METHODS.rebuildSearchIndex,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect(
  "API key management needs settings permission but private entry needs orchestration permission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const management = createCommandPermissions(runtime, WS_METHODS.apiKeysManage);
        const entry = createCommandPermissions(runtime, WS_METHODS.secretsAnswerRequest);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(management.permissionAtom(env))).toBe(false);
        expect(registry.get(entry.permissionAtom(env))).toBe(true);
        const session = {
          ...grant(false),
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(session));
        expect(registry.get(management.permissionAtom(env))).toBe(true);
        expect(registry.get(entry.permissionAtom(env))).toBe(false);
        yield* management.authorize(registry, env, { action: "delete", id: "fake-key-id" });
      }),
    ),
);

it.effect(
  "casual voice backend changes require settings access while chat switches require operate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const voice = createCommandPermissions(runtime, WS_METHODS.casualVoice);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", enabled: false })),
        ).toBe(true);
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", backend: null })),
        ).toBe(false);
        const admin = {
          ...grant(true),
          permissions: [AuthOrchestrationOperateScope, AuthSettingsWriteScope],
          scopes: [AuthOrchestrationOperateScope, AuthSettingsWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(admin));
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", backend: null })),
        ).toBe(true);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", mode: "cloud" })),
        ).toBe(false);
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", cloudBackend: null })),
        ).toBe(false);
        expect(
          registry.get(voice.permissionAtom(env, { action: "configure", saveTraining: false })),
        ).toBe(false);
        expect(
          registry.get(
            voice.permissionAtom(env, {
              action: "feedback",
              threadId: "chat",
              inputHash: "ab".repeat(32),
            }),
          ),
        ).toBe(true);
      }),
    ),
);

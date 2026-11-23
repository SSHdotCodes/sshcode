// @effect-diagnostics nodeBuiltinImport:off -- These tests execute only /bin/sh to verify real POSIX word parsing.
import { requestProvenance } from "../requestProvenance.ts";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as Projections from "./ProjectionStore.ts";
import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  ProjectId,
  TerminalHandoffError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeChildProcess from "node:child_process";
import * as Terminal from "./TerminalHandoffService.ts";
import * as State from "./TerminalHandoffState.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Sink from "./EventSink.ts";

const id = ThreadId.make("terminal-chat");
const instanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread");
const sessionId = ProviderSessionId.make("session");
const projection = {
  thread: {
    id,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId, model: "test" },
    activeProviderThreadId: providerThreadId,
    worktreePath: "/fake/worktree",
  },
  providerThreads: [
    {
      id: providerThreadId,
      providerInstanceId: instanceId,
      providerSessionId: sessionId,
      driver: ProviderDriverKind.make("codex"),
      nativeThreadRef: { driver: "codex", nativeId: "native-123" },
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;

function fixture(
  options: {
    release?: Effect.Effect<void, TerminalHandoffError>;
    launch?: Effect.Effect<void, TerminalHandoffError>;
    worktree?: boolean;
    rollback?: boolean;
    binaryAvailable?: boolean;
  } = {},
) {
  const order: string[] = [];
  const events: OrchestrationV2DomainEvent[] = [];
  const scripts: string[] = [];
  const dependencies = Layer.mergeAll(
    State.layer,
    IdAllocator.layer,
    Layer.mock(Projections.ProjectionStoreV2)({ getNextTurnItemOrdinal: () => Effect.succeed(23) }),
    Layer.unwrap(
      Effect.gen(function* () {
        const state = yield* State.TerminalHandoffState;
        return Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed(
              options.worktree === false
                ? { ...projection, thread: { ...projection.thread, worktreePath: null } }
                : options.rollback
                  ? {
                      ...projection,
                      providerThreads: projection.providerThreads.map((provider) => ({
                        ...provider,
                        nativeConversationHeadRef: {
                          driver: ProviderDriverKind.make("codex"),
                          nativeId: "previous-head",
                          strength: "strong" as const,
                        },
                      })),
                    }
                  : projection,
            ),
          streamDomainEvents: Stream.never,
          dispatch: () =>
            Effect.sync(() => {
              expect(state.get(id).phase).toBe("handing-off");
              order.push("stop");
              return { sequence: 1, storedEvents: [] };
            }),
        });
      }),
    ).pipe(Layer.provide(State.layer)),
    Layer.mock(Sessions.ProviderSessionManagerV2)({
      releaseConfirmed: () =>
        Effect.gen(function* () {
          order.push("release");
          yield* (options.release ?? Effect.void).pipe(
            Effect.mapError(
              (cause) =>
                new Sessions.ProviderSessionReleaseError({
                  providerSessionId: sessionId,
                  reason: "manual_shutdown",
                  cause,
                }),
            ),
          );
          order.push("exited");
        }),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.succeed(Option.some({ workspaceRoot: "/fake/folder" } as never)),
    }),
    Layer.mock(Sink.EventSinkV2)({
      write: (input) =>
        Effect.sync(() => {
          events.push(...input.events);
          return [];
        }),
    }),
    Layer.succeed(Terminal.TerminalLauncher, {
      launch: (script) =>
        Effect.gen(function* () {
          order.push("launch");
          scripts.push(script);
          yield* options.launch ?? Effect.void;
        }),
    }),
  );
  return {
    order,
    events,
    scripts,
    layer: Terminal.layer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provide(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(HostProcess.Platform, "darwin")),
      Layer.provideMerge(
        Layer.succeed(HostProcess.Environment, { PATH: "/fake/bin", CODEX_HOME: "/fake/codex" }),
      ),
      Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, "/fake/home")),
      Layer.provideMerge(
        Layer.succeed(SpawnExecutableResolution, (binary) =>
          options.binaryAvailable === false ? undefined : `/fake/bin/${binary}`,
        ),
      ),
    ),
  };
}

describe("Terminal command", () => {
  it.each(["a b", "it's a 'quote'", "$HOME $(bad)", "`bad`", "a\nb", "雪🐈", ""])(
    "quotes %j as one literal POSIX word",
    (value) => {
      expect(
        NodeChildProcess.execFileSync(
          "/bin/sh",
          ["-c", `printf '%s' ${Terminal.quoteTerminalWord(value)}`],
          {
            encoding: "utf8",
          },
        ),
      ).toBe(value);
    },
  );
  it("refuses NUL", () => expect(() => Terminal.quoteTerminalWord("\0")).toThrow());
  it.effect("uses default Codex with an empty config and inherited home", () =>
    Effect.gen(function* () {
      const result = yield* Terminal.buildTerminalCommand({
        instance: { driver: ProviderDriverKind.make("codex"), config: {} },
        nativeId: "native",
        cwd: "/fake/worktree",
      });
      expect(result).toMatchObject({
        executable: "/fake/bin/codex",
        args: ["resume", "native"],
        environment: { HOME: "/fake/home", CODEX_HOME: "/fake/inherited" },
      });
      expect(result.environment).not.toHaveProperty("OPENAI_API_KEY");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/fake/home"),
      Effect.provideService(HostProcess.Environment, {
        CODEX_HOME: "/fake/inherited",
        OPENAI_API_KEY: "never-copy",
      }),
      Effect.provideService(SpawnExecutableResolution, (binary) => `/fake/bin/${binary}`),
    ),
  );
  it.effect("uses Codex shadow home, shared SQLite home and a custom executable", () =>
    Effect.gen(function* () {
      const command = yield* Terminal.buildTerminalCommand({
        instance: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            binaryPath: "~/bin/my codex",
            homePath: "~/shared",
            shadowHomePath: "~/shadow",
          },
        },
        nativeId: "session",
        cwd: "/work",
      });
      expect(command.executable).toBe("/fake/home/bin/my codex");
      expect(command.environment).toMatchObject({
        CODEX_HOME: "/fake/home/shadow",
        CODEX_SQLITE_HOME: "/fake/home/shared",
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/fake/home"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(SpawnExecutableResolution, (binary) => binary),
    ),
  );
  it.effect("uses Claude's configured home, binary and native resume id", () =>
    Effect.gen(function* () {
      const command = yield* Terminal.buildTerminalCommand({
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { binaryPath: "~/bin/claude custom", homePath: "~/claude-work" },
        },
        nativeId: "session",
        cwd: "/work",
      });
      expect(command.executable).toBe("/fake/home/bin/claude custom");
      expect(command.args).toEqual(["--resume", "session"]);
      expect(command.environment.CLAUDE_CONFIG_DIR).toBe("/fake/home/claude-work");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/fake/home"),
      Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/inherited" }),
      Effect.provideService(SpawnExecutableResolution, (binary) => binary),
    ),
  );
  it.effect("honors instance environment homes and inherited Claude config", () =>
    Effect.gen(function* () {
      const command = yield* Terminal.buildTerminalCommand({
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/instance", sensitive: false }],
        },
        nativeId: "session",
        cwd: "/work",
      });
      expect(command.environment.CLAUDE_CONFIG_DIR).toBe("/fake/home/instance");
      const inherited = yield* Terminal.buildTerminalCommand({
        instance: { driver: ProviderDriverKind.make("claudeAgent") },
        nativeId: "session",
        cwd: "/work",
      });
      expect(inherited.environment.CLAUDE_CONFIG_DIR).toBe("/inherited");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/fake/home"),
      Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/inherited" }),
      Effect.provideService(SpawnExecutableResolution, (binary) => binary),
    ),
  );
  it.each([
    [{ managed: true }, "managed"],
    [{ localClient: false }, "local Mac"],
    [{ platform: "linux" }, "local Mac"],
    [{ nativeId: undefined }, "message first"],
    [{ driver: "opencode" }, "cannot resume"],
    [{ customEnvironment: true }, "custom CLI environment"],
  ])("explains unavailable instances %j", (patch, reason) => {
    expect(
      Terminal.terminalUnavailableReason({
        localClient: true,
        platform: "darwin",
        driver: "codex",
        nativeId: "native",
        managed: false,
        customEnvironment: false,
        ...patch,
      }),
    ).toContain(reason);
  });
});

it.effect("hands off in order, blocks turns, and records one divider on return", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Terminal.TerminalHandoffService;
    const state = yield* State.TerminalHandoffState;
    yield* service.open(id, true);
    expect(f.order).toEqual(["stop", "release", "exited", "launch"]);
    expect(f.scripts[0]).toContain("cd '/fake/worktree'");
    expect(f.scripts[0]).toContain("'resume' 'native-123'");
    // A Terminal opened from inside an agent must not make the CLI that agent's child.
    expect(f.scripts[0]).toContain(
      "unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT",
    );
    expect(state.get(id).phase).toBe("in-terminal");
    const refused = yield* state.assertHere(id).pipe(Effect.exit);
    expect(Exit.isFailure(refused)).toBe(true);
    yield* TestClock.adjust("28 minutes");
    yield* service.bringBack(id);
    yield* state.assertHere(id);
    yield* service.bringBack(id);
    expect(f.events).toHaveLength(1);
    const event = f.events[0];
    if (event?.type !== "turn-item.updated" || event.payload.type !== "system_notice")
      throw new Error("Missing divider");
    expect(event.payload.message).toContain("Continued in Terminal,");
    expect(event.payload.ordinal).toBe(23);
    expect(event.payload.message).toContain(
      "The agent remembers it; those messages aren't shown here.",
    );
  }).pipe(Effect.provide(f.layer));
});
it.effect("uses the chat folder without a worktree", () => {
  const f = fixture({ worktree: false });
  return Effect.gen(function* () {
    yield* (yield* Terminal.TerminalHandoffService).open(id, true);
    expect(f.scripts[0]).toContain("cd '/fake/folder'");
  }).pipe(Effect.provide(f.layer));
});
it.effect("launches nothing and unlocks when release fails", () => {
  const f = fixture({
    release: Effect.fail(new TerminalHandoffError({ message: "not confirmed" })),
  });
  return Effect.gen(function* () {
    const result = yield* (yield* Terminal.TerminalHandoffService).open(id, true).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(f.scripts).toHaveLength(0);
    expect((yield* State.TerminalHandoffState).get(id).phase).toBe("here");
  }).pipe(Effect.provide(f.layer));
});
it.effect("waits for process exit and refuses a turn during the handoff", () =>
  Effect.gen(function* () {
    const releasing = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();
    const f = fixture({
      release: Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(exited))),
    });
    yield* Effect.gen(function* () {
      const service = yield* Terminal.TerminalHandoffService;
      const state = yield* State.TerminalHandoffState;
      const opening = yield* service.open(id, true).pipe(Effect.forkChild);
      yield* Deferred.await(releasing);
      expect(state.get(id).phase).toBe("handing-off");
      expect(f.scripts).toHaveLength(0);
      expect(Exit.isFailure(yield* state.assertHere(id).pipe(Effect.exit))).toBe(true);
      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(opening);
      expect(state.get(id).phase).toBe("in-terminal");
    }).pipe(Effect.provide(f.layer));
  }),
);
it.effect("aborts a release that never confirms within ten seconds", () => {
  const f = fixture({ release: Effect.never });
  return Effect.gen(function* () {
    const service = yield* Terminal.TerminalHandoffService;
    const opening = yield* service.open(id, true).pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
    expect(f.scripts).toHaveLength(0);
    expect((yield* State.TerminalHandoffState).get(id).phase).toBe("here");
  }).pipe(Effect.provide(f.layer));
});
it.effect.each(["withStart", "withMessageDispatch"] as const)(
  "waits for %s before releasing the terminal session",
  (operation) =>
    Effect.gen(function* () {
      const state = yield* State.TerminalHandoffState;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const launched = yield* Deferred.make<void>();
      const first = yield* state[operation](
        id,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const handoff = yield* state
        .handoff(id, Deferred.succeed(launched, undefined).pipe(Effect.asVoid))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const second = yield* state
        .withStart(id, Effect.die("must never run"))
        .pipe(Effect.exit, Effect.forkChild);
      expect(yield* Deferred.isDone(launched)).toBe(false);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(handoff);
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true);
    }).pipe(Effect.provide(State.layer)),
);

it("formats the divider with the actual local start and end times", () => {
  vi.stubEnv("TZ", "UTC");
  const divider = Terminal.terminalContinuationDivider(
    "2026-10-26T15:42:00Z",
    "2026-10-26T16:10:00Z",
  );
  vi.unstubAllEnvs();
  expect(divider.replace(/\s/gu, "")).toContain("3:42–4:10PM");
  expect(divider).toContain("those messages aren't shown here.");
});

it.effect(
  "keeps launch files private, opens Terminal with argv, and cleans leftovers on startup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-launch-" });
      let file = "";
      const layer = Terminal.layerLauncher.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir: root,
            } as ServerConfig.ServerConfig["Service"]),
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: (input) =>
                Effect.gen(function* () {
                  expect(input.command).toBe("/usr/bin/open");
                  expect(input.args.slice(0, 2)).toEqual(["-a", "Terminal"]);
                  file = input.args[2]!;
                  expect((yield* fs.stat(file)).mode & 0o777).toBe(0o700);
                  expect(yield* fs.readFileString(file)).toBe("#!/bin/sh\n# fake launcher only\n");
                  return { code: 0 } as ProcessRunner.ProcessRunOutput;
                }).pipe(Effect.orDie),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* (yield* Terminal.TerminalLauncher).launch("#!/bin/sh\n# fake launcher only\n");
      }).pipe(Effect.provide(layer));
      expect(yield* fs.exists(file)).toBe(true);
      yield* Effect.gen(function* () {
        yield* Terminal.TerminalLauncher;
      }).pipe(Effect.provide(layer));
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
);

it.effect("remote clients see the same lock and can bring the chat back", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Terminal.TerminalHandoffService;
    yield* service.open(id, true);
    const remote = yield* service.watch(id, false).pipe(Stream.runHead);
    expect(Option.getOrThrow(remote)).toMatchObject({
      phase: "in-terminal",
      unavailableReason: "Available on the local Mac",
    });
    yield* service.bringBack(id);
    expect((yield* State.TerminalHandoffState).get(id).phase).toBe("here");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a second handoff cannot launch twice or clear the first handoff's lock", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const f = fixture({
      release: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    yield* Effect.gen(function* () {
      const service = yield* Terminal.TerminalHandoffService;
      const first = yield* service.open(id, true).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(Exit.isFailure(yield* service.open(id, true).pipe(Effect.exit))).toBe(true);
      expect((yield* State.TerminalHandoffState).get(id).phase).toBe("handing-off");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      expect(f.scripts).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  }),
);

describe("local Terminal launch authorization", () => {
  const local = {
    hostname: "127.0.0.1",
    remoteAddress: "::ffff:127.0.0.1",
    origin: "t3code://app",
    surface: "desktop",
    connectionMethod: "direct",
    proxied: false,
  };
  it("supports the packaged Mac origin and a local web browser", () => {
    expect(
      Terminal.isLocalTerminalClient({
        ...local,
        provenance: requestProvenance({ ...local, headers: { origin: local.origin } }),
      }),
    ).toBe(true);
    expect(
      Terminal.isLocalTerminalClient({
        ...local,
        provenance: requestProvenance({
          ...local,
          hostname: "localhost",
          headers: { origin: "http://localhost:5733" },
        }),
        surface: "web",
      }),
    ).toBe(true);
  });
  it.each([
    { remoteAddress: "192.168.1.3" },
    { hostname: "box.example.com" },
    { origin: "https://app.t3.codes" },
    { connectionMethod: "ssh" },
    { connectionMethod: "relay" },
    { surface: "mobile" },
    // A tunnel such as the T3 Connect relay connects from loopback with the public Host.
    { proxied: true },
  ])("refuses remote or mobile callers %j", (patch) => {
    const input = { ...local, ...patch };
    expect(
      Terminal.isLocalTerminalClient({
        ...input,
        provenance: requestProvenance({
          ...input,
          headers: {
            origin: input.origin,
            ...(input.proxied ? { "x-forwarded-for": "203.0.113.1" } : {}),
          },
        }),
      }),
    ).toBe(false);
  });
});

it.effect("the next turn follows the native tail after a prior explicit resume point", () => {
  const f = fixture({ rollback: true });
  return Effect.gen(function* () {
    const service = yield* Terminal.TerminalHandoffService;
    yield* service.open(id, true);
    yield* service.bringBack(id);
    const update = f.events.find((event) => event.type === "provider-thread.updated");
    if (update?.type !== "provider-thread.updated") throw new Error("Missing native resume update");
    expect(update.payload.nativeConversationHeadRef).toBeNull();
    expect(update.payload.nativeThreadRef?.nativeId).toBe("native-123");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "withholds launch when only a bundled runtime exists and the user's CLI is missing",
  () => {
    const f = fixture({ binaryAvailable: false });
    return Effect.gen(function* () {
      const service = yield* Terminal.TerminalHandoffService;
      const status = yield* service.watch(id, true).pipe(Stream.runHead);
      expect(Option.getOrThrow(status).unavailableReason).toBe("This chat's CLI isn't available");
      expect(Exit.isFailure(yield* service.open(id, true).pipe(Effect.exit))).toBe(true);
      expect(f.scripts).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

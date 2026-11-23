// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- File mtimes use the live filesystem clock.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ChatTemp from "./ChatTemp.ts";

const NOW = Date.now();

const input = (threadId = "chat-1") => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make(threadId),
  environment: { TMPDIR: "/ambient", TMP: "/ambient", TEMP: "/ambient", KEEP: "yes" },
});

const fixture = (configured = false) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(platform === "win32" ? NodeOS.tmpdir() : "/tmp", "t3-chat-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: configured
        ? {
            codex: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "TMPDIR", value: "/custom", sensitive: false }],
              config: {},
            },
          }
        : {},
    };
    const context = yield* Layer.build(
      ChatTemp.layer.pipe(
        Layer.provide(ServerConfig.layerTest(directory, directory)),
        Layer.provide(
          Layer.succeed(Settings.ServerSettingsService, {
            getSettings: Effect.succeed(settings),
          } as unknown as Settings.ServerSettingsService["Service"]),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    const service = yield* ChatTemp.ChatTemp.pipe(Effect.provide(context));
    return { service, root: NodePath.join(directory, "userdata", "tmp"), directory };
  });

const exists = (target: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(target).then(
      () => true,
      () => false,
    ),
  );

describe("chat temp directories", () => {
  it.effect("assigns all three variables to a private, deterministic short path", () =>
    Effect.gen(function* () {
      const { service, root } = yield* fixture();
      const platform = yield* HostProcess.Platform;
      const environment = yield* service.environment(input("../../" + "x".repeat(2000)));
      expect(NodePath.dirname(environment.TMPDIR!)).toBe(root);
      expect(NodePath.basename(environment.TMPDIR!)).toMatch(/^[0-9a-f]{12}$/);
      expect(environment.TMP).toBe(environment.TMPDIR);
      expect(environment.TEMP).toBe(environment.TMPDIR);
      expect(environment.KEEP).toBe("yes");
      expect((yield* Effect.promise(() => NodeFSP.stat(environment.TMPDIR!))).mode & 0o777).toBe(
        0o700,
      );
      expect((yield* service.environment(input("../../" + "x".repeat(2000)))).TMPDIR).toBe(
        environment.TMPDIR,
      );
      // Leave room for Chromium and Playwright's socket names on macOS.
      if (platform !== "win32") {
        expect(
          Buffer.byteLength(
            NodePath.join(environment.TMPDIR!, "playwright-1234567890123456789.sock"),
          ),
        ).toBeLessThan(104);
      }
    }),
  );

  it.effect("preserves an instance's configured TMPDIR and the supplied environment", () =>
    Effect.gen(function* () {
      const { service, root } = yield* fixture(true);
      const configured = {
        ...input(),
        environment: { TMPDIR: "/custom", TMP: "/custom-tmp", TEMP: "/custom-temp" },
      };
      expect(yield* service.environment(configured)).toBe(configured.environment);
      expect(yield* exists(root)).toBe(false);
    }),
  );

  it.effect(
    "removes archived and deleted chats, but protects live leases and active runs or sessions",
    () =>
      Effect.gen(function* () {
        const { service, root } = yield* fixture();
        const scope = yield* Scope.make();
        yield* service.environment(input("live")).pipe(Effect.provideService(Scope.Scope, scope));
        const states = ["archived", "deleted", "run", "session", "live"].map((threadId) => ({
          threadId,
          active: threadId === "run" || threadId === "session",
          removed: true,
        }));
        for (const state of states)
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(root, ChatTemp.chatTempName(state.threadId)), {
              recursive: true,
            }),
          );
        yield* service.sweep(states, NOW + 4 * 86_400_000);
        for (const state of states)
          expect(yield* exists(NodePath.join(root, ChatTemp.chatTempName(state.threadId)))).toBe(
            state.active || state.threadId === "live",
          );
        yield* Scope.close(scope, Exit.void);
        yield* service.sweep(states, NOW);
        expect(yield* exists(NodePath.join(root, ChatTemp.chatTempName("live")))).toBe(false);
      }),
  );

  it.effect("walks nested modification times and expires only after three days", () =>
    Effect.gen(function* () {
      const { service, root } = yield* fixture();
      const now = NOW;
      const old = NodePath.join(root, ChatTemp.chatTempName("old"));
      const recent = NodePath.join(root, ChatTemp.chatTempName("recent"));
      const unknown = NodePath.join(root, ChatTemp.chatTempName("orphan"));
      for (const directory of [old, recent, unknown])
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(directory, "nested"), { recursive: true }),
        );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(recent, "nested", "active"), "recent"),
      );
      const future = now + 4 * 86_400_000;
      yield* Effect.promise(() =>
        NodeFSP.utimes(NodePath.join(recent, "nested", "active"), future / 1000, future / 1000),
      );
      yield* service.sweep([], now + 2 * 86_400_000);
      expect(yield* exists(old)).toBe(true);
      yield* service.sweep([], future);
      expect(yield* exists(old)).toBe(false);
      expect(yield* exists(unknown)).toBe(false);
      expect(yield* exists(recent)).toBe(true);
    }),
  );

  it.effect("does not follow symlinks or delete names outside its owned hash namespace", () =>
    Effect.gen(function* () {
      const { service, root, directory } = yield* fixture();
      yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
      const outside = NodePath.join(directory, "outside");
      yield* Effect.promise(() => NodeFSP.mkdir(outside));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outside, "keep"), "keep"));
      const symlink = NodePath.join(root, ChatTemp.chatTempName("link"));
      yield* Effect.promise(() => NodeFSP.symlink(outside, symlink));
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "unowned")));
      const owned = NodePath.join(root, ChatTemp.chatTempName("owned"));
      yield* Effect.promise(() => NodeFSP.mkdir(owned));
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(owned, "nested")));
      yield* service.sweep([], NOW + 4 * 86_400_000);
      expect(yield* exists(symlink)).toBe(true);
      expect(yield* exists(NodePath.join(outside, "keep"))).toBe(true);
      expect(yield* exists(NodePath.join(root, "unowned"))).toBe(true);
      expect(yield* exists(owned)).toBe(false);
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.symlink(outside, root));
      yield* service.sweep([], NOW + 4 * 86_400_000);
      expect(yield* exists(NodePath.join(outside, "keep"))).toBe(true);
      expect((yield* Effect.exit(service.environment(input())))._tag).toBe("Failure");
    }),
  );
});

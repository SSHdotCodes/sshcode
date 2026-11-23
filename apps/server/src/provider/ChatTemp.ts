// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";

export const chatTempName = (threadId: string) =>
  NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 12);

export interface ChatTempState {
  readonly threadId: string;
  readonly active: boolean;
  readonly removed: boolean;
}

export class ChatTemp extends Context.Service<
  ChatTemp,
  {
    readonly environment: NonNullable<ProviderHost["Service"]["prepareChatEnvironment"]>;
    readonly released: Stream.Stream<void>;
    readonly sweep: (states: ReadonlyArray<ChatTempState>, now: number) => Effect.Effect<void>;
  }
>()("t3/provider/ChatTemp") {}

const latestModification = async (directory: string): Promise<number> => {
  const info = await NodeFSP.lstat(directory);
  let latest = info.mtimeMs;
  if (!info.isDirectory() || info.isSymbolicLink()) return latest;
  for (const entry of await NodeFSP.readdir(directory)) {
    latest = Math.max(latest, await latestModification(NodePath.join(directory, entry)));
  }
  return latest;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* Settings.ServerSettingsService;
  const env = yield* HostProcess.Environment;
  // A machine can point this at RAM (/tmp), so agent scratch files never reach its SSD.
  const root = NodePath.resolve(
    env.T3CODE_CHAT_TEMP_ROOT?.trim() || NodePath.join(config.stateDir, "tmp"),
  );
  const lock = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  const revisions = new Map<string, number>();
  let nextRevision = 0;
  const released = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(released));
  const environment: ChatTemp["Service"]["environment"] = (input) =>
    Effect.gen(function* () {
      if (input.threadId === null) return input.environment;
      const configured = (yield* settings.getSettings).providerInstances[input.instanceId];
      if (configured?.environment?.some((variable) => variable.name === "TMPDIR"))
        return input.environment;
      const name = chatTempName(input.threadId);
      const directory = NodePath.join(root, name);
      yield* Effect.acquireRelease(
        lock.withPermits(1)(
          Effect.tryPromise(async () => {
            await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
            if (!(await NodeFSP.lstat(root)).isDirectory())
              throw new Error("Invalid chat temp root");
            await NodeFSP.chmod(root, 0o700);
            await NodeFSP.mkdir(directory, { mode: 0o700 }).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
              },
            );
            const info = await NodeFSP.lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new Error("Invalid chat temp directory");
            await NodeFSP.chmod(directory, 0o700);
            leases.set(name, (leases.get(name) ?? 0) + 1);
            revisions.set(name, ++nextRevision);
          }),
        ),
        () =>
          lock.withPermits(1)(
            Effect.sync(() => {
              const count = (leases.get(name) ?? 1) - 1;
              if (count === 0) leases.delete(name);
              else leases.set(name, count);
            }).pipe(Effect.andThen(PubSub.publish(released, undefined))),
          ),
      );
      return { ...input.environment, TMPDIR: directory, TMP: directory, TEMP: directory };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProtocolError({
            driver: input.driver,
            detail: "Could not prepare the chat temp directory",
            cause,
          }),
      ),
    );

  const sweep: ChatTemp["Service"]["sweep"] = (states, now) =>
    Effect.gen(function* () {
      const rootInfo = yield* Effect.tryPromise(() => NodeFSP.lstat(root)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
      const byName = new Map(states.map((state) => [chatTempName(state.threadId), state]));
      const names = yield* Effect.tryPromise(() => NodeFSP.readdir(root));
      for (const name of names) {
        if (!/^[a-f0-9]{12}$/.test(name) || leases.has(name)) continue;
        const state = byName.get(name);
        if (state?.active) continue;
        const directory = NodePath.join(root, name);
        const revision = revisions.get(name);
        yield* Effect.gen(function* () {
          const info = yield* Effect.tryPromise(() => NodeFSP.lstat(directory));
          if (!info.isDirectory() || info.isSymbolicLink()) return;
          // Walking a large inactive tree must not hold up new provider processes.
          if (
            !state?.removed &&
            now - (yield* Effect.tryPromise(() => latestModification(directory))) <
              3 * 24 * 60 * 60 * 1000
          )
            return;
          yield* lock.withPermits(1)(
            Effect.tryPromise(async () => {
              // A short-lived process may have opened and closed during the walk.
              if (leases.has(name) || revisions.get(name) !== revision) return;
              // Recheck identities after the walk. Never traverse a replaced root or chat symlink.
              const currentRoot = await NodeFSP.lstat(root);
              const current = await NodeFSP.lstat(directory);
              if (
                currentRoot.isSymbolicLink() ||
                currentRoot.ino !== rootInfo.ino ||
                currentRoot.dev !== rootInfo.dev ||
                current.ino !== info.ino ||
                current.dev !== info.dev ||
                current.isSymbolicLink()
              )
                return;
              await NodeFSP.rm(directory, { recursive: true, force: true });
              revisions.delete(name);
            }),
          );
        }).pipe(Effect.catch(() => Effect.logWarning("Could not remove a chat temp directory")));
      }
    }).pipe(Effect.catch(() => Effect.logWarning("Could not sweep chat temp directories")));
  return ChatTemp.of({ environment, sweep, released: Stream.fromPubSub(released) });
});

export const layer = Layer.effect(ChatTemp, make);

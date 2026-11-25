// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off - Standalone loopback client with printable check failures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient } from "effect/http";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "../../packages/client-runtime/src/authorization/remote.ts";
import { appendOrchestrationProtocol } from "../../packages/client-runtime/src/connection/compatibility.ts";
import { BearerConnectionTarget } from "../../packages/client-runtime/src/connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../packages/client-runtime/src/environment/descriptor.ts";
import { make as makeRpcSession } from "../../packages/client-runtime/src/rpc/session.ts";
import { CheckFailure, ProcessTree, until } from "./processes.mts";

async function unusedPort(): Promise<number> {
  const listener = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!address || typeof address === "string") throw new CheckFailure("No loopback port available");
  return address.port;
}

export async function openServer(input: {
  root: string;
  base: string;
  workspace: string;
  port?: number;
  signal: AbortSignal;
}) {
  const { root, base, workspace, signal } = input;
  const port = input.port ?? (await unusedPort());
  const origin = `http://127.0.0.1:${port}`;
  const bootstrap = NodeCrypto.randomUUID();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(T3CODE_|SSHCODE_|VITE_|OTEL_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name),
    ),
  );
  Object.assign(env, {
    TMPDIR: "/private/tmp",
    T3CODE_DEV_AUTH_TOKEN: bootstrap,
    // The check creates its own project through the client RPC.
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_LOG_LEVEL: "Debug",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    DISABLE_AUTOUPDATER: "1",
    GROK_DISABLE_AUTOUPDATER: "1",
    MUSE_NO_AUTO_UPDATE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      "start",
      "--base-dir",
      base,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--mode",
      "web",
      "--dev-url",
      origin,
      "--no-browser",
      workspace,
    ],
    {
      cwd: NodePath.join(root, "apps/server"),
      env,
      detached: true,
      // Bootstrap and provider logs stay out of the report and terminal.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let launchError = false;
  let bootStage = "launching";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      const data = chunk.toString();
      const phases = [...data.matchAll(/startup phase: ([a-z ]+?)(?:[\r\n"]|$)/g)];
      const phase = phases.at(-1)?.[1]?.trim();
      if (phase) bootStage = phase;
      else if (data.includes("Accepting commands")) bootStage = "accepting commands";
    });
  }
  child.on("error", () => {
    launchError = true;
  });
  const tree = child.pid === undefined ? undefined : new ProcessTree(child.pid);
  const scope = Effect.runSync(Scope.make());
  const close = async () => {
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      await tree?.stop(child);
    }
  };
  try {
    await until(
      async () => {
        if (launchError || child.exitCode !== null || child.signalCode !== null) {
          throw new CheckFailure(
            `Isolated server exited (code ${child.exitCode ?? child.signalCode ?? "spawn failed"})`,
          );
        }
        const runtime = await NodeFSP.readFile(
          NodePath.join(base, "userdata", "server-runtime.json"),
          "utf8",
        )
          .then(JSON.parse)
          .catch(() => undefined);
        return runtime?.pid === child.pid && runtime?.port === port ? true : undefined;
      },
      600_000,
      "Isolated server did not become ready",
      signal,
    ).catch((error) => {
      if (
        error instanceof CheckFailure &&
        error.message === "Isolated server did not become ready"
      ) {
        throw new CheckFailure(`Isolated server did not become ready (${bootStage})`);
      }
      throw error;
    });
    const client = await Effect.runPromise(
      Effect.gen(function* () {
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: origin,
          timeoutMs: 30_000,
        });
        const bearer = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: origin,
          credential: bootstrap,
          timeoutMs: 30_000,
        });
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          httpBaseUrl: origin,
          wsBaseUrl: `ws://127.0.0.1:${port}`,
          bearerToken: bearer.access_token,
          timeoutMs: 30_000,
        });
        const sessionFactory = yield* makeRpcSession({});
        const label = "Harness check";
        const session = yield* sessionFactory.connect({
          environmentId: descriptor.environmentId,
          label,
          httpBaseUrl: origin,
          socketUrl: appendOrchestrationProtocol(socketUrl),
          httpAuthorization: null,
          target: new BearerConnectionTarget({
            environmentId: descriptor.environmentId,
            label,
            connectionId: "harness-check",
          }),
        });
        yield* session.ready.pipe(Effect.timeout(45_000));
        return session.client;
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Layer.merge(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
        Effect.mapError(
          (cause) => new CheckFailure(`Could not prepare isolated client (${cause._tag})`),
        ),
      ),
      { signal },
    );
    return { client, port, close, owns: async (pid: number) => (await tree?.owns(pid)) === true };
  } catch (error) {
    await close();
    throw error;
  }
}

export type CheckServer = Awaited<ReturnType<typeof openServer>>;

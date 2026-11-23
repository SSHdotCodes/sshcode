// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off preferSchemaOverJson:off - OS boundary for disposable checkout processes, never the live server's environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
export const MARKER = "T3CODE_QA_SANDBOX";
const decodePairing = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }));

export interface SandboxFiles {
  readonly id: string;
  readonly directory: string;
  readonly repositoryPath: string;
  readonly serverPort: number;
  readonly webPort: number;
  readonly logPath: string;
}

export class QaSandboxHostError extends Schema.TaggedError<QaSandboxHostError>()(
  "QaSandboxHostError",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `QA sandbox ${this.stage} failed.`;
  }
}

const attempt = <A>(stage: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new QaSandboxHostError({ stage, cause }),
  });

export class QaSandboxHost extends Context.Service<
  QaSandboxHost,
  {
    readonly prepare: (
      id: string,
      repositoryPath: string,
    ) => Effect.Effect<SandboxFiles, QaSandboxHostError>;
    readonly launch: (files: SandboxFiles) => Effect.Effect<void, QaSandboxHostError>;
    readonly ready: (files: SandboxFiles) => Effect.Effect<void, QaSandboxHostError>;
    readonly pair: (files: SandboxFiles) => Effect.Effect<string, QaSandboxHostError>;
    readonly seed: (files: SandboxFiles) => Effect.Effect<void, QaSandboxHostError>;
    readonly dispose: (
      files: SandboxFiles,
      keepLog: boolean,
    ) => Effect.Effect<void, QaSandboxHostError>;
  }
>()("t3/preview/QaSandboxHost") {}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });

/** Match an entire environment entry, never a worktree/name substring. */
export function markedProcessIds(rows: string, id: string): Array<number> {
  const marker = `${MARKER}=${id}`;
  return rows.split("\n").flatMap((row) => {
    const pid = Number(row.trimStart().split(/\s/, 1)[0]);
    return Number.isInteger(pid) && pid > 0 && row.split(/\s+/).includes(marker) ? [pid] : [];
  });
}

const markedProcesses = async (id: string, platform: NodeJS.Platform) => {
  if (platform === "linux") {
    const entries = await NodeFSP.readdir("/proc");
    const matches = await Promise.all(
      entries
        .filter((pid) => /^\d+$/.test(pid))
        .map(async (pid) => {
          const env = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
          return env.split("\0").includes(`${MARKER}=${id}`) ? Number(pid) : null;
        }),
    );
    return matches.filter((pid): pid is number => pid !== null);
  }
  const scan = execFile("/bin/ps", ["eww", "-axo", "pid=,command="], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const { stdout } = await scan;
  // A guardian's scan inherits the marker too; the completed ps is not a survivor.
  return markedProcessIds(stdout, id).filter((pid) => pid !== scan.child.pid);
};

export function sandboxNetworkSource(serverPort: number, webPort: number): string {
  return `
import net from 'node:net';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = typeof options === 'object' ? Number(options.port) : Number(options);
  const host = typeof options === 'object' ? options.host : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!['127.0.0.1', 'localhost', '::1', undefined].includes(host) || ![${serverPort}, ${webPort}].includes(port)) {
    queueMicrotask(() => this.destroy(Object.assign(new Error('QA sandbox blocked a connection outside its ports'), { code: 'EACCES' })));
    return this;
  }
  return connect.apply(this, args);
};
`;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Freeze supervisors before killing descendants; injected OS operations make races testable. */
export async function stopSandboxProcesses(operations: {
  list: () => Promise<Array<number>>;
  signal: (pid: number, signal: "SIGSTOP" | "SIGKILL") => void;
  settle: () => Promise<void>;
  assertPortsFree: () => Promise<void>;
}): Promise<void> {
  for (let pass = 0; pass < 30; pass++) {
    const pids = await operations.list();
    if (pids.length === 0) break;
    for (const pid of pids) operations.signal(pid, "SIGSTOP");
    for (const pid of await operations.list()) operations.signal(pid, "SIGKILL");
    await operations.settle();
  }
  if ((await operations.list()).length > 0) throw new Error("Marked processes survived cleanup.");
  // A killed process leaves the list before the kernel has closed its sockets, so a port
  // can stay taken for a moment: give it two seconds before calling the stop failed.
  for (let attempt = 0; ; attempt++) {
    try {
      await operations.assertPortsFree();
      return;
    } catch (error) {
      if (attempt >= 40) throw error;
      await operations.settle();
    }
  }
}

// Do not inherit credentials, provider homes, bootstrap tokens, dev origins or NODE_OPTIONS.
const environment = (files: SandboxFiles): NodeJS.ProcessEnv => ({
  PATH: `${NodePath.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
  HOME: NodePath.join(files.directory, "home"),
  TMPDIR: files.directory,
  LANG: "en_US.UTF-8",
  [MARKER]: files.id,
  T3CODE_QA_OWNER_PID: String(process.pid),
  ELECTRON_RUN_AS_NODE: "1",
  T3CODE_QA_FIXTURE: "1",
  T3CODE_SINGLE_ORIGIN_DEV: "1",
  T3CODE_BUNDLED_DEV: "1",
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_PORT: String(files.serverPort),
  PORT: String(files.webPort),
  HOST: "127.0.0.1",
  NODE_OPTIONS: `--import=${NodePath.join(files.directory, "network.mjs")}`,
  NODE_COMPILE_CACHE: NodePath.join(files.repositoryPath, "node_modules/.cache/t3-qa-node"),
});

const runCli = (files: SandboxFiles, args: Array<string>) =>
  execFile(process.execPath, ["src/bin.ts", ...args], {
    cwd: NodePath.join(files.repositoryPath, "apps/server"),
    env: environment(files),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

export const layer = Layer.effect(
  QaSandboxHost,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    return QaSandboxHost.of({
      prepare: (id, repositoryPath) =>
        attempt("prepare", async () => {
          if (platform === "win32") throw new Error("QA sandbox requires a POSIX host.");
          const root = await NodeFSP.realpath(repositoryPath);
          for (const file of [
            "apps/server/src/bin.ts",
            "apps/server/scripts/acp-mock-agent.ts",
            "node_modules/.bin/vp",
          ]) {
            await NodeFSP.access(NodePath.join(root, file));
          }
          const directory = `/private/tmp/t3-qa-${id}`;
          const logPath = `${directory}.log`;
          await NodeFSP.mkdir(NodePath.join(directory, "home"), { recursive: true, mode: 0o700 });
          const serverPort = await freePort();
          let webPort = await freePort();
          while (webPort === serverPort) webPort = await freePort();
          const files = { id, directory, repositoryPath: root, serverPort, webPort, logPath };
          await NodeFSP.mkdir(NodePath.join(directory, "base/userdata"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(directory, "project"));
          const disabled = Object.fromEntries(
            ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi", "muse"].map(
              (driver) => [driver, { driver, enabled: false, config: { enabled: false } }],
            ),
          );
          await NodeFSP.writeFile(
            NodePath.join(directory, "base/userdata/settings.json"),
            JSON.stringify({
              enableProviderUpdateChecks: false,
              enableDeviceSupport: false,
              backgroundActivity: {
                profile: "custom",
                overrides: { automaticGitFetchInterval: 0, providerHealthRefreshInterval: 0 },
              },
              defaultModelSelection: { instanceId: "acpRegistry_qa", model: "qa-balanced" },
              providerInstances: {
                ...disabled,
                acpRegistry_qa: {
                  driver: "acpRegistry",
                  displayName: "QA Fixture",
                  enabled: true,
                  config: {
                    source: "local",
                    commandPath: process.execPath,
                    commandArgs: [NodePath.join(root, "apps/server/scripts/acp-mock-agent.ts")],
                  },
                },
              },
            }),
          );
          // Applied to every Node descendant, including fetch/undici through net.Socket.
          // No seeded remote endpoints, and even accidental connections cannot reach other ports.
          await NodeFSP.writeFile(
            NodePath.join(directory, "network.mjs"),
            sandboxNetworkSource(serverPort, webPort),
          );
          await NodeFSP.writeFile(
            NodePath.join(directory, "watch.mjs"),
            `
import * as Effect from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "apps/server/node_modules/effect/dist/Effect.js")).href)};
import * as Host from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "apps/server/src/preview/QaSandboxHost.ts")).href)};
const owner = Number(process.env.T3CODE_QA_OWNER_PID);
let stopping = false;
setInterval(async () => {
  if (stopping) return;
  try { process.kill(owner, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
  stopping = true;
  await Effect.runPromise(Host.QaSandboxHost.pipe(
    Effect.flatMap(host => host.dispose(${JSON.stringify(files)}, false)),
    Effect.provide(Host.layer),
  ));
  process.exit(0);
}, 5000);
`,
          );
          return files;
        }).pipe(
          Effect.onError(() =>
            attempt("prepare cleanup", () =>
              NodeFSP.rm(`/private/tmp/t3-qa-${id}`, { recursive: true, force: true }),
            ).pipe(Effect.ignore),
          ),
        ),
      launch: (files) =>
        attempt("launch", async () => {
          const log = await NodeFSP.open(files.logPath, "a", 0o600);
          try {
            for (const [cwd, executable, args] of [
              [
                "apps/web",
                NodePath.join(files.repositoryPath, "node_modules/.bin/vp"),
                ["dev", "--strictPort"],
              ],
              [
                "apps/server",
                process.execPath,
                [
                  "src/bin.ts",
                  "--base-dir",
                  NodePath.join(files.directory, "base"),
                  "--host",
                  "127.0.0.1",
                  "--port",
                  String(files.serverPort),
                  "--no-browser",
                  "--dev-url",
                  `http://127.0.0.1:${files.webPort}`,
                ],
              ],
              ["apps/server", process.execPath, [NodePath.join(files.directory, "watch.mjs")]],
            ] as const) {
              const child = NodeChildProcess.spawn(executable, [...args], {
                cwd: NodePath.join(files.repositoryPath, cwd),
                env: environment(files),
                detached: true,
                stdio: ["ignore", log.fd, log.fd],
              });
              await new Promise<void>((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
              });
              child.unref();
            }
          } finally {
            await log.close();
          }
        }),
      ready: (files) =>
        attempt("readiness", async () => {
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            try {
              const [web, server] = await Promise.all([
                fetch(`http://127.0.0.1:${files.webPort}/@vite/client`, {
                  signal: AbortSignal.timeout(5000),
                }),
                fetch(`http://127.0.0.1:${files.serverPort}/api/auth/session`, {
                  signal: AbortSignal.timeout(5000),
                  redirect: "manual",
                }),
              ]);
              if (web.ok && server.status < 500) return;
            } catch {
              /* Retry only readiness, never launch or browser actions. */
            }
            await wait(100);
          }
          throw new Error("Readiness deadline exceeded.");
        }),
      pair: (files) =>
        attempt("pairing", async () => {
          const result = await runCli(files, [
            "auth",
            "pairing",
            "create",
            "--base-dir",
            NodePath.join(files.directory, "base"),
            "--ttl",
            "30m",
            "--json",
          ]);
          const credential = decodePairing(JSON.parse(result.stdout)).credential;
          return `http://127.0.0.1:${files.serverPort}/#token=${encodeURIComponent(credential)}`;
        }),
      seed: (files) =>
        attempt("seed", async () => {
          const result = await execFile(
            process.execPath,
            ["scripts/qa-seed.ts", files.directory, String(files.serverPort)],
            {
              cwd: NodePath.join(files.repositoryPath, "apps/server"),
              env: environment(files),
              timeout: 30_000,
            },
          );
          await NodeFSP.appendFile(files.logPath, result.stderr);
        }),
      dispose: (files, keepLog) =>
        attempt("cleanup", async () => {
          await stopSandboxProcesses({
            list: async () =>
              (await markedProcesses(files.id, platform)).filter((pid) => pid !== process.pid),
            signal: (pid, signal) => {
              try {
                process.kill(pid, signal);
              } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                  throw error;
              }
            },
            settle: () => wait(50),
            assertPortsFree: async () => {
              for (const port of [files.serverPort, files.webPort]) {
                await new Promise<void>((resolve, reject) => {
                  const server = NodeNet.createServer();
                  server.once("error", reject);
                  server.listen(port, "127.0.0.1", () =>
                    server.close((error) => (error ? reject(error) : resolve())),
                  );
                });
              }
            },
          });
          await NodeFSP.rm(files.directory, { recursive: true, force: true });
          if (!keepLog) await NodeFSP.rm(files.logPath, { force: true });
        }),
    });
  }),
);

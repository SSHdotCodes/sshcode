// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK's spawn hook returns a Node child process.
import * as NodeChildProcess from "node:child_process";

import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerProviderResetCredits,
} from "@t3tools/contracts";
import { applyNativeModelDefaults, type NativeModelDefaults } from "./nativeModelDefaults.ts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { envTrampoline, supportsEnvChdir } from "@t3tools/shared/envTrampoline";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
  type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  CLAUDE_BTW_SLASH_COMMAND,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { hasClaudeManagedMcpConfig, makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { discoverClaudeSkills, resolveClaudeConfigDirPath } from "./Drivers/ClaudeSkills.ts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  parseClaudeReportedModels,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
  withClaudeReportedModels,
  type ClaudeReportedModel,
} from "./ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/**
 * Whether the SDK's account payload evidences a credential the CLI can use.
 *
 * The capability probe resolves for a logged-out CLI, so a completed probe only
 * proves Claude Code started. `tokenSource: "none"` is the CLI reporting it
 * found no token at all, and is the one shape that disproves authentication.
 * Everything else either names a credential or, on a third-party backend, omits
 * these fields by design because auth lives with AWS or gcloud instead.
 *
 * Silence is deliberately not disproof. Profile-authenticated installs report no
 * token source, and a CLI too old to send an account payload reports nothing at
 * all; treating either as logged out would sign working setups out of Settings.
 * `apiKeySource: "none"` means no API key is in use, so it is no evidence either.
 */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // An `ANTHROPIC_API_KEY` install reports no token source but is authenticated
  // all the same, so the key and account fields still get a say.
  const hasApiKey = Boolean(capabilities.apiKeySource) && capabilities.apiKeySource !== "none";
  return hasApiKey || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
// Claude Code fetches usage from Anthropic during the probe. Measured 11-25: the answer often
// takes over 4 s on a busy Mac, and every miss greyed both Claude limit rings.
export const CLAUDE_USAGE_TIMEOUT_MS = 15_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * The SDK's own spawn hands libuv the workspace as cwd and the PATH search, so a mount that
 * stops answering freezes the server. `env` enters the cwd and finds the CLI in the child.
 * A shell would not do: dash drops the exported Bash functions a launcher may call.
 */
export function spawnClaudeProbeThroughEnv({
  command,
  args,
  cwd,
  env,
  signal,
}: ClaudeSpawnOptions) {
  const launch = envTrampoline(command, args, cwd) ?? { command, args, cwd };
  return NodeChildProcess.spawn(launch.command, launch.args, {
    ...("cwd" in launch ? { cwd: launch.cwd } : {}),
    env,
    signal,
    // The probe ignores stderr.
    stdio: ["pipe", "pipe", "ignore"],
  });
}

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  /** An administrator's `managed-mcp.json` is installed; see `hasClaudeManagedMcpConfig`. */
  readonly managedMcpConfig: boolean;
  /** `/usr/bin/env -C` works here; see `supportsEnvChdir`. */
  readonly spawnThroughEnv: boolean;
}): ClaudeQueryOptions {
  return {
    ...(input.spawnThroughEnv ? { spawnClaudeCodeProcess: spawnClaudeProbeThroughEnv } : {}),
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config, which
    // Claude refuses next to a managed-mcp.json that already excludes them.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  /**
   * The organization UUID from the login's `.claude.json`. The driver reads it
   * in the same cached probe, so it describes the same login as the rest.
   */
  readonly workspaceId?: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /** Where the CLI found an API key, when it authenticates with one. */
  readonly apiKeySource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /** The models this CLI offers; the manifest may not list the newest yet. */
  readonly reportedModels?: ReadonlyArray<ClaudeReportedModel>;
  /**
   * Subscription windows from the SDK's `get_usage` control request, or
   * `undefined` when the request itself failed. Absent windows on an
   * otherwise successful response mean the account has none (API key).
   */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly usageCheckedAt?: string;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

/**
 * How long a probe's Claude process may take to exit once its input ends. Claude Code's
 * teardown waits up to 30 s for requests still in flight, then up to 2 s for a login
 * renewal it holds, so a process still running after this is stuck.
 */
const PROBE_EXIT_GRACE_MS = 60_000;
/** An abort makes the SDK send SIGTERM after 2 s and SIGKILL 5 s later. */
const PROBE_STOP_MS = 10_000;

/**
 * One probe per Claude config folder at a time, its process's exit included. Whichever
 * Claude process finds the folder's login expired renews it, so two probes on one folder
 * would race to renew the same login.
 */
const probeLocks = new Map<string, Semaphore.Semaphore>();
function probeLock(configDir: string): Semaphore.Semaphore {
  let lock = probeLocks.get(configDir);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    probeLocks.set(configDir, lock);
  }
  return lock;
}

interface ClaudeProbeSession {
  readonly query: ReturnType<typeof claudeQuery>;
  readonly endInput: () => void;
  readonly abort: AbortController;
}

/**
 * Starts a Claude process whose input yields nothing, so it initializes, answers control
 * requests, and never sends a prompt to the Anthropic API.
 */
function startClaudeProbe(
  options: Omit<Parameters<typeof buildClaudeCapabilitiesProbeQueryOptions>[0], "abortController">,
): ClaudeProbeSession {
  const abort = new AbortController();
  let endInput!: () => void;
  const inputEnded = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  const query = claudeQuery({
    // oxlint-disable-next-line require-yield -- no message is ever sent; ending it closes stdin.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await inputEnded;
    })(),
    options: buildClaudeCapabilitiesProbeQueryOptions({ ...options, abortController: abort }),
  });
  return { query, endInput, abort };
}

/** Settles once the probe's process has exited. */
async function claudeProbeExited(query: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _message of query);
  } catch {
    // An exit error or an abort ends the stream as well.
  }
}

/**
 * Waits for a probe whose input has closed to exit by itself, the way Claude Code expects:
 * it finishes what it started first, a login renewal included. A process killed
 * mid-renewal can leave a login that was renewed at Anthropic but never saved, which signs
 * it out. Only a process still running after the grace period is stopped.
 */
const awaitClaudeProbeExit = (session: ClaudeProbeSession) =>
  Effect.gen(function* () {
    const exited = claudeProbeExited(session.query);
    const finished = yield* Effect.promise(() => exited).pipe(
      Effect.timeoutOption(PROBE_EXIT_GRACE_MS),
    );
    if (Option.isSome(finished)) return;
    yield* Effect.logWarning(
      "A Claude probe was still running a minute after its input ended; stopping it.",
    );
    session.abort.abort();
    yield* Effect.promise(() => exited).pipe(Effect.timeoutOption(PROBE_STOP_MS));
  });

/**
 * Runs a probe under its config folder's lock and returns once it has read what it needs,
 * failed, or been interrupted. Its input then closes, and a background fiber holds the lock
 * until the process has exited, so the next probe on that folder starts only after that.
 */
const runClaudeProbe = (
  options: Parameters<typeof startClaudeProbe>[0],
  lock: Semaphore.Semaphore,
  includeUsage: boolean,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(lock.take(1));
      const started = yield* Effect.exit(Effect.try(() => startClaudeProbe(options)));
      if (Exit.isFailure(started)) {
        yield* lock.release(1);
        return yield* Effect.failCause(started.cause);
      }
      const session = started.value;
      const read = yield* Effect.exit(restore(readClaudeProbe(session.query, includeUsage)));
      session.endInput();
      yield* awaitClaudeProbeExit(session).pipe(
        Effect.ensuring(lock.release(1)),
        Effect.forkDetach({ uninterruptible: true }),
      );
      return yield* read;
    }),
  );

/** Reads initialization and, if asked, usage from a running probe. */
const readClaudeProbe = (query: ClaudeProbeSession["query"], includeUsage: boolean) =>
  Effect.tryPromise(() => query.initializationResult()).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap((init) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const usageResult = includeUsage
          ? yield* Effect.tryPromise(() =>
              query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                skipBehaviors: true,
              }),
            ).pipe(
              Effect.timeout(CLAUDE_USAGE_TIMEOUT_MS),
              Effect.mapError((error) =>
                error._tag === "TimeoutError" ? "Timeout" : "ReadFailed",
              ),
              Effect.withSpan("ClaudeProvider.readUsage"),
              Effect.result,
            )
          : undefined;
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          reportedModels: parseClaudeReportedModels(init.models),
          ...(usage ? { usage, usageCheckedAt } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }),
    ),
  );

/**
 * Probe account information, commands and usage with a lightweight Claude Agent SDK
 * session that never sends a prompt. A probe that has not answered within its deadline
 * still ends gracefully; see `runClaudeProbe`.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeUsage = true,
) =>
  Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const options = {
      executablePath: yield* resolveClaudeSdkExecutablePath(
        claudeSettings.binaryPath,
        claudeEnvironment,
      ),
      environment: claudeEnvironment,
      cwd,
      managedMcpConfig: yield* hasClaudeManagedMcpConfig(),
      spawnThroughEnv:
        (yield* HostProcess.Platform) !== "win32" && (yield* Effect.promise(supportsEnvChdir)),
    };
    const configDir = yield* resolveClaudeConfigDirPath(claudeSettings, claudeEnvironment, cwd);
    return { options, configDir };
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap(({ options, configDir }) =>
      runClaudeProbe(options, probeLock(configDir), includeUsage),
    ),
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

/** `claude --version`, which is also the check that the CLI is installed and runs. */
const probeClaudeVersion = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  runClaudeCommand(claudeSettings, ["--version"], environment, cwd).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

type ClaudeVersionProbe = Effect.Success<ReturnType<typeof probeClaudeVersion>>;
export type ClaudeVersionReader = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => Effect.Effect<
  ClaudeVersionProbe,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
>;

// Mach-O (either byte order, 32 or 64 bit, universal), ELF, and PE.
const NATIVE_EXECUTABLE_MAGIC = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
];

/**
 * Real path, modification time and size of the native executable `binaryPath` starts, or
 * none. A script is never stamped: it can start another Claude after an update without
 * changing itself.
 */
const claudeExecutableStamp = Effect.fn("claudeExecutableStamp")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(binaryPath, yield* HostProcess.Platform, environment);
  if (resolved === undefined) return Option.none<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const realPath = yield* fileSystem.realPath(resolved);
    const info = yield* fileSystem.stat(realPath);
    const head = yield* fileSystem.open(realPath).pipe(
      Effect.flatMap((file) => file.readAlloc(4)),
      Effect.scoped,
    );
    const bytes = Option.getOrElse(head, () => new Uint8Array());
    const native = NATIVE_EXECUTABLE_MAGIC.some((magic) =>
      magic.every((byte, index) => bytes[index] === byte),
    );
    if (!native || Option.isNone(info.mtime)) return Option.none<string>();
    return Option.some(`${realPath}\0${info.mtime.value.getTime()}\0${info.size}`);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});

/**
 * `claude --version` for one instance, reused while it would run the same native
 * executable: same real path, modification time and size. Claude's updates move the
 * link or rewrite the file, so they run it again, and so do scripts, executables that
 * cannot be read, and a run that failed.
 */
export const makeClaudeVersionReader = Effect.fn("makeClaudeVersionReader")(function* () {
  const last = yield* Ref.make<
    { readonly stamp: string; readonly probe: ClaudeVersionProbe } | undefined
  >(undefined);
  return Effect.fn("readClaudeVersion")(function* (
    claudeSettings: ClaudeSettings,
    environment: NodeJS.ProcessEnv,
    cwd?: string,
  ) {
    const stamp = yield* claudeExecutableStamp(claudeSettings.binaryPath, environment);
    const previous = yield* Ref.get(last);
    if (Option.isSome(stamp) && previous?.stamp === stamp.value) return previous.probe;
    const probe = yield* probeClaudeVersion(claudeSettings, environment, cwd);
    const ranCleanly =
      Result.isSuccess(probe) && Option.isSome(probe.success) && probe.success.value.code === 0;
    yield* Ref.set(
      last,
      Option.isSome(stamp) && ranCleanly ? { stamp: stamp.value, probe } : undefined,
    );
    return probe;
  });
});

/** How long a workspace's command list is reused. Restart agent session rescans it sooner. */
const WORKSPACE_COMMANDS_TTL = Duration.minutes(30);
const WORKSPACE_COMMANDS_CAPACITY = 64;

/**
 * Workspace snapshots for one Claude instance, read from the cwd Claude uses for a
 * workspace session. Listing commands takes a Claude process, so a workspace's list is
 * reused for half an hour; skills are read from disk every time.
 */
export const makeClaudeWorkspaceSnapshots = Effect.fn("makeClaudeWorkspaceSnapshots")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commands = yield* Cache.makeWith(
    (cwd: string) =>
      probeClaudeCapabilities(claudeSettings, environment, cwd, false).pipe(
        Effect.map((capabilities) => capabilities?.slashCommands),
      ),
    {
      capacity: WORKSPACE_COMMANDS_CAPACITY,
      // A scan that failed is retried on the next request.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== undefined ? WORKSPACE_COMMANDS_TTL : Duration.zero,
    },
  );
  const snapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
    machineSnapshot: ServerProvider,
    cwd: string,
  ): Effect.fn.Return<ProviderWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> {
    if (!claudeSettings.enabled) return machineSnapshot;
    const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
    const slashCommands = yield* Cache.get(commands, cwd);
    return {
      ...machineSnapshot,
      skills,
      slashCommands: dedupeSlashCommands([
        COMPACT_SLASH_COMMAND,
        CLAUDE_BTW_SLASH_COMMAND,
        ...(slashCommands ?? []),
      ]),
      slashCommandsPending: slashCommands === undefined,
    };
  });
  return { snapshot, invalidate: Cache.invalidateAll(commands) };
});

const ClaudeUserSettings = Schema.Struct({
  model: Schema.optional(Schema.String),
  effortLevel: Schema.optional(Schema.String),
});
const decodeClaudeUserSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeUserSettings),
);

/** `model` and `effortLevel` from Claude Code's user settings, as a new `claude` session uses them. */
const readClaudeNativeModelDefaults = Effect.fn("readClaudeNativeModelDefaults")(function* (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<NativeModelDefaults, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeConfigDirPath(claudeSettings, environment);
  const settings = yield* fileSystem.readFileString(path.join(configDir, "settings.json")).pipe(
    Effect.map(decodeClaudeUserSettings),
    Effect.orElseSucceed(() => Option.none()),
  );
  return Option.match(settings, {
    onNone: () => ({}),
    onSome: (value) => ({ model: value.model, options: { effort: value.effortLevel } }),
  });
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  /** Banked resets for a subscription login, given the CLI version for the user agent. */
  resolveResetCredits?: (version: string) => Effect.Effect<ServerProviderResetCredits | undefined>,
  /** See `makeClaudeVersionReader`. */
  readVersion: ClaudeVersionReader = probeClaudeVersion,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // New threads start on the model and effort Claude Code is configured with.
  const nativeDefaults = yield* readClaudeNativeModelDefaults(claudeSettings, resolvedEnvironment);
  const allModels = applyNativeModelDefaults(
    providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    ),
    nativeDefaults,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in SSHCode settings.",
      },
    });
  }

  const versionProbe = yield* readVersion(claudeSettings, resolvedEnvironment, cwd);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        refreshing: true,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const modelsOffering = (reported: ReadonlyArray<ClaudeReportedModel>) =>
    applyNativeModelDefaults(
      providerModelsFromSettings(
        withClaudeReportedModels(
          resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
          modelCatalog,
          reported,
        ),
        claudeSettings.customModels,
        DEFAULT_CLAUDE_MODEL_CAPABILITIES,
      ),
      nativeDefaults,
    );
  const updateRequiredModels = resolveClaudeUpdateRequiredModels(modelCatalog, parsedVersion);
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [
    COMPACT_SLASH_COMMAND,
    CLAUDE_BTW_SLASH_COMMAND,
    ...(capabilities?.slashCommands ?? []),
  ];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: modelsOffering([]),
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        refreshing: true,
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const models = modelsOffering(capabilities.reportedModels ?? []);
  if (claudeAuthStatus(capabilities) === "unauthenticated") {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        })
      : claudeUsageResponseToLimits({ response: capabilities.usage, checkedAt: usageCheckedAt })
          .limits;
  const resetCredits =
    resolveResetCredits &&
    capabilities.subscriptionType &&
    !usageLimits.unavailable &&
    parsedVersion
      ? yield* resolveResetCredits(parsedVersion)
      : undefined;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(capabilities.workspaceId ? { workspaceId: capabilities.workspaceId } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      // An API key or Bedrock has no plan limits to read (an instance pointed at local models
      // runs on a key): leave limits out rather than report a probe that can never succeed.
      ...(authMetadata?.type === "apiKey" || authMetadata?.type === "bedrock"
        ? {}
        : { usageLimits: resetCredits ? { ...usageLimits, resetCredits } : usageLimits }),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in SSHCode settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * The status check runs on the regular login, the credential new processes
 * prefer (ClaudeLogin.ts). Without a working regular login, a saved fallback
 * token still counts as signed in. Such a token cannot read usage, so the
 * limits stay hidden until the login works again.
 */
const probeClaudeCapabilitiesWithFallbackToken = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  fallbackToken: string | undefined,
  cwd?: string,
) =>
  probeClaudeCapabilities(claudeSettings, environment, cwd).pipe(
    Effect.flatMap((capabilities) =>
      fallbackToken === undefined ||
      (capabilities !== undefined && claudeAuthStatus(capabilities) === "authenticated")
        ? Effect.succeed<ClaudeCapabilitiesProbe | undefined>(capabilities)
        : probeClaudeCapabilities(
            claudeSettings,
            { ...environment, CLAUDE_CODE_OAUTH_TOKEN: fallbackToken },
            cwd,
          ).pipe(Effect.map((withToken) => withToken ?? capabilities)),
    ),
  );

/**
 * The status check of an instance that always runs on its saved token. The
 * stored login and `.claude.json` describe this computer's account, not the
 * token's, so the probe runs on the token and names no account. Two instances
 * on one Claude folder then read as the two accounts they are.
 */
const probeClaudeCapabilitiesWithToken = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  token: string,
  cwd?: string,
) =>
  probeClaudeCapabilities(
    claudeSettings,
    { ...environment, CLAUDE_CODE_OAUTH_TOKEN: token },
    cwd,
  ).pipe(Effect.map(withoutLoginIdentity));

/** Drops what a probe read about the stored login's account. */
export function withoutLoginIdentity(
  capabilities: ClaudeCapabilitiesProbe | undefined,
): ClaudeCapabilitiesProbe | undefined {
  return capabilities === undefined
    ? undefined
    : { ...capabilities, email: undefined, workspaceId: undefined };
}

export {
  probeClaudeCapabilities,
  probeClaudeCapabilitiesWithFallbackToken,
  probeClaudeCapabilitiesWithToken,
};

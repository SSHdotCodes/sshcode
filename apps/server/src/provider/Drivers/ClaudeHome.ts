import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Whether an administrator installed Claude Code's `managed-mcp.json`. While it
 * exists Claude refuses `--strict-mcp-config` and exits before initializing,
 * but it already ignores user, project and `--mcp-config` servers on its own,
 * so callers that pass the flag for isolation can drop it. Paths match the
 * ones Claude Code checks.
 */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

/**
 * What a linked Claude folder takes from the main one: the chats and all the
 * user wrote or installed. Its login, `.claude.json` and per-account caches
 * stay its own, so two subscriptions never mix their identities.
 */
export const CLAUDE_SHARED_ENTRIES = [
  "projects",
  "file-history",
  "session-env",
  "shell-snapshots",
  "paste-cache",
  "todos",
  "tasks",
  "plans",
  "history.jsonl",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "keybindings.json",
  "statusline.sh",
  "skills",
  "agents",
  "commands",
  "rules",
  "output-styles",
  "plugins",
  "hooks",
  "themes",
] as const;

/**
 * "Share chats with the main Claude folder": make the instance's own folder
 * and link each shared entry the main folder has. Claude Code keeps one full
 * login per folder, so this is how a second subscription signs in fully
 * (usage limits, connectors) and still continues the first one's chats.
 * Runs at every start, so entries the main folder gains later get linked too;
 * anything already in the folder is left as it is.
 */
export const linkClaudeHomeToMain = Effect.fn("linkClaudeHomeToMain")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shareMainFolder">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  if (!config.shareMainFolder || config.homePath.trim().length === 0) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const main = yield* resolveClaudeHomePath({ homePath: "" }, environment);
  const linked = yield* resolveClaudeHomePath(config, environment);
  if (linked === main) return;
  yield* fileSystem.makeDirectory(linked, { recursive: true }).pipe(Effect.ignore);
  for (const entry of CLAUDE_SHARED_ENTRIES) {
    const source = path.join(main, entry);
    if (!(yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false)))) continue;
    // Fails when the folder already has the entry (a link or its own): keep it.
    yield* fileSystem.symlink(source, path.join(linked, entry)).pipe(Effect.ignore);
  }
});

/**
 * The Claude folder whose chats this one uses: a folder whose `projects` is a
 * link into another Claude folder continues that folder's chats.
 */
const resolveClaudeChatsHome = Effect.fn("resolveClaudeChatsHome")(function* (
  homePath: string,
): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* fileSystem
    .readLink(path.join(homePath, "projects"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (target === undefined) return homePath;
  const projects = path.resolve(homePath, target);
  return path.basename(projects) === "projects" ? path.dirname(projects) : homePath;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${yield* resolveClaudeChatsHome(resolvedHomePath)}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * The command that signs an instance's Claude folder in again, for pasting into a
 * terminal on the machine the server runs on. `configDir` is CLAUDE_CONFIG_DIR as the
 * instance's processes see it: Claude Code files a login under that exact value, so
 * the default folder gets the bare command.
 */
export function claudeSignInCommand(
  configDir: string | undefined,
  platform: NodeJS.Platform,
): string {
  if (configDir === undefined) return "claude auth login";
  if (platform === "win32") {
    return `$env:CLAUDE_CONFIG_DIR = '${configDir.replaceAll("'", "''")}'; claude auth login`;
  }
  const word = /^[\w@%+=:,./-]+$/u.test(configDir)
    ? configDir
    : `'${configDir.replaceAll("'", `'\\''`)}'`;
  return `CLAUDE_CONFIG_DIR=${word} claude auth login`;
}

export const CLAUDE_SIGNED_OUT_PREFIX = "Claude could not authenticate.";

/** Whether a run failed because Claude's login no longer works. */
export const isClaudeSignedOutMessage = (message: string | null | undefined): boolean =>
  message?.startsWith(CLAUDE_SIGNED_OUT_PREFIX) === true;

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 * The same chat works again once the login does, so it says to send again.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `${CLAUDE_SIGNED_OUT_PREFIX} For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then send your message again. For API-key authentication, check this instance's configured credentials.`;
};

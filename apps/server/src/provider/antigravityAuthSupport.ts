// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { AntigravityAuthMethod, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityUserSkillDirectories,
  discoverAntigravitySkills,
  resolveAntigravityUserHome,
} from "./Drivers/AntigravitySkills.ts";
import { agentsSkillsDir, readLibrary } from "../sharedSkills/library.ts";

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__T3_ANTIGRAVITY_AUTH_URL__";
export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Antigravity in Settings before you continue.";

const maxAuthorizationUrlLength = 16_384;
const maxBrowserHelperLineLength =
  Math.max(ANTIGRAVITY_AUTH_BROWSER_MARKER.length, ANTIGRAVITY_AUTH_STDOUT_PREFIX.length) +
  maxAuthorizationUrlLength +
  2;
const maxStdoutLineBytes = 16 * 1024 * 1024;
const authPrefixBytes = new TextEncoder().encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const decodeBrowserHelperUrl = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));
const ProfileSettingsFile = Schema.Struct({
  auth: Schema.Struct({ type: Schema.String }),
  gcp: Schema.optional(
    Schema.Struct({
      project: Schema.optional(Schema.String),
      location: Schema.optional(Schema.String),
    }),
  ),
});
const encodeProfileSettings = Schema.encodeSync(Schema.fromJsonString(ProfileSettingsFile));
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError);

// Python splits BROWSER on the platform path separator before it parses quotes.
// Keep this source free of both colons and semicolons. EPIPE must still exit 0
// so Python does not fall back to an OS browser after cancellation.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;
const browserPreflightUrl = "https://example.invalid/t3-antigravity-browser-preflight";

const removedEnvironmentKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
]);

export interface AntigravityProfile {
  readonly platform: NodeJS.Platform;
  readonly geminiHome: string;
  readonly acpDirectory: string;
  readonly tokenPath: string;
  /** Parent of the per-process temp directories PyInstaller unpacks into. */
  readonly tempDirectory: string;
  readonly browserCommand: string;
  readonly caBundlePath?: string;
}

/**
 * Credentials for the non-personal ACP auth methods. The agent reads the API
 * key from its environment and the GCP project and location from
 * `settings.json` in the profile. Empty strings mean "not set".
 */
export interface AntigravityAuthConfig {
  readonly authMethod: AntigravityAuthMethod;
  readonly apiKey: string;
  readonly gcpProject: string;
  readonly gcpLocation: string;
}

export const ANTIGRAVITY_PERSONAL_AUTH: AntigravityAuthConfig = {
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
};

/** True for the two methods that open a Google sign-in page. */
export function antigravityAuthUsesBrowser(authMethod: AntigravityAuthMethod): boolean {
  return authMethod === "oauth-personal" || authMethod === "oauth-business";
}

/** Label shown on the provider card once the method has authenticated. */
export function antigravityAuthLabel(authMethod: AntigravityAuthMethod): string {
  switch (authMethod) {
    case "oauth-personal":
      return "Google account";
    case "oauth-business":
      return "Gemini Enterprise";
    case "gemini-api-key":
      return "Gemini API key";
    case "agent-platform":
      return "Agent Platform";
  }
}

/**
 * Explains what is missing before a non-personal method can authenticate, or
 * null when the config is complete. Personal sign-in never needs config.
 */
export function antigravityAuthConfigIssue(auth: AntigravityAuthConfig): string | null {
  switch (auth.authMethod) {
    case "oauth-personal":
      return null;
    case "oauth-business":
      return auth.gcpProject && auth.gcpLocation
        ? null
        : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
    case "gemini-api-key":
      return auth.apiKey ? null : "Enter a Gemini API key in the Antigravity provider settings.";
    case "agent-platform":
      return auth.apiKey || (auth.gcpProject && auth.gcpLocation)
        ? null
        : "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.";
  }
}

/**
 * `settings.json` content for the agent's profile. `auth.type` names the
 * selected method so a native logout clears only that method's credentials
 * instead of every stored token. The GCP block feeds Enterprise and Agent
 * Platform. Never holds a credential.
 */
export function antigravityProfileSettings(auth: AntigravityAuthConfig): string {
  const gcp = {
    ...(auth.gcpProject ? { project: auth.gcpProject } : {}),
    ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}),
  };
  return `${encodeProfileSettings({
    auth: { type: auth.authMethod },
    ...(Object.keys(gcp).length > 0 ? { gcp } : {}),
  })}\n`;
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

function authSupportError(detail: string) {
  return new AcpErrors.AcpTransportError({ detail, cause: undefined });
}

/** Recognizes native auth failures and interactive login blocked by T3. */
export function isAntigravitySignInRequiredError(error: unknown): boolean {
  return (
    (isAcpRequestError(error) && error.code === -32000) ||
    (isAcpTransportError(error) && error.detail === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
  );
}

export interface AntigravityInstanceDirectories {
  /** GEMINI_HOME for the agent. Holds the instance's Google sign-in. */
  readonly profile: string;
  /**
   * Parent of the per-process directories the agent unpacks into. It sits
   * beside the profile, not inside it: the agent unpacks members up to 120
   * characters deep, and the profile's longer name would push them past
   * Windows' 260-character path limit.
   */
  readonly runtimeTemp: string;
}

/** Hashes the instance ID so case-only differences stay separate on case-insensitive filesystems. */
export const resolveAntigravityInstanceDirectories = Effect.fn(
  "resolveAntigravityInstanceDirectories",
)(function* (stateDir: string, instanceId: ProviderInstanceId) {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const key = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(instanceId)));
  return {
    profile: path.join(stateDir, "providers", "antigravity", key),
    runtimeTemp: path.join(stateDir, "antigravity-tmp", key.slice(0, 12)),
  } satisfies AntigravityInstanceDirectories;
});

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function antigravityEnvironment(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv,
  auth: AntigravityAuthConfig,
  runtimeTempDirectory?: string,
) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    // Windows treats environment keys as case-insensitive. Remove aliases too.
    if (!removedEnvironmentKeys.has(key.toUpperCase())) environment[key] = value;
  }
  // Only the configured method's credential reaches the agent. The agent
  // prefers GOOGLE_API_KEY over the GCP pair for Agent Platform, so the pair
  // goes through settings.json instead of the environment.
  const credential =
    auth.authMethod === "gemini-api-key" && auth.apiKey
      ? { GEMINI_API_KEY: auth.apiKey }
      : auth.authMethod === "agent-platform" && auth.apiKey
        ? { GOOGLE_API_KEY: auth.apiKey }
        : {};
  // The agent is a PyInstaller one-file bundle. It unpacks about 1 GB into
  // the system temp directory per launch and a force kill leaves that behind.
  // Point it at a T3-owned directory so the driver can reclaim the space.
  const tempDirectory = runtimeTempDirectory ?? profile.tempDirectory;
  return {
    ...environment,
    ...credential,
    ...(profile.caBundlePath !== undefined &&
    baseEnv.SSL_CERT_FILE === undefined &&
    baseEnv.SSL_CERT_DIR === undefined
      ? { SSL_CERT_FILE: profile.caBundlePath }
      : {}),
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    ...(profile.platform === "win32"
      ? { TEMP: tempDirectory, TMP: tempDirectory }
      : { TMPDIR: tempDirectory }),
  };
}

const symlinkKind = (platform: NodeJS.Platform) => (platform === "win32" ? "junction" : "dir");

const pathExists = (target: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(target)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/**
 * The agent reads user skills under `GEMINI_HOME`, which points at the private
 * profile. `config/skills` stays a link to `~/.gemini` so those skills load
 * and nothing here writes through that link. `antigravity-cli/skills` is a
 * real directory in the profile: one link per CLI skill, plus enabled library
 * skills whose names are not already taken. A link that cannot be made only
 * costs that skill, never the session.
 */
const linkAntigravityUserSkills = Effect.fn("linkAntigravityUserSkills")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  readonly stateDir?: string;
  readonly cwd?: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userGemini = path.join(input.userHome, ".gemini");
  const links = antigravityUserSkillDirectories(path, input.profileDirectory);
  const targets = antigravityUserSkillDirectories(path, path.join(input.userHome, ".gemini"));
  const configLink = links[0];
  const configTarget = targets[0];
  yield* Effect.gen(function* () {
    // The harness creates missing skill folders itself and cannot mkdir through a dangling link.
    if (!(yield* fs.exists(configTarget))) {
      const linked = yield* fs.readLink(configLink).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) yield* fs.remove(configLink);
      return;
    }
    const existing = yield* fs.readLink(configLink).pipe(
      Effect.map((value): string | undefined => path.resolve(path.dirname(configLink), value)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
      // Replace only an empty placeholder; rmdir preserves a directory with user content.
      Effect.catch((error) =>
        Effect.tryPromise(() => NodeFSP.rmdir(configLink)).pipe(
          Effect.as(undefined),
          Effect.mapError(() => error),
        ),
      ),
    );
    if (existing === configTarget) return;
    if (existing !== undefined) {
      yield* fs.remove(configLink);
    }
    yield* fs.makeDirectory(path.dirname(configLink), { recursive: true });
    yield* Effect.tryPromise(() =>
      NodeFSP.symlink(configTarget, configLink, symlinkKind(input.platform)),
    );
  }).pipe(
    // A real directory at the link path fails `readLink` and is left alone.
    Effect.catch((error) =>
      Effect.logWarning("Antigravity user skills are not linked into the profile.", {
        link: configLink,
        target: configTarget,
        error,
      }),
    ),
  );

  yield* Effect.gen(function* () {
    const cliLink = links[1];
    const cliTarget = targets[1];
    const wholeDirectory = yield* fs.readLink(cliLink).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (wholeDirectory) {
      yield* Effect.tryPromise(() => NodeFSP.unlink(cliLink));
    }
    if (!(yield* pathExists(cliLink))) {
      yield* fs.makeDirectory(cliLink, { recursive: true });
    } else if ((yield* fs.stat(cliLink)).type !== "Directory") {
      return;
    }

    const userChildren = yield* fs
      .readDirectory(cliTarget)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const child of userChildren) {
      if (child.startsWith(".")) continue;
      const dest = path.join(cliLink, child);
      if (yield* pathExists(dest)) continue;
      yield* Effect.tryPromise(() =>
        NodeFSP.symlink(path.join(cliTarget, child), dest, symlinkKind(input.platform)),
      );
    }
    if (input.stateDir === undefined) return;

    const blocked = new Set(userChildren.map((child) => child.toLowerCase()));
    const configChildren = yield* fs
      .readDirectory(configTarget)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const child of configChildren) blocked.add(child.toLowerCase());
    if (input.cwd !== undefined) {
      const discovered = yield* discoverAntigravitySkills({
        cwd: input.cwd,
        userHome: input.userHome,
      }).pipe(Effect.option);
      if (discovered._tag === "None") return;
      for (const skill of discovered.value) blocked.add(skill.name.trim().toLowerCase());
      for (const root of [".gemini/skills", ".agents/skills", ".agent/skills"]) {
        const children = yield* fs
          .readDirectory(path.join(input.cwd, ...root.split("/")))
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const child of children) blocked.add(child.toLowerCase());
      }
    }

    const library = agentsSkillsDir(input.userHome);
    const enabled = readLibrary(input.userHome, input.stateDir).skills.filter(
      (skill) => skill.enabled,
    );
    const wanted = new Set(
      enabled
        .filter(
          (skill) =>
            !blocked.has(skill.name.toLowerCase()) &&
            !blocked.has(skill.directoryName.toLowerCase()),
        )
        .map((skill) => skill.directoryName),
    );
    const present = yield* fs
      .readDirectory(cliLink)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of present) {
      const dest = path.join(cliLink, entry);
      const target = yield* fs.readLink(dest).pipe(
        Effect.map((value) => path.resolve(path.dirname(dest), value)),
        Effect.orElseSucceed(() => undefined),
      );
      const relative = target === undefined ? undefined : path.relative(library, target);
      const insideLibrary =
        relative !== undefined &&
        (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)));
      if (!insideLibrary || wanted.has(entry)) {
        continue;
      }
      yield* Effect.tryPromise(() => NodeFSP.unlink(dest));
    }
    for (const skill of enabled) {
      if (!wanted.has(skill.directoryName)) continue;
      const dest = path.join(cliLink, skill.directoryName);
      if (yield* pathExists(dest)) continue;
      yield* Effect.tryPromise(() =>
        NodeFSP.symlink(path.dirname(skill.path), dest, symlinkKind(input.platform)),
      );
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Antigravity shared skills are not linked into the profile.", { error }),
    ),
  );
});

const antigravityUserRuleFiles = ["AGENTS.md", "GEMINI.md"] as const;

/**
 * The agent reads the user's global rules from `GEMINI_HOME`. Each rule file in the real
 * `~/.gemini` is linked into the profile; a file the profile owns is left alone, and a link
 * that cannot be made only costs that file.
 */
const linkAntigravityUserRuleFiles = Effect.fn("linkAntigravityUserRuleFiles")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of antigravityUserRuleFiles) {
    const link = path.join(input.profileDirectory, name);
    const target = path.join(input.userHome, ".gemini", name);
    yield* Effect.gen(function* () {
      const existing = yield* fs.readLink(link).pipe(
        Effect.map((value): string | undefined => path.resolve(path.dirname(link), value)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
      );
      if (!(yield* fs.exists(target))) {
        if (existing !== undefined) yield* fs.remove(link);
        return;
      }
      if (existing === target) return;
      if (existing !== undefined) yield* fs.remove(link);
      yield* Effect.tryPromise(() => NodeFSP.symlink(target, link, "file"));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity user rules are not linked into the profile.", {
          link,
          target,
          error,
        }),
      ),
    );
  }
});

const RuleCopiesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeRuleCopies = Schema.decodeUnknownOption(RuleCopiesJson);
const encodeRuleCopies = Schema.encodeSync(RuleCopiesJson);

/** Copies refresh each launch; the recorded copy keeps a file the profile owns or edited untouched. */
const copyAntigravityUserRuleFiles = Effect.fn("copyAntigravityUserRuleFiles")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.profileDirectory, ".t3-rule-copies.json");
  const readOptional = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
  const manifestText = yield* readOptional(manifestPath);
  const copies: Record<string, string> = {
    ...Option.getOrElse(decodeRuleCopies(manifestText), () => ({})),
  };
  for (const name of antigravityUserRuleFiles) {
    const link = path.join(input.profileDirectory, name);
    const target = path.join(input.userHome, ".gemini", name);
    yield* Effect.gen(function* () {
      const current = yield* readOptional(link);
      if (current !== undefined && current !== copies[name]) {
        delete copies[name];
        return;
      }
      const source = yield* readOptional(target);
      if (source === undefined) {
        if (current !== undefined) yield* fs.remove(link);
        delete copies[name];
        return;
      }
      yield* fs.writeFileString(link, source);
      copies[name] = source;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity user rules are not copied into the profile.", {
          link,
          target,
          error,
        }),
      ),
    );
  }
  yield* fs
    .writeFileString(manifestPath, encodeRuleCopies(copies))
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity rule copy record could not be written.", { error }),
      ),
    );
});

/** Prepares a private profile without reading or copying Google credentials. */
export const prepareAntigravityProfile = Effect.fn("prepareAntigravityProfile")(function* (input: {
  readonly profileDirectory: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly runtimeExecutablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly auth?: AntigravityAuthConfig;
  /** Home the agent expands `~` against. Defaults to the launch environment's. */
  readonly userHome?: string;
  /** Parent of per-process temp directories. Defaults to one inside the profile. */
  readonly tempDirectory?: string;
  /** SSHCode state directory. Shared skills are linked only when this is set. */
  readonly stateDir?: string;
  /** Session workspace. Project skills here win over a shared skill of the same name. */
  readonly cwd?: string;
}) {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = input.platform ?? (yield* HostProcess.Platform);
  const userHome =
    input.userHome ??
    resolveAntigravityUserHome(
      platform,
      input.baseEnv ?? process.env,
      yield* HostProcess.HomeDirectory,
    );
  const runtimeExecutablePath =
    input.runtimeExecutablePath ??
    (yield* resolveNodeExecutable("Antigravity sign-in", input.baseEnv).pipe(
      Effect.mapError(
        (cause) =>
          new AcpErrors.AcpTransportError({
            detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
            cause,
          }),
      ),
    ));
  const helperExecutable =
    platform === "win32" ? runtimeExecutablePath.replaceAll("\\", "/") : runtimeExecutablePath;
  const browserArguments = [helperExecutable, "-e", browserHelperSource, "--", "%s"];
  const browserCommand = browserArguments.map(quoteBrowserArgument).join(" ");
  if (
    browserCommand.includes(platform === "win32" ? ";" : ":") ||
    helperExecutable.includes("\r") ||
    helperExecutable.includes("\n") ||
    helperExecutable.includes("\0") ||
    helperExecutable.includes("%s")
  ) {
    return yield* authSupportError(
      "The SSHCode runtime path cannot be used to suppress Antigravity browser launches.",
    );
  }

  const geminiHome = path.resolve(input.profileDirectory);
  const acpDirectory = path.join(geminiHome, "antigravity-acp");
  const tempDirectory = input.tempDirectory ?? path.join(acpDirectory, "tmp");
  let caBundlePath: string | undefined;
  if (platform === "linux") {
    // Bundled Python may look for certificates at paths absent on this distribution.
    // Relative paths would resolve differently when the agent runs in the project directory.
    for (const candidate of [
      (input.baseEnv ?? process.env).NIX_SSL_CERT_FILE,
      "/etc/ssl/certs/ca-bundle.crt",
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/ssl/cert.pem",
    ]) {
      if (
        candidate &&
        path.isAbsolute(candidate) &&
        (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
      ) {
        caBundlePath = candidate;
        break;
      }
    }
  }
  const profile: AntigravityProfile = {
    platform,
    geminiHome,
    acpDirectory,
    tokenPath: path.join(acpDirectory, "acp_token.json"),
    tempDirectory,
    browserCommand,
    ...(caBundlePath === undefined ? {} : { caBundlePath }),
  };
  const environment = antigravityEnvironment(profile, input.baseEnv ?? process.env, auth);
  yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(helperExecutable, ["-e", browserHelperSource, "--", browserPreflightUrl], {
        env: environment,
        extendEnv: false,
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (
      Number(exitCode) !== 0 ||
      stdout.bytes !== 0 ||
      stdout.truncated ||
      stderr.truncated ||
      stderr.text !== `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"${browserPreflightUrl}"\n`
    ) {
      return yield* authSupportError("Antigravity browser suppression could not be verified.");
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(authSupportError("Antigravity browser suppression verification timed out.")),
    }),
    Effect.mapError((error) =>
      error._tag === "AcpTransportError"
        ? error
        : authSupportError("Antigravity browser suppression could not be verified."),
    ),
  );

  for (const directory of [geminiHome, acpDirectory, tempDirectory]) {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          authSupportError("The Antigravity profile directory could not be created."),
        ),
      );
    if (platform !== "win32") {
      yield* fs
        .chmod(directory, 0o700)
        .pipe(
          Effect.mapError(() =>
            authSupportError("The Antigravity profile directory permissions could not be set."),
          ),
        );
    }
  }
  // Rewriting on every launch keeps a method, project, or location edit in
  // Settings effective. The agent also records auth.type here after a
  // sign-in, which matches the value written below.
  yield* fs
    .writeFileString(path.join(acpDirectory, "settings.json"), antigravityProfileSettings(auth))
    .pipe(
      Effect.mapError(() =>
        authSupportError("The Antigravity profile settings could not be written."),
      ),
    );
  yield* linkAntigravityUserSkills({
    profileDirectory: geminiHome,
    userHome,
    platform,
    ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  // File symlinks need elevation or Developer Mode on Windows, so rules are copied there.
  if (platform === "win32") {
    yield* copyAntigravityUserRuleFiles({ profileDirectory: geminiHome, userHome });
  } else {
    yield* linkAntigravityUserRuleFiles({ profileDirectory: geminiHome, userHome });
  }
  return profile;
});

/** Applies the same subscription-only launch settings to every ACP process. */
export function buildAntigravityAcpSpawnInput(input: {
  readonly installation: {
    readonly executablePath: string;
    readonly harnessPath: string | null;
  };
  readonly profile: AntigravityProfile;
  readonly cwd: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly auth?: AntigravityAuthConfig;
  /** Per-process temp directory. Defaults to the profile's shared temp directory. */
  readonly runtimeTempDirectory?: string;
}): AcpSessionRuntime.AcpSpawnInput {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  // The agy CLI signs in to Agent Platform from these two variables, not from
  // the profile's settings.json the managed runtime reads.
  const cliProject =
    input.installation.harnessPath === null && auth.authMethod === "agent-platform" && !auth.apiKey
      ? {
          ...(auth.gcpProject ? { GOOGLE_CLOUD_PROJECT: auth.gcpProject } : {}),
          ...(auth.gcpLocation ? { GOOGLE_CLOUD_LOCATION: auth.gcpLocation } : {}),
        }
      : {};
  return {
    command: input.installation.executablePath,
    // The agy CLI has no harness sibling and serves ACP through its `acp` subcommand.
    args:
      input.installation.harnessPath === null
        ? ["acp"]
        : input.profile.platform === "linux"
          ? ["--uid="]
          : [],
    cwd: input.cwd,
    env: {
      ...antigravityEnvironment(
        input.profile,
        input.baseEnv ?? process.env,
        auth,
        input.runtimeTempDirectory,
      ),
      ...cliProject,
      ...(input.installation.harnessPath === null
        ? {}
        : { ANTIGRAVITY_HARNESS_PATH: input.installation.harnessPath }),
    },
    extendEnv: false,
  };
}

/** Reads only the public authorization request, never an OAuth token file. */
export const parseAntigravityAuthorizationUrl = Effect.fn("parseAntigravityAuthorizationUrl")(
  function* (
    authorizationUrl: string,
  ): Effect.fn.Return<AntigravityAuthorizationUrl, AcpErrors.AcpError> {
    const invalidUrl = () =>
      authSupportError("Antigravity returned an invalid Google sign-in URL.");
    if (authorizationUrl.length > maxAuthorizationUrlLength || /\s/.test(authorizationUrl)) {
      return yield* invalidUrl();
    }
    const url = yield* decodeUrl(authorizationUrl).pipe(Effect.mapError(invalidUrl));
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("redirect_uri").length !== 1 ||
      url.searchParams.getAll("response_type").length !== 1 ||
      url.searchParams.get("response_type") !== "code" ||
      state === null ||
      state.length === 0 ||
      state.length > 512 ||
      /\s/.test(state) ||
      redirectUri === null ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
    ) {
      return yield* invalidUrl();
    }
    const redirect = yield* decodeUrl(redirectUri).pipe(Effect.mapError(invalidUrl));
    if (Number(redirect.port) < 1_024) return yield* invalidUrl();
    return { authorizationUrl, redirectUri, state };
  },
);

export function makeAntigravityStdoutTransform(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  const handleLine = Effect.fn("antigravityAuthSupport.handleStdoutLine")(function* (
    line: Uint8Array,
  ) {
    if (!authPrefixBytes.every((byte, index) => line[index] === byte)) return [line];
    const message = new TextDecoder().decode(line).replace(/\r?\n$/, "");
    const request = yield* parseAntigravityAuthorizationUrl(
      message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length),
    );
    if (!input.onAuthorizationUrl) {
      return yield* authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE);
    }
    yield* input.onAuthorizationUrl(request.authorizationUrl);
    return [];
  });

  return (
    stdout: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpErrors.AcpError> =>
    Stream.suspend(() => {
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const finishLine = () => {
        const line = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        return line;
      };
      return stdout.pipe(
        Stream.mapEffect(
          Effect.fn("antigravityAuthSupport.splitStdoutLines")(function* (chunk: Uint8Array) {
            const lines: Uint8Array[] = [];
            let offset = 0;
            while (offset < chunk.byteLength) {
              const newline = chunk.indexOf(10, offset);
              const end = newline === -1 ? chunk.byteLength : newline + 1;
              const part = chunk.subarray(offset, end);
              if (pendingBytes + part.byteLength > maxStdoutLineBytes) {
                return yield* authSupportError(
                  "Antigravity sent a protocol line that is too large.",
                );
              }
              pending.push(part);
              pendingBytes += part.byteLength;
              if (newline !== -1) lines.push(finishLine());
              offset = end;
            }
            return lines;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.concat(
          Stream.suspend(() => (pendingBytes > 0 ? Stream.succeed(finishLine()) : Stream.empty)),
        ),
        Stream.mapEffect(handleLine),
        Stream.flatMap(Stream.fromIterable),
      );
    });
}

/** Receives native 1.1.1 sign-in URLs and T3 browser-helper URLs without logging stderr. */
export function makeAntigravityStderrHandler(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  let pending = "";
  const handleLine = (line: string) => {
    const message = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (message.length > maxBrowserHelperLineLength) {
      return Effect.void;
    }
    const url = message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
      ? Effect.succeed(message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length))
      : message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)
        ? decodeBrowserHelperUrl(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length))
        : undefined;
    if (url === undefined) return Effect.void;
    return url.pipe(
      Effect.flatMap(parseAntigravityAuthorizationUrl),
      Effect.matchEffect({
        onFailure: () => Effect.void,
        onSuccess: (request) =>
          input.onAuthorizationUrl
            ? input.onAuthorizationUrl(request.authorizationUrl)
            : Effect.fail(authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)),
      }),
    );
  };

  return Effect.fn("antigravityAuthSupport.handleStderr")(function* (text: string) {
    const lines = `${pending}${text}`.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maxBrowserHelperLineLength) pending = "";
    yield* Effect.forEach(lines, handleLine, { discard: true });
  });
}

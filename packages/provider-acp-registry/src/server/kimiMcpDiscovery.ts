import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";
import { parse, stringify } from "smol-toml";

const TOOL_SELECT_ENV = "KIMI_CODE_EXPERIMENTAL_TOOL_SELECT";

/** The explicit Kimi Code home must be inside the server's real provider-homes
 * directory. Resolve directory links and reject config-file links before writing. */
const enableManagedKimiMcp = Effect.fn("enableManagedKimiMcp")(function* (
  configuredProfile: string,
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* fs.realPath(stateDir);
  const root = path.join(state, "provider-homes");
  if ((yield* fs.realPath(root)) !== root) return;
  const profile = yield* fs.realPath(configuredProfile);
  const relative = path.relative(root, profile);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return;
  const configPath = path.join(profile, "config.toml");
  const linked = fs.readLink(configPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (yield* linked) return;
  const exists = yield* fs.exists(configPath);
  const original = exists ? yield* fs.readFileString(configPath) : "";
  const next = yield* Effect.try(() => {
    const config = parse(original);
    const section = config.mcp;
    if (
      section !== undefined &&
      (typeof section !== "object" ||
        section === null ||
        section instanceof Date ||
        Array.isArray(section))
    )
      return;
    if (section?.default_deferred === true) return;
    return stringify({ ...config, mcp: { ...section, default_deferred: true } });
  });
  if (next === undefined) return;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({
        directory: profile,
        prefix: ".sshcode-kimi-",
      });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.writeFileString(temporary, next);
      if (yield* linked) return;
      if (exists) {
        // Leave edits made by a concurrently running CLI intact.
        if ((yield* fs.readFileString(configPath)) === original)
          yield* fs.rename(temporary, configPath);
      } else {
        yield* fs.link(temporary, configPath);
      }
    }),
  );
});

function kimiDefersSessionMcp(config: string, explicitToolSelect: boolean): boolean {
  try {
    const { mcp, experimental } = parse(config);
    if (
      !explicitToolSelect &&
      typeof experimental === "object" &&
      experimental !== null &&
      "tool-select" in experimental &&
      experimental["tool-select"] === false
    ) {
      return false;
    }
    return (
      typeof mcp === "object" &&
      mcp !== null &&
      "default_deferred" in mcp &&
      mcp.default_deferred === true
    );
  } catch {
    return false;
  }
}

/** Kimi applies this setting to ACP session MCP too. Its ACP converter only
 * forwards transport fields, so a per-server deferral setting cannot go there. */
export const kimiDiscoveryEnvironment = Effect.fn("kimiDiscoveryEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
  managedStateDir?: string,
) {
  const configuredSelect = environment[TOOL_SELECT_ENV];
  if (configuredSelect !== undefined && configuredSelect !== "1" && configuredSelect !== "true") {
    return undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const profile = environment.KIMI_CODE_HOME?.trim();
  const profilePath = profile ? expandHomePath(profile, home) : path.join(home, ".kimi-code");
  if (profile && managedStateDir) {
    // Config errors leave the existing compact eager path available.
    yield* enableManagedKimiMcp(profilePath, managedStateDir).pipe(Effect.ignore);
  }
  const config = yield* fs
    .readFileString(path.join(profilePath, "config.toml"))
    .pipe(Effect.orElseSucceed(() => ""));
  return kimiDefersSessionMcp(config, configuredSelect !== undefined)
    ? { ...environment, [TOOL_SELECT_ENV]: "1" }
    : undefined;
});

export function kimiSupportsMcpDiscovery(
  initialized: EffectAcpSchema.InitializeResponse,
  model: string,
): boolean {
  const info = initialized.agentInfo;
  return (
    info?.name === "Kimi Code CLI" &&
    parseSemver(info.version) !== null &&
    compareSemverVersions(info.version, "2.4.1") >= 0 &&
    model.startsWith("kimi-code/")
  );
}

export const kimiMcpDiscoveryInstructions = (catalog: string) =>
  `T3 Code tools. Use select_tools with the matching name from Kimi's loadable tools list, then call it.\n${catalog}`;

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parse as parseYamlDocument } from "yaml";

/**
 * The home directory the agent expands `~` against, matching Python's
 * `os.path.expanduser` in the launch environment T3 hands the process:
 * `USERPROFILE`, then `HOMEDRIVE` + `HOMEPATH`, on Windows and `HOME`
 * elsewhere. Values are used verbatim; a path may contain spaces.
 */
export function resolveAntigravityUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
    return home;
  }
  return environment.HOME || home;
}

/**
 * The agent's two user-global skill directories under a Gemini home, in
 * native precedence order: `config/skills` is shared with the Antigravity IDE
 * and CLI, and `antigravity-cli/skills` is where the `agy` CLI installs
 * skills. The agent resolves both under `GEMINI_HOME`, which T3 points at a
 * private profile. `config/skills` links to the user's `~/.gemini`. The CLI
 * directory is filled in the profile, including shared skills from
 * `~/.agents/skills` that do not clash. The agent itself only treats
 * `.agents/skills` as a project directory.
 */
export function antigravityUserSkillDirectories(
  path: Path.Path,
  geminiHome: string,
): readonly [configSkills: string, cliSkills: string] {
  return [
    path.join(geminiHome, "config", "skills"),
    path.join(geminiHome, "antigravity-cli", "skills"),
  ];
}

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;
// Typical frontmatter fits in one chunk, so most skills cost about this much of the scan budget.
const SKILL_READ_CHUNK_BYTES = 1024;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);

const PLUGIN_MANIFEST_PATHS = [
  [".antigravity-plugin", "plugin.json"],
  [".gemini-plugin", "plugin.json"],
  ["plugin.json"],
] as const;
const decodePluginManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      $schema: Schema.optional(Schema.String),
      skills: Schema.optional(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      ),
    }),
  ),
);
const decodePluginPreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
);

export class AntigravitySkillsProbeError extends Schema.TaggedError<AntigravitySkillsProbeError>()(
  "AntigravitySkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "scan-budget-exhausted"
      ? `Antigravity skill discovery exceeded its scan limit at '${this.path}'.`
      : `Antigravity could not read skills at '${this.path}'.`;
  }
}

interface ScanBudget {
  remainingBytes: number;
  remainingEntries: number;
}

const readIfPresent = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  path: string,
) =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(
              new AntigravitySkillsProbeError({ reason: "filesystem-error", path, cause }),
            ),
    }),
  );

function parseSkillFrontmatter(contents: string, fileName: string) {
  const start = contents.indexOf("---");
  if (start === -1) return undefined;
  const end = contents.indexOf("---", start + 3);
  if (end === -1) return undefined;
  try {
    const frontmatter = decodeSkillFrontmatter(
      parseYamlDocument(contents.slice(start + 3, end).trim(), {
        schema: "failsafe",
        customTags: ["null"],
      }) ?? {},
    );
    const name = frontmatter.name || fileName.slice(0, -3);
    const description = frontmatter.description?.trim();
    // Native names are not trimmed. Do not rename one to fit the picker contract.
    if (!name || name !== name.trim()) return undefined;
    return { name, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

/** The native loader orders child paths with Go's URL.EscapedPath encoding. */
function skillPathSortKey(entry: string) {
  return encodeURI(entry).replace(
    /[!'()*?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const DASH = 0x2d;

/** Finds the byte offset after the second `---`, as parseSkillFrontmatter's indexOf calls do. */
function makeFrontmatterEndFinder() {
  let bytesSeen = 0;
  let dashes = 0;
  let markers = 0;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      bytesSeen += 1;
      dashes = byte === DASH ? dashes + 1 : 0;
      if (dashes === 3) {
        dashes = 0;
        markers += 1;
        if (markers === 2) return bytesSeen;
      }
    }
    return undefined;
  };
}

/** Reads through the frontmatter only, so skill bodies do not spend the scan budget. */
const readSkillFrontmatter = Effect.fn("readAntigravitySkill")(function* (
  skillPath: string,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(skillPath), skillPath);
  if (info?.type !== "File") return undefined;

  const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
  const findFrontmatterEnd = makeFrontmatterEndFinder();
  let frontmatterEnd: number | undefined;
  const chunks = yield* readIfPresent(
    fileSystem
      .stream(skillPath, { bytesToRead: byteLimit + 1, chunkSize: SKILL_READ_CHUNK_BYTES })
      .pipe(
        Stream.takeUntil((chunk) => (frontmatterEnd = findFrontmatterEnd(chunk)) !== undefined),
        Stream.runCollect,
      ),
    skillPath,
  );
  if (chunks === undefined) return undefined;
  const bytes = Buffer.concat(chunks);
  budget.remainingBytes -= bytes.byteLength;
  if ((frontmatterEnd ?? bytes.byteLength) > byteLimit) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  return bytes.toString("utf8", 0, frontmatterEnd);
});

/**
 * Match the official ACP's explicit skill roots. The first valid same-name skill
 * wins. Automatic .agent(s)/skills roots are collections of immediate child skills.
 * Read failures remain typed so workspace snapshots do not cache partial results.
 */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd: string;
  readonly userHome: string;
  readonly profileDirectory?: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [configSkills, cliSkills] = antigravityUserSkillDirectories(
    path,
    path.join(input.userHome, ".gemini"),
  );
  const roots = [
    { directory: configSkills, scope: "user", collection: false },
    {
      directory: path.resolve(input.cwd, ".gemini", "skills"),
      scope: "project",
      collection: false,
    },
    { directory: cliSkills, scope: "user", collection: false },
    { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project", collection: true },
    { directory: path.resolve(input.cwd, ".agent", "skills"), scope: "project", collection: true },
  ];
  const budget: ScanBudget = {
    remainingBytes: MAX_SCAN_BYTES,
    remainingEntries: MAX_SCAN_ENTRIES,
  };
  const skillsByName = new Map<string, ServerProviderSkill>();

  const addSkillFile = Effect.fnUntraced(function* (
    skillPath: string,
    scope: string,
    pluginName?: string,
  ) {
    const fileName = path.basename(skillPath);
    if (fileName.toLowerCase() !== "skill.md" || !fileName.endsWith(".md")) return;
    const contents = yield* readSkillFrontmatter(skillPath, budget);
    if (contents === undefined) return;
    const skill = parseSkillFrontmatter(contents, fileName);
    if (!skill || skillsByName.has(skill.name)) return;
    skillsByName.set(skill.name, {
      ...skill,
      path: skillPath,
      scope,
      enabled: true,
      ...(pluginName === undefined ? {} : { displayName: `${pluginName}:${skill.name}` }),
    });
  });

  const scanDirectory = Effect.fn("scanAntigravitySkillDirectory")(function* (
    directory: string,
    scope: string,
    mode: "root" | "collection" | "child" | "manifest",
    pluginName?: string,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type === "File" && mode === "manifest") {
      if (budget.remainingEntries-- <= 0) {
        return yield* new AntigravitySkillsProbeError({
          reason: "scan-budget-exhausted",
          path: directory,
        });
      }
      return yield* addSkillFile(directory, scope, pluginName);
    }
    if (info?.type !== "Directory") return;
    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
    if (entries === undefined) return;
    if (entries.length > budget.remainingEntries) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: directory,
      });
    }
    budget.remainingEntries -= entries.length;

    const sortedEntries = entries.toSorted();
    const skillFileName = sortedEntries.find((entry) => entry.toLowerCase() === "skill.md");
    if (mode !== "collection" && skillFileName !== undefined) {
      yield* addSkillFile(path.join(directory, skillFileName), scope, pluginName);
      return;
    }
    if (mode !== "child") {
      const children = sortedEntries
        .map((entry) => ({ entry, sortKey: skillPathSortKey(entry) }))
        .sort((left, right) =>
          left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
        );
      for (const { entry } of children) {
        yield* scanDirectory(path.join(directory, entry), scope, "child", pluginName);
      }
    }
  });

  for (const root of roots) {
    yield* scanDirectory(root.directory, root.scope, root.collection ? "collection" : "root");
  }
  if (input.profileDirectory !== undefined) {
    const configDir = path.join(input.profileDirectory, "config");
    const pluginsDir = path.join(configDir, "plugins");
    const plugins = yield* readIfPresent(fileSystem.readDirectory(pluginsDir), pluginsDir);
    if (plugins !== undefined && plugins.length > 0) {
      if (plugins.length > budget.remainingEntries) {
        return yield* new AntigravitySkillsProbeError({
          reason: "scan-budget-exhausted",
          path: pluginsDir,
        });
      }
      budget.remainingEntries -= plugins.length;
      const readPluginJson = Effect.fnUntraced(function* (file: string) {
        const info = yield* readIfPresent(fileSystem.stat(file), file);
        if (info?.type !== "File") return undefined;
        const maxBytes = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
        const chunks = yield* readIfPresent(
          fileSystem.stream(file, { bytesToRead: maxBytes + 1 }).pipe(Stream.runCollect),
          file,
        );
        if (chunks === undefined) return undefined;
        const bytes = Buffer.concat(chunks);
        if (bytes.length > maxBytes) {
          return yield* new AntigravitySkillsProbeError({
            reason: "scan-budget-exhausted",
            path: file,
          });
        }
        budget.remainingBytes -= bytes.length;
        return bytes.toString("utf8").replace(/^\uFEFF/u, "");
      });

      const config = yield* readPluginJson(path.join(configDir, "config.json"));
      const preferences = config === undefined ? undefined : decodePluginPreferences(config);
      const pluginPreferences =
        preferences?._tag === "Some" ? preferences.value.plugins : undefined;
      for (const plugin of plugins.toSorted()) {
        if (pluginPreferences?.[plugin]?.enabled === false) continue;
        const pluginDir = path.join(pluginsDir, plugin);
        const stat = yield* readIfPresent(fileSystem.stat(pluginDir), pluginDir);
        if (stat?.type !== "Directory") continue;
        for (const segments of PLUGIN_MANIFEST_PATHS) {
          const raw = yield* readPluginJson(path.join(pluginDir, ...segments));
          if (raw === undefined) continue;
          const manifest = decodePluginManifest(raw);
          if (manifest._tag === "None") break;
          yield* scanDirectory(path.join(pluginDir, "skills"), "user", "root", plugin);
          const { $schema, skills } = manifest.value;
          if (!$schema?.startsWith("https://agent-plugins.org/schemas/")) {
            for (const skillPath of typeof skills === "string" ? [skills] : (skills ?? [])) {
              yield* scanDirectory(path.resolve(pluginDir, skillPath), "user", "manifest", plugin);
            }
          }
          break;
        }
      }
    }
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

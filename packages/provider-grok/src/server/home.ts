import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { GrokSettings } from "../settings.ts";

/** Resolve exactly the home exported to Grok, without shell-expanding inherited values. */
export const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (
  config: Pick<GrokSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = config.homePath.trim();
  return path.resolve(
    configured
      ? expandHomePath(configured, home)
      : environment.GROK_HOME?.trim() ||
          path.join(environment.HOME || environment.USERPROFILE || home, ".grok"),
  );
});

export const makeGrokEnvironment = Effect.fn("makeGrokEnvironment")(function* (
  config: Pick<GrokSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv & { GROK_HOME: string }, never, Path.Path> {
  return { ...environment, GROK_HOME: yield* resolveGrokHomePath(config, environment) };
});

// Grok 1.0.77's sandbox requires real hooks/, hooks-paths, bundled/ and bundles/;
// memory-v2 also rejects a symlinked root. Keep those private. Runtime registries,
// locks, credentials, downloads, diagnostic logs and account caches stay private too.
const GROK_SHARED_ENTRIES = [
  "sessions",
  "config.toml",
  "skills",
  "agents",
  "rules",
  "workflows",
  "installed-plugins",
  "marketplace-cache",
  "trusted_folders.toml",
  "sandbox.toml",
  "pager.toml",
  "bin",
  "vendor",
  "version.json",
  ".metadata_version",
  "completions",
  "docs",
  "CHANGELOG.json",
  "CHANGELOG.md",
  "README.md",
] as const;

/** Link missing entries at every start; an existing file or dangling link remains the user's. */
export const linkGrokHomeToMain = Effect.fn("linkGrokHomeToMain")(function* (
  config: Pick<GrokSettings, "homePath" | "shareMainFolder">,
  environment: NodeJS.ProcessEnv,
) {
  if (!config.shareMainFolder || !config.homePath.trim()) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const main = yield* resolveGrokHomePath({ homePath: "" }, environment);
  const second = yield* resolveGrokHomePath(config, environment);
  if (main === second) return;
  yield* fs.makeDirectory(second, { recursive: true }).pipe(Effect.ignore);
  for (const entry of GROK_SHARED_ENTRIES) {
    const source = path.join(main, entry);
    if (!(yield* fs.exists(source).pipe(Effect.orElseSucceed(() => false)))) continue;
    yield* fs.symlink(source, path.join(second, entry)).pipe(Effect.ignore);
  }
});

/** Canonical sessions identity handles relative links, chains and whole-home aliases. */
export const resolveGrokSessionsPath = Effect.fn("resolveGrokSessionsPath")(function* (
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = path.join(homePath, "sessions");
  return yield* fs.realPath(sessions).pipe(Effect.orElseSucceed(() => sessions));
});

/** Keep the source account's legacy key, including custom IDs such as grok_grok_build. */
export const makeGrokContinuationGroupKey = Effect.fn("makeGrokContinuationGroupKey")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly homePath: string;
    readonly instances: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly homePath: string;
    }>;
  }) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const sessions = yield* resolveGrokSessionsPath(input.homePath);
    let owner: ProviderInstanceId | undefined;
    for (const candidate of input.instances) {
      if ((yield* resolveGrokSessionsPath(candidate.homePath)) !== sessions) continue;
      owner ??= candidate.instanceId;
      // Prefer the source over a linked folder, regardless of provider order.
      const home = yield* fs
        .realPath(candidate.homePath)
        .pipe(Effect.orElseSucceed(() => candidate.homePath));
      if (path.join(home, "sessions") === sessions) {
        owner = candidate.instanceId;
        break;
      }
    }
    return defaultProviderContinuationIdentity({
      driverKind: ProviderDriverKind.make("grok"),
      instanceId: owner ?? input.instanceId,
    }).continuationKey;
  },
);

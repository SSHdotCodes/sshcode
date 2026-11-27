import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  pruneManagedToolVersions,
  scanManagedToolProcesses,
  type ManagedToolProcesses,
  type ManagedToolPruneResult,
} from "@t3tools/shared/managedToolRetention";
import { pruneCloudflaredVersions } from "@t3tools/shared/relayClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { pruneLocalDeviceTools } from "../device/deviceToolMaintenance.ts";
import { previewBrowserRelease, prunePreviewBrowserVersions } from "../preview/PreviewBrowser.ts";

const steerTools = {
  "vibe-steer": {
    manifest: "manifest.json",
    updater: "lib/update.py",
    executable: "venv/bin/python",
  },
  "kimi-code-steer": {
    manifest: ".kimi-code-steer-install.json",
    updater: "bin/update-kimi-code-steer.mjs",
    executable: "bin/kimi",
  },
} as const;

const decodeSteerManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      verified: Schema.optionalKey(Schema.Boolean),
      owner: Schema.optionalKey(Schema.String),
    }),
  ),
);

const pruneSteerTool = Effect.fn("ManagedToolStartup.pruneSteerTool")(function* (
  toolsDirectory: string,
  name: keyof typeof steerTools,
  options: { dryRun: boolean; processes: Effect.Effect<ManagedToolProcesses | null> },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(toolsDirectory, name);
  const spec = steerTools[name];
  const currentVersion = fs.readLink(path.join(root, "current")).pipe(
    Effect.map((target) => {
      const directory = path.resolve(root, target);
      return path.dirname(directory) === root ? path.basename(directory) : "";
    }),
    Effect.orElseSucceed(() => ""),
  );
  const current = yield* currentVersion;
  return yield* pruneManagedToolVersions({
    toolsDirectory,
    versionsDirectory: root,
    current,
    isVersion: (version) => /^\d+\.\d+\.\d+$/u.test(version),
    completed: (version, directory) =>
      Effect.gen(function* () {
        const manifest = yield* fs
          .readFileString(path.join(directory, spec.manifest))
          .pipe(Effect.flatMap(decodeSteerManifest));
        return (
          manifest.version === version &&
          (name === "vibe-steer" ||
            (manifest.verified === true && manifest.owner === "kimi-code-steer-updater-v1")) &&
          (yield* fs.exists(path.join(directory, spec.executable)))
        );
      }).pipe(Effect.orElseSucceed(() => false)),
    stillCurrent: currentVersion.pipe(Effect.map((latest) => latest === current)),
    dryRun: options.dryRun,
    processes: options.processes.pipe(
      Effect.map((snapshot) => {
        const updater = path.join(root, spec.updater);
        return snapshot === null || snapshot.uses(updater) ? null : snapshot;
      }),
    ),
  });
});

/** Prune only installed tools. The startup pass never downloads or launches one. */
export const pruneLocalManagedTools = Effect.fn("ManagedToolStartup.pruneLocalManagedTools")(
  function* (baseDir: string, dryRun = false) {
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const processes = yield* Effect.cached(scanManagedToolProcesses);
    const options = { processes, dryRun };
    const toolsDirectory = path.join(baseDir, "tools");
    const browser = previewBrowserRelease(platform, arch);
    const tasks = {
      "vibe-steer": pruneSteerTool(toolsDirectory, "vibe-steer", options),
      "kimi-code-steer": pruneSteerTool(toolsDirectory, "kimi-code-steer", options),
      cloudflared: pruneCloudflaredVersions(baseDir, platform, arch, options),
      "agent-device": pruneLocalDeviceTools(baseDir, "agent", options),
      "expo-device-hub": pruneLocalDeviceTools(baseDir, "hub", options),
      ...(browser && {
        "chrome-headless-shell": prunePreviewBrowserVersions(baseDir, browser, platform, options),
      }),
    };
    const results: Array<readonly [string, ManagedToolPruneResult]> = [];
    for (const [name, task] of Object.entries(tasks)) {
      const result = yield* task.pipe(
        Effect.catch(() =>
          Effect.logDebug("Could not prune managed tool", { name }).pipe(Effect.as(null)),
        ),
      );
      if (result !== null) results.push([name, result]);
    }
    return results;
  },
);

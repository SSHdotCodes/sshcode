import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { pruneLocalManagedTools } from "./ManagedToolStartup.ts";

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "prunes verified steer versions on startup using their selected symlink",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tools-startup-" });
      const tool = path.join(home, "tools", "vibe-steer");
      const versions = ["1.0.1", "1.0.2", "1.0.3", "1.0.4"];
      for (const [index, version] of versions.entries()) {
        const release = path.join(tool, version);
        const bin = path.join(release, "venv", "bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(path.join(bin, "python"), "fixture");
        if (version !== "1.0.4") {
          yield* fs.writeFileString(
            path.join(release, "manifest.json"),
            `{"version":"${version}"}`,
          );
        }
        yield* fs.utimes(release, index + 1, index + 1);
      }
      yield* fs.symlink("1.0.3", path.join(tool, "current"));

      yield* pruneLocalManagedTools(home);

      expect((yield* fs.readDirectory(tool)).sort()).toEqual([
        "1.0.2",
        "1.0.3",
        "1.0.4",
        "current",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

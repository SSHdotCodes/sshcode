import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";

export class ICloudFolders extends Context.Service<
  ICloudFolders,
  { readonly contains: (directory: string) => Effect.Effect<boolean> }
>()("t3/workspace/ICloudFolders") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const canonical = (directory: string) =>
    fs.realPath(directory).pipe(Effect.orElseSucceed(() => path.resolve(directory)));
  const within = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const synced = yield* Cache.makeWith(
    (directory: string) =>
      runner
        .run({
          command: "/usr/bin/xattr",
          args: ["-p", "com.apple.file-provider-domain-id", directory],
          timeout: "1 second",
          maxOutputBytes: 4096,
        })
        .pipe(
          Effect.map((result) => Number(result.code) === 0 && result.stdout.trim().length > 0),
          Effect.orElseSucceed(() => false),
        ),
    { capacity: 2, timeToLive: () => "5 minutes" },
  );

  const contains = Effect.fn("ICloudFolders.contains")(function* (directory: string) {
    if (platform !== "darwin") return false;
    const target = yield* canonical(directory);
    const roots = [
      path.join(home, "Library", "Mobile Documents"),
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
    ];
    for (const [index, root] of roots.entries()) {
      const resolved = yield* canonical(root);
      if (
        (within(root, path.resolve(directory)) || within(resolved, target)) &&
        (index === 0 || (yield* Cache.get(synced, root)))
      )
        return true;
    }
    return false;
  });
  return ICloudFolders.of({ contains });
});

export const layer = Layer.effect(ICloudFolders, make);

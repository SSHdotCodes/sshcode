import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect } from "vite-plus/test";

import { makeGrokXSearch } from "./xSearch.ts";

// Uses the signed-in Grok on this machine and its real X search:
//   T3_GROK_X_SEARCH_LIVE=1 pnpm exec vp test run src/server/xSearch.live.test.ts
describe.runIf(process.env.T3_GROK_X_SEARCH_LIVE === "1")("grok X search (live)", () => {
  it.effect(
    "finds posts and cannot read files outside its empty folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-grok-x-search-" });
        const search = yield* makeGrokXSearch({
          grokSettings: {
            enabled: true,
            binaryPath: "grok",
            homePath: "",
            shareMainFolder: false,
            customModels: [],
          },
          environment: process.env,
          cwd: yield* fileSystem.realPath(cwd),
          homeDirectory: yield* HostProcess.HomeDirectory,
        });
        const answer = yield* search(
          process.env.T3_GROK_X_SEARCH_QUERY ?? "from:testingcatalog newest 3 posts",
        );
        yield* Effect.logInfo(answer);
        expect(answer).toMatch(/https:\/\/x\.com\/\w+\/status\/\d+/u);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    300_000,
  );
});

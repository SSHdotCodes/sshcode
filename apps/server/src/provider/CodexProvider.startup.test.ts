import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex startup detection", (it) => {
  it.effect("reports an npm wrapper with a missing platform package as unable to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prefix = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-broken-npm-" });
      const packageDir = path.join(prefix, "lib", "node_modules", "@openai", "codex");
      const binaryPath = path.join(prefix, "bin", "codex");
      yield* fs.makeDirectory(path.join(packageDir, "bin"), { recursive: true });
      yield* fs.makeDirectory(path.dirname(binaryPath));
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        '{"name":"@openai/codex","version":"0.167.1","bin":{"codex":"bin/codex.js"}}',
      );
      const wrapperPath = path.join(packageDir, "bin", "codex.js");
      // npm exits successfully when this optional platform dependency is missing.
      yield* fs.writeFileString(
        wrapperPath,
        '#!/usr/bin/env node\nrequire.resolve("@openai/codex-darwin-arm64/package.json");\n',
      );
      yield* fs.chmod(wrapperPath, 0o755);
      yield* fs.symlink(wrapperPath, binaryPath);

      const settings = yield* decodeCodexSettings({ binaryPath, homePath: prefix });
      const snapshot = yield* checkCodexProviderStatus(settings, undefined, {
        ...process.env,
        CODEX_HOME: prefix,
        HOME: prefix,
        NODE_PATH: "",
      });
      assert.deepStrictEqual(
        { installed: snapshot.installed, status: snapshot.status, version: snapshot.version },
        { installed: false, status: "error", version: null },
      );
      assert.include(snapshot.message, "Could not start Codex CLI");
    }).pipe(Effect.scoped),
  );
});

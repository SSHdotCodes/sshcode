import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  linkGrokHomeToMain,
  makeGrokContinuationGroupKey,
  makeGrokEnvironment,
  resolveGrokHomePath,
} from "./home.ts";

it.layer(NodeServices.layer)("Grok home", (it) => {
  it.effect(
    "resolves the setting before the environment and the default, expanding only the setting",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configured = path.resolve(NodeOS.homedir(), ".grok-second");
        expect(
          yield* resolveGrokHomePath({ homePath: " ~/.grok-second " }, { GROK_HOME: "/inherited" }),
        ).toBe(configured);
        expect(yield* resolveGrokHomePath({ homePath: "" }, { GROK_HOME: "/inherited" })).toBe(
          path.resolve("/inherited"),
        );
        expect(yield* resolveGrokHomePath({ homePath: "" }, {})).toBe(
          path.resolve(NodeOS.homedir(), ".grok"),
        );
        expect(yield* resolveGrokHomePath({ homePath: "" }, { GROK_HOME: "~/literal" })).toBe(
          path.resolve("~/literal"),
        );
        expect(
          yield* makeGrokEnvironment(
            { homePath: "~/.grok-second" },
            { GROK_HOME: "/inherited", HOME: "/keep", EXTRA: "value" },
          ),
        ).toEqual({ GROK_HOME: configured, HOME: "/keep", EXTRA: "value" });
      }),
  );

  it.effect(
    "links shared entries, keeps identities and runtime state separate, and repeats safely",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-linked-home-" });
        const main = path.join(root, "main");
        const second = path.join(root, "second");
        const shared = [
          "sessions",
          "config.toml",
          "skills",
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
        ];
        const privateEntries = [
          "auth.json",
          "auth.json.lock",
          "agent_id",
          "active_sessions.json",
          "active_sessions.lock",
          "logs",
          "models_cache.json",
          "settings_cache.json",
          "campaigns_state.json",
          "campaigns_state.json.lock",
          "downloads",
          "managed_config.lock",
          ".config-init.lock",
          "worktrees.db",
          "long-running-background-tasks",
          "grove",
          "relocations",
          "memtrace",
          "hooks",
          "hooks-paths",
          "bundled",
          "bundles",
          "memory-v2",
        ];
        yield* fs.makeDirectory(main);
        for (const entry of [...shared, ...privateEntries])
          yield* fs.makeDirectory(path.join(main, entry));
        yield* fs.writeFileString(path.join(main, "sessions", "chat.jsonl"), "chat");
        const config = { homePath: second, shareMainFolder: true };
        const environment = { GROK_HOME: main };
        yield* linkGrokHomeToMain({ ...config, shareMainFolder: false }, environment);
        yield* linkGrokHomeToMain({ homePath: "", shareMainFolder: true }, environment);
        yield* linkGrokHomeToMain({ homePath: main, shareMainFolder: true }, environment);
        expect(yield* fs.exists(second)).toBe(false);
        yield* linkGrokHomeToMain(config, environment);
        expect((yield* fs.readDirectory(second)).sort()).toEqual(shared.sort());
        expect(yield* fs.readFileString(path.join(second, "sessions", "chat.jsonl"))).toBe("chat");
        for (const entry of shared)
          expect(yield* fs.realPath(path.join(second, entry))).toBe(
            yield* fs.realPath(path.join(main, entry)),
          );
        // Preserve an existing file and even an existing dangling link.
        yield* fs.remove(path.join(second, "config.toml"));
        yield* fs.writeFileString(path.join(second, "config.toml"), "own config");
        yield* fs.symlink(path.join(root, "absent"), path.join(second, "agents"));
        yield* fs.makeDirectory(path.join(main, "agents"));
        yield* fs.makeDirectory(path.join(main, "rules"));
        yield* fs.writeFileString(path.join(second, "auth.json"), "synthetic second login");
        yield* linkGrokHomeToMain(config, environment);
        expect(yield* fs.readFileString(path.join(second, "config.toml"))).toBe("own config");
        expect(yield* fs.readLink(path.join(second, "agents"))).toBe(path.join(root, "absent"));
        expect(yield* fs.realPath(path.join(second, "rules"))).toBe(
          yield* fs.realPath(path.join(main, "rules")),
        );
        expect(yield* fs.readFileString(path.join(second, "auth.json"))).toBe(
          "synthetic second login",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "shares the source instance's continuation key through real sessions, preserving unlinked keys",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-continuation-" });
        const main = path.join(root, "main");
        const second = path.join(root, "second");
        const third = path.join(root, "third");
        yield* fs.makeDirectory(path.join(main, "sessions"), { recursive: true });
        yield* fs.makeDirectory(second);
        yield* fs.makeDirectory(third);
        yield* fs.symlink(
          path.relative(second, path.join(main, "sessions")),
          path.join(second, "sessions"),
        );
        yield* fs.symlink(path.join(second, "sessions"), path.join(third, "sessions"));
        const own = ProviderInstanceId.make("grok_grok_build");
        const added = ProviderInstanceId.make("grok_second");
        const instances = [
          { instanceId: added, homePath: second },
          { instanceId: own, homePath: main },
        ];
        const key = "grok:instance:grok_grok_build";
        expect(
          yield* makeGrokContinuationGroupKey({ instanceId: own, homePath: main, instances }),
        ).toBe(key);
        expect(
          yield* makeGrokContinuationGroupKey({ instanceId: added, homePath: second, instances }),
        ).toBe(key);
        expect(
          yield* makeGrokContinuationGroupKey({ instanceId: added, homePath: third, instances }),
        ).toBe(key);
        expect(
          yield* makeGrokContinuationGroupKey({
            instanceId: added,
            homePath: path.join(root, "unlinked"),
            instances,
          }),
        ).toBe("grok:instance:grok_second");
      }).pipe(Effect.scoped),
  );
});

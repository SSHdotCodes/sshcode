import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSignInCommand,
  claudeSignedOutMessage,
  linkClaudeHomeToMain,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then send your message again");
    });

    it("names the command that signs the instance's own Claude folder in again", () => {
      expect(claudeSignInCommand(undefined, "darwin")).toBe("claude auth login");
      expect(claudeSignInCommand("/Users/me/.claude-work", "darwin")).toBe(
        "CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login",
      );
      // Pasted into a shell, the folder stays one literal word.
      expect(claudeSignInCommand("/synthetic/Claude work's $literal", "linux")).toBe(
        "CLAUDE_CONFIG_DIR='/synthetic/Claude work'\\''s $literal' claude auth login",
      );
      expect(claudeSignInCommand("C:\\Users\\me\\.claude-work", "win32")).toBe(
        "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-work'; claude auth login",
      );
    });

    it.effect("links a second folder to the main one and continues its chats", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-linked-home-" });
        const main = path.join(root, "main");
        const linked = path.join(root, "second");
        yield* fileSystem.makeDirectory(path.join(main, "projects", "repo"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(main, "skills"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(main, "projects", "repo", "chat.jsonl"), "{}");
        yield* fileSystem.writeFileString(path.join(main, "settings.json"), "{}");
        // The main folder's identity and caches must never be linked.
        yield* fileSystem.writeFileString(path.join(main, ".claude.json"), "{}");
        yield* fileSystem.makeDirectory(path.join(main, "cache"), { recursive: true });
        const environment = { CLAUDE_CONFIG_DIR: main };
        const config = { homePath: linked, shareMainFolder: true };

        // Off, or without a folder of its own: nothing is made.
        yield* linkClaudeHomeToMain({ homePath: linked, shareMainFolder: false }, environment);
        yield* linkClaudeHomeToMain({ homePath: "", shareMainFolder: true }, environment);
        expect(yield* fileSystem.exists(linked)).toBe(false);
        expect(yield* makeClaudeContinuationGroupKey(config, environment)).toBe(
          `claude:home:${linked}`,
        );

        yield* linkClaudeHomeToMain(config, environment);
        expect((yield* fileSystem.readDirectory(linked)).toSorted()).toEqual([
          "projects",
          "settings.json",
          "skills",
        ]);
        expect(
          yield* fileSystem.readFileString(path.join(linked, "projects", "repo", "chat.jsonl")),
        ).toBe("{}");
        // Same chats, so a chat may move between the two providers.
        const mainKey = yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment);
        expect(mainKey).toBe(`claude:home:${main}`);
        expect(yield* makeClaudeContinuationGroupKey(config, environment)).toBe(mainKey);

        // A later start links what the main folder gained and keeps the rest.
        yield* fileSystem.writeFileString(path.join(linked, ".claude.json"), '{"own":true}');
        yield* fileSystem.makeDirectory(path.join(main, "plugins"), { recursive: true });
        yield* linkClaudeHomeToMain(config, environment);
        expect((yield* fileSystem.readDirectory(linked)).toSorted()).toEqual([
          ".claude.json",
          "plugins",
          "projects",
          "settings.json",
          "skills",
        ]);
        expect(yield* fileSystem.readFileString(path.join(linked, ".claude.json"))).toBe(
          '{"own":true}',
        );
      }).pipe(Effect.scoped),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-home-link-" }),
        );
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        const direct = yield* makeClaudeContinuationGroupKey({ homePath: target });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: link })).toBe(direct);
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath: "" }, { CLAUDE_CONFIG_DIR: link }),
        ).toBe(direct);
        expect((yield* makeClaudeEnvironment({ homePath: link })).CLAUDE_CONFIG_DIR).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});

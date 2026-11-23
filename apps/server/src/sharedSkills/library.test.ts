// @effect-diagnostics nodeBuiltinImport:off - These tests drive git and the filesystem directly.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  appendCodexSharedSkillDisable,
  applySharedSkillsCommand,
  codexLaunchArgsWithSharedSkills,
  providerUsesSharedSkills,
  readLibrary,
} from "./library.ts";
import { useTempDirs } from "@t3tools/shared/testing/tempDirs";

const makeTempDir = useTempDirs();

const writeSkill = (directory: string, name: string, description: string, body = "# Body\n") => {
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
};

const git = (args: readonly string[], cwd: string) => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || `git ${args.join(" ")} failed`);
  }
};

describe("shared skills library", () => {
  it.effect("reads name and description, and sets a corrupt state file aside", () =>
    Effect.sync(() => {
      const root = makeTempDir("sshcode-skills-");
      const home = NodePath.join(root, "home");
      const state = NodePath.join(root, "state");
      writeSkill(NodePath.join(home, ".agents", "skills", "nova"), "nova", "Run work on Nova");
      writeSkill(NodePath.join(home, ".agents", "skills", "local"), "local", "Local notes");
      NodeFS.mkdirSync(state, { recursive: true });
      const stateFile = NodePath.join(state, "shared-skills.json");
      NodeFS.writeFileSync(stateFile, "{broken");
      NodeFS.writeFileSync(`${stateFile}.unreadable`, "first recovery");
      const list = readLibrary(home, state);
      expect(list.skills.map((skill) => skill.name)).toEqual(["local", "nova"]);
      expect(list.skills[0]?.description).toBe("Local notes");
      expect(list.skills.every((skill) => skill.enabled)).toBe(true);
      expect(NodeFS.existsSync(stateFile)).toBe(false);
      expect(NodeFS.readFileSync(`${stateFile}.unreadable`, "utf8")).toBe("first recovery");
      expect(NodeFS.readFileSync(`${stateFile}.unreadable.1`, "utf8")).toBe("{broken");
    }),
  );

  it.effect("adds, turns off, updates, and removes only skills this section installed", () =>
    Effect.gen(function* () {
      const root = makeTempDir("sshcode-skills-");
      const home = NodePath.join(root, "home");
      const state = NodePath.join(root, "state");
      const source = NodePath.join(root, "source", "review");
      writeSkill(source, "review", "Review a change");
      writeSkill(NodePath.join(home, ".agents", "skills", "kept"), "kept", "Already here");

      const added = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "addFolder", path: source },
        }),
      );
      const review = added.skills.find((skill) => skill.name === "review");
      expect(review).toMatchObject({
        source: "folder",
        canRemove: true,
        origin: source,
        enabled: true,
      });
      expect(added.skills.find((skill) => skill.name === "kept")?.canRemove).toBe(false);

      const off = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "setSharing", name: "review", enabled: false },
        }),
      );
      expect(off.skills.find((skill) => skill.name === "review")?.enabled).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(home, ".agents", "skills", "review", "SKILL.md")),
      ).toBe(true);

      const repo = NodePath.join(root, "repo");
      writeSkill(repo, "from-git", "From git");
      git(["init", "-b", "main"], repo);
      git(["add", "SKILL.md"], repo);
      git(["commit", "-m", "skill"], repo);
      const cloned = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "addGit", url: repo },
        }),
      );
      expect(cloned.skills.find((skill) => skill.name === "from-git")?.canUpdate).toBe(true);
      NodeFS.writeFileSync(
        NodePath.join(repo, "SKILL.md"),
        "---\nname: from-git\ndescription: Updated git\n---\n# Body\n",
      );
      git(["add", "SKILL.md"], repo);
      git(["commit", "-m", "update"], repo);
      const updated = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "update", name: "from-git" },
        }),
      );
      expect(updated.skills.find((skill) => skill.name === "from-git")?.description).toBe(
        "Updated git",
      );

      const removed = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "remove", name: "review" },
        }),
      );
      expect(removed.skills.some((skill) => skill.name === "review")).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(home, ".agents", "skills", "kept", "SKILL.md"))).toBe(
        true,
      );
      const refused = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "remove", name: "kept" },
        }).then(
          () => "removed",
          (error: Error) => error.message,
        ),
      );
      expect(refused).toBe("That skill is managed elsewhere.");

      const outside = NodePath.join(root, "outside-repo");
      const holding = NodePath.join(state, "shared-skill-repos", "bundle");
      NodeFS.mkdirSync(outside, { recursive: true });
      NodeFS.mkdirSync(holding, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(outside, "keep"), "yes");
      NodeFS.writeFileSync(NodePath.join(holding, "keep"), "yes");
      writeSkill(NodePath.join(home, ".agents", "skills", "bundled"), "bundled", "From a repo");
      writeSkill(NodePath.join(home, ".agents", "skills", "elsewhere-git"), "elsewhere-git", "No");
      NodeFS.writeFileSync(
        NodePath.join(state, "shared-skills.json"),
        JSON.stringify({
          version: 1,
          disabled: [],
          managed: {
            bundled: {
              source: "git",
              url: "https://example.com/bundle.git",
              repo: holding,
              child: "bundled",
            },
            "elsewhere-git": {
              source: "git",
              url: "https://example.com/outside.git",
              repo: outside,
            },
          },
        }),
      );
      const removedHolding = yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "remove", name: "bundled" },
        }),
      );
      expect(removedHolding.skills.some((skill) => skill.name === "bundled")).toBe(false);
      expect(NodeFS.existsSync(holding)).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(outside, "keep"))).toBe(true);
      yield* Effect.promise(() =>
        applySharedSkillsCommand({
          homeDir: home,
          stateDir: state,
          command: { type: "remove", name: "elsewhere-git" },
        }),
      );
      expect(NodeFS.existsSync(NodePath.join(outside, "keep"))).toBe(true);
    }),
  );

  it.effect(
    "hides a disabled library skill from Codex without touching an existing skills.config",
    () =>
      Effect.sync(() => {
        const flag = appendCodexSharedSkillDisable("", ["/skills/nova/SKILL.md"]);
        expect(flag).toBe(`-c 'skills.config=[{path="/skills/nova/SKILL.md",enabled=false}]'`);
        expect(
          appendCodexSharedSkillDisable("-c 'skills.config=[]'", ["/skills/nova/SKILL.md"]),
        ).toBe("-c 'skills.config=[]'");
        const root = makeTempDir("sshcode-skills-");
        const home = NodePath.join(root, "home");
        const state = NodePath.join(root, "state");
        writeSkill(NodePath.join(home, ".agents", "skills", "quiet"), "quiet", "Hidden");
        NodeFS.mkdirSync(state, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(state, "shared-skills.json"),
          JSON.stringify({ version: 1, disabled: ["quiet"], managed: {} }),
        );
        const skillFile = NodePath.join(home, ".agents", "skills", "quiet", "SKILL.md");
        const launched = codexLaunchArgsWithSharedSkills(
          undefined,
          {},
          home,
          state,
          () => "app-server",
        );
        expect(launched.startsWith("app-server ")).toBe(true);
        expect(launched).toContain(`path="${skillFile}"`);
        expect(launched).toContain("enabled=false");
        expect(
          codexLaunchArgsWithSharedSkills(
            "-c 'skills.config=[]'",
            {},
            home,
            state,
            (args) => args ?? "",
          ),
        ).toBe("-c 'skills.config=[]'");
        expect(providerUsesSharedSkills({ driver: "claudeAgent" })).toBe(true);
        expect(providerUsesSharedSkills({ driver: "acpRegistry" }, "kimi")).toBe(true);
        expect(providerUsesSharedSkills({ driver: "acpRegistry", badgeLabel: "Vibe" })).toBe(true);
        expect(providerUsesSharedSkills({ driver: "acpRegistry" }, "mock-agent")).toBe(false);
        expect(providerUsesSharedSkills({ driver: "acpRegistry" }, "revival")).toBe(false);
        expect(providerUsesSharedSkills({ driver: "muse" })).toBe(false);
      }),
  );
});

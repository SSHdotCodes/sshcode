import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { prepareClaudeSharedSkillsDirectory } from "./claudePlugins.ts";

describe("Claude shared skills", () => {
  it.effect("links enabled skills by their plain name and leaves native skills alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "home");
      const state = path.join(root, "state");
      const claudeHome = path.join(home, ".claude");
      const library = path.join(home, ".agents", "skills");
      const prepare = (environment: NodeJS.ProcessEnv) =>
        prepareClaudeSharedSkillsDirectory({
          homeDir: home,
          stateDir: state,
          cwd: path.join(root, "workspace"),
          settings: { homePath: claudeHome },
          environment,
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      expect(yield* prepare({ HOME: home })).toBeUndefined();

      yield* fs.makeDirectory(path.join(claudeHome, "skills", "studio"), { recursive: true });
      yield* fs.writeFileString(
        path.join(claudeHome, "skills", "studio", "SKILL.md"),
        "---\nname: other\ndescription: Native\n---\n",
      );
      for (const name of ["studio", "local", "quiet"]) {
        const dir = path.join(library, name);
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name}\n---\n`,
        );
      }
      const skillsDir = path.join(state, "shared-skills-claude", ".claude", "skills");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.makeDirectory(path.join(skillsDir, "kept-real"), { recursive: true });
      yield* fs.symlink(path.join(library, "quiet"), path.join(skillsDir, "quiet"));
      yield* fs.symlink(path.join(root, "foreign"), path.join(skillsDir, "foreign"));
      yield* fs.makeDirectory(state, { recursive: true });
      yield* fs.writeFileString(
        path.join(state, "shared-skills.json"),
        JSON.stringify({ version: 1, disabled: ["quiet"], managed: {} }),
      );

      const granted = yield* prepare({ HOME: home, CLAUDE_CONFIG_DIR: claudeHome });
      expect(granted).toBe(path.join(state, "shared-skills-claude"));
      const link = path.join(skillsDir, "local");
      expect(yield* fs.readLink(link)).toBe(path.join(library, "local"));
      expect(yield* fs.exists(path.join(skillsDir, "studio"))).toBe(false);
      expect(yield* fs.exists(path.join(skillsDir, "quiet"))).toBe(false);
      expect(yield* fs.exists(path.join(skillsDir, "kept-real"))).toBe(true);
      expect(yield* fs.readLink(path.join(skillsDir, "foreign"))).toBe(path.join(root, "foreign"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

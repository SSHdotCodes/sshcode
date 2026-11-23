import type { ClaudeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { readLibrary, syncClaudeSharedSkillDirectory } from "./library.ts";

/**
 * Link enabled library skills Claude does not already have, and return the
 * directory to pass as `additionalDirectories`. An empty library skips
 * Claude's own skill directories.
 */
export const prepareClaudeSharedSkillsDirectory = Effect.fn("prepareClaudeSharedSkillsDirectory")(
  function* (input: {
    readonly homeDir: string;
    readonly stateDir: string;
    readonly cwd: string | null;
    readonly settings: Pick<ClaudeSettings, "homePath">;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
    const skills = readLibrary(input.homeDir, input.stateDir).skills;
    const nativeNames = new Set<string>();
    if (skills.some((skill) => skill.enabled)) {
      const native = yield* discoverClaudeSkills(
        input.settings,
        input.cwd ?? undefined,
        input.environment,
      );
      for (const skill of native) nativeNames.add(skill.name.trim().toLowerCase());
    }
    const platform = yield* HostProcess.Platform;
    return syncClaudeSharedSkillDirectory({
      homeDir: input.homeDir,
      stateDir: input.stateDir,
      nativeNames,
      platform,
    });
  },
);

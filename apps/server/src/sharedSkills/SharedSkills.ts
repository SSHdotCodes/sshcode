import {
  SharedSkillsError,
  type SharedSkillsCommand,
  type SharedSkillsList,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { applySharedSkillsCommand, readLibrary } from "./library.ts";

export class SharedSkills extends Context.Service<
  SharedSkills,
  {
    readonly list: Effect.Effect<SharedSkillsList, SharedSkillsError>;
    readonly command: (
      command: SharedSkillsCommand,
    ) => Effect.Effect<SharedSkillsList, SharedSkillsError>;
  }
>()("t3/sharedSkills/SharedSkills") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const homeDir = yield* HostProcess.HomeDirectory;
  const list = Effect.sync(() => readLibrary(homeDir, config.stateDir));
  const command = Effect.fn("SharedSkills.command")(function* (input: SharedSkillsCommand) {
    return yield* Effect.tryPromise({
      try: () => applySharedSkillsCommand({ homeDir, stateDir: config.stateDir, command: input }),
      catch: (cause) =>
        new SharedSkillsError({
          message: cause instanceof Error ? cause.message : "Could not update skills.",
        }),
    });
  });
  return SharedSkills.of({ list, command });
});

export const layer = Layer.effect(SharedSkills, make);

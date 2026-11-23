import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return stripServerCredentials(baseEnv);
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return stripServerCredentials(next);
});

/** Keep explicit tombstones so spawn APIs with extendEnv cannot restore server credentials. */
const stripServerCredentials = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...environment };
  for (const name of new Set([
    "T3CODE_DEV_AUTH_TOKEN",
    ...Object.keys(process.env),
    ...Object.keys(next),
  ])) {
    if (/^T3CODE_.*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)$/i.test(name)) {
      next[name] = undefined;
    }
  }
  return next;
};

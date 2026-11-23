import { createClaudeRcEnvironmentAtoms } from "@t3tools/client-runtime/claude-rc";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeRcEnvironment = createClaudeRcEnvironmentAtoms(connectionAtomRuntime);

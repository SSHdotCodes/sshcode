import { createSubagentRankingsAtoms } from "@t3tools/client-runtime/state/subagent-rankings";
import { createModelRankingsEditorState } from "@t3tools/client-runtime/model-rankings";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createAgentToolsAtoms } from "@t3tools/client-runtime/agent-tools";
import { createComputerUseAtoms } from "@t3tools/client-runtime/state/computer-use";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  chatTabs: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
  compactProviders: true,
});
export const agentToolsEnvironment = createAgentToolsAtoms(connectionAtomRuntime, {
  settingsValueAtom: serverEnvironment.settingsValueAtom,
});
export const computerUseEnvironment = createComputerUseAtoms(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const modelRankingsEnvironment = createModelRankingsEditorState(serverEnvironment);

export const subagentRankingsEnvironment = createSubagentRankingsAtoms(connectionAtomRuntime);

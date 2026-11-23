// @effect-diagnostics nodeBuiltinImport:off - test artifact writer, never part of the server runtime.
import * as Context from "effect/Context";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Test-only observer of actual adapter output, before replay wildcards match it. */
export const AgentQualityObserver = Context.Reference<(frame: unknown) => void>(
  "t3/testkit/AgentQualityObserver",
  { defaultValue: () => () => {} },
);

/** The report CLI supplies a fresh temporary directory; ordinary test runs write nothing. */
export async function writeAgentQualityArtifact(name: string, value: unknown) {
  const directory = process.env.T3_AGENT_QUALITY_DIR;
  if (directory === undefined) return;
  await NodeFSP.writeFile(NodePath.join(directory, `${name}.json`), JSON.stringify(value));
}

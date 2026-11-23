import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
export const ClaudeHistoryOptions = Schema.Struct({
  dir: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(Schema.String),
  includeSystemMessages: Schema.optionalKey(Schema.Boolean),
  upToMessageId: Schema.optionalKey(Schema.String),
});
const decodeHistoryOptions = Schema.decodeSync(Schema.fromJsonString(ClaudeHistoryOptions));

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  let result: unknown;
  switch (method) {
    case "getSessionMessages":
      result = await getSessionMessages(sessionId, options);
      break;
    case "forkSession":
      result = await forkSession(sessionId, options);
      break;
    case "subagentLaunchToolUseId": {
      if (!options.agentId) throw new Error("Claude subagent id is required.");
      const messages = await getSubagentMessages(sessionId, options.agentId, {
        ...(options.dir === undefined ? {} : { dir: options.dir }),
        limit: 1,
      });
      result = messages[0]?.parent_tool_use_id ?? null;
      break;
    }
    default:
      throw new Error("Unknown Claude history operation.");
  }
  process.stdout.write(JSON.stringify(result));
}

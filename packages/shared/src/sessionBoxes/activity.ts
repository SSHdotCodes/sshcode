import { commandLine } from "./command.ts";
import type { HashedLinearModel } from "./model.ts";
import { hashedLinearPredict } from "./model.ts";
import type { SessionBoxActivity } from "./taxonomy.ts";
import { featureWords } from "./text.ts";

/** Trained command classifier, installed by `./models.ts` when present. */
export const sessionBoxActivityModels: { command: HashedLinearModel | null } = { command: null };

/**
 * The agent's current step as the server summarizes it for lists: the turn item's type
 * and a short detail (a command line, a tool name, a file name or a search query).
 */
export interface SessionBoxActivityInput {
  readonly itemType: string;
  readonly detail: string | null;
}

const COMMAND_RULES: ReadonlyArray<readonly [SessionBoxActivity, RegExp]> = [
  ["remote", /^(ssh|scp|rsync|mosh|boat|sprite|modal (run|deploy|shell)|kubectl|fly )/],
  ["gpu", /\b(nvidia-smi|nvcc|torchrun|accelerate launch|vllm|ai-job|modelctl|cuda)\b/],
  [
    "installing",
    /\b((npm|pnpm|yarn|bun) (i|install|add)|pip3? install|uv (pip|add|sync)|brew install|apt(-get)? install|cargo install|pod install|gem install)\b/,
  ],
  [
    "testing",
    /\b(test|tests|vitest|jest|pytest|vp test|go test|cargo test|xctest|playwright test|spec)\b/,
  ],
  [
    "building",
    /\b(build|tsc|typecheck|tsc-rs|compile|xcodebuild|make|cmake|cargo build|webpack|vite build|bundle|lint|fmt|eslint|oxlint|prettier)\b/,
  ],
  ["git", /^(git|gh) /],
  ["searching", /^(rg|grep|ag|ack|find|fd|locate|mdfind|git grep)\b/],
  [
    "reading",
    /^(cat|head|tail|sed -n|less|bat|nl|wc|ls|tree|stat|file|jq|sqlite3 -readonly|xxd|du|df)\b/,
  ],
  ["browsing", /^(curl|wget|http|lynx)\b/],
  [
    "running",
    /\b(node|python3?|bun|deno|npx|uvx|bash|sh|zsh|go run|cargo run|open|osascript|docker|swift)\b/,
  ],
];

/** Features for the command classifier: the first words weigh most, then the rest. */
export function commandFeatures(command: string): string[] {
  const line = command.trim().replace(/^(cd [^&;]+(&&|;)\s*)+/, "");
  const words = featureWords(line).slice(0, 24);
  const features = ["bias"];
  if (words[0]) features.push(`w0=${words[0]}`);
  if (words[1]) features.push(`w01=${words[0]}|${words[1]}`);
  for (const word of words) features.push(`w=${word}`);
  for (const pipe of line.split(/\||&&|;/).slice(1, 4)) {
    const head = featureWords(pipe)[0];
    if (head) features.push(`pipe=${head}`);
  }
  return features;
}

function ruleCommandActivity(command: string): SessionBoxActivity | null {
  const line = command
    .trim()
    .replace(/^(cd [^&;]+(&&|;)\s*)+/, "")
    .replace(/^(env (-\S+ )*(\w+=\S+ )*|timeout \d+ |sudo )+/, "")
    .toLowerCase();
  for (const [activity, pattern] of COMMAND_RULES) if (pattern.test(line)) return activity;
  return null;
}

/**
 * Commands whose first words name the step outright. A test runner or package install
 * reads the same in every history, but one that is rare in the training history (a bare
 * `pnpm vitest run` where most runs were `vp test`) can otherwise read as "running".
 */
const PLAIN_COMMANDS: ReadonlyArray<readonly [SessionBoxActivity, RegExp]> = [
  [
    "testing",
    /^((npx|pnpm|yarn|bunx?|uv run|poetry run) (exec )?)?(vitest|jest|pytest|vp test|go test|cargo test|playwright test|swift test)\b|^(npm|pnpm|yarn|bun) (run )?test\b/,
  ],
  [
    "installing",
    /^((npm|pnpm|yarn|bun) (i|install|add)|pip3? install|uv (pip install|add|sync)|brew install|apt(-get)? install|cargo install|pod install|gem install)\b/,
  ],
];

export function commandActivity(command: string): SessionBoxActivity {
  const plain = command.trim().toLowerCase();
  for (const [activity, pattern] of PLAIN_COMMANDS) if (pattern.test(plain)) return activity;
  const model = sessionBoxActivityModels.command;
  if (model) {
    const prediction = hashedLinearPredict<SessionBoxActivity>(model, commandFeatures(command));
    if (prediction.probability >= 0.35) return prediction.label;
  }
  return ruleCommandActivity(command) ?? "running";
}

const TOOL_RULES: ReadonlyArray<readonly [SessionBoxActivity, RegExp]> = [
  ["delegating", /(delegate|subagent|task_status|spawn|agent\b|create_threads|thread_send)/i],
  ["waiting", /(monitor|wait|sleep|schedule)/i],
  ["browsing", /(web|fetch|browser|search_web|url|http|chrome|playwright|navigate)/i],
  ["searching", /(search|grep|glob|find|query)/i],
  ["reading", /(read|view|list|get|open|inspect|screenshot|status)/i],
  ["editing", /(write|edit|patch|update|create|apply|replace|insert)/i],
  ["remote", /(ssh|device|deploy|cloud)/i],
];

/** What a list shows for the agent's current step. */
export function sessionBoxActivity(input: SessionBoxActivityInput): SessionBoxActivity {
  const detail = input.detail ?? "";
  switch (input.itemType) {
    case "command_execution":
      return detail ? commandActivity(commandLine(detail)) : "running";
    case "file_change":
      return "editing";
    case "file_search":
      return "searching";
    case "web_search":
      return "browsing";
    case "reasoning":
      return "thinking";
    case "assistant_message":
      return "replying";
    case "subagent":
      return "delegating";
    case "compaction":
      return "thinking";
    case "dynamic_tool":
    case "mcp_tool_call": {
      for (const [activity, pattern] of TOOL_RULES) if (pattern.test(detail)) return activity;
      return "running";
    }
    default:
      return "thinking";
  }
}

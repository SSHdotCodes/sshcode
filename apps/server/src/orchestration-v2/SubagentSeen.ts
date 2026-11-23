import type {
  OrchestrationV2Run,
  OrchestrationV2SubagentSeen,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/** Turn item types the seen block reads. */
export const SEEN_TURN_ITEM_TYPES = ["command_execution", "file_change"] as const;

const CHECK_COMMAND =
  /^(?:vp\s+test|vitest|jest|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|tsc(?:-rs)?|cargo\s+test|(?:python3?\s+-m\s+)?pytest|go\s+test|xcodebuild\s+test|(?:(?:bash|zsh|sh)\s+)?(?:[\w./-]+\/)?(?:self)?tests?\.sh)(?=\s|$|[;&|<>])/u;
const MAX_FAILING = 3;
const MAX_COMMAND_CHARS = 80;
const MAX_COMMITS = 5;
/** The whole block stays small: every lead reads it on every finished task. */
const MAX_SEEN_CHARS = 400;

/** The command a person would recognise: no shell wrapper, no leading `cd dir &&`. */
function unwrapCommand(input: string): string {
  let text = input.trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/u.exec(text);
  if (wrapped !== null) text = wrapped[2]!.trim();
  return text.replace(/^cd\s+(?:[\w./~@:+-]+|"[^"\n]*"|'[^'\n]*')\s*&&\s*/u, "").trimStart();
}

export function shortCommand(input: string): string {
  const text = unwrapCommand(input).replace(/\s+/gu, " ");
  return text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}…` : text;
}

/** Only recognize a check in executable position, after common launch wrappers. */
function invokesCheck(command: string): boolean {
  const invocation = command
    .trimStart()
    .replace(/^env\s+(?:(?:-u|--unset)\s+[A-Za-z_]\w*\s+)*/u, "")
    .replace(/^(?:[A-Za-z_]\w*=[\w./:@+${}-]*\s+)+/u, "")
    .replace(/^(?:(?:pnpm|npm|yarn|bun)\s+exec\s+|npx\s+)/u, "")
    .replace(/^(?:[\w./@+-]*\/)?node_modules\/\.bin\//u, "");
  return CHECK_COMMAND.test(invocation);
}

function commandFailed(item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>) {
  // Claude reports no exit code; its failed status stands in for one.
  return item.exitCode === undefined ? item.status === "failed" : item.exitCode !== 0;
}

/**
 * A pipe or a following command gives the line the exit code of whatever ran last
 * (`tsc | tail` passes when tsc fails), so such a check ran but its result is not the app's to state.
 */
const EXIT_CODE_NOT_ITS_OWN = /[|;\n]|(?<![&<>])&(?!&)/u;

function checkPassed(
  item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
): boolean | undefined {
  const invocation = unwrapCommand(item.input);
  if (EXIT_CODE_NOT_ITS_OWN.test(invocation) || !invocation.split("&&").every(invokesCheck))
    return undefined;
  if (item.exitCode === undefined && item.status !== "completed" && item.status !== "failed")
    return undefined;
  return !commandFailed(item);
}

/**
 * The facts a lead can trust about a finished subagent, computed from what the app recorded
 * (turn items, Git), never from the subagent's own words. Undefined when nothing was seen.
 */
export function subagentSeen(input: {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly commits: ReadonlyArray<string>;
  readonly seconds: number | null;
}): OrchestrationV2SubagentSeen | undefined {
  const commands = input.turnItems.flatMap((item) =>
    item.type === "command_execution" &&
    item.monitor !== true &&
    item.status !== "pending" &&
    item.status !== "running" &&
    item.status !== "waiting"
      ? [item]
      : [],
  );
  const failing = commands.filter(commandFailed);
  const checks = commands.filter((item) => invokesCheck(unwrapCommand(item.input)));
  const lastCheck = checks[checks.length - 1];
  const files = new Set<string>();
  for (const item of input.turnItems) {
    if (item.type !== "file_change" || item.status === "failed" || item.status === "cancelled")
      continue;
    if (item.changes !== undefined && item.changes.length > 0)
      for (const change of item.changes) files.add(change.path);
    else files.add(item.fileName);
  }
  const commits = input.commits.slice(0, MAX_COMMITS);
  const seconds = input.seconds === null ? 0 : Math.max(0, Math.round(input.seconds));
  const seen: OrchestrationV2SubagentSeen = {
    ...(commands.length > 0 ? { commands: commands.length } : {}),
    ...(failing.length > 0
      ? {
          failed: failing.length,
          failing: failing.slice(-MAX_FAILING).map((item) => shortCommand(item.input)),
        }
      : {}),
    ...(lastCheck === undefined
      ? {}
      : (() => {
          const passed = checkPassed(lastCheck);
          return {
            check: {
              command: shortCommand(lastCheck.input),
              ...(passed === undefined ? {} : { passed }),
            },
          };
        })()),
    ...(files.size > 0 ? { files: files.size } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(seconds > 0 ? { seconds } : {}),
  };
  if (Object.keys(seen).length === 0) return undefined;
  // Command lines are the only long parts; drop them before the counts if the cap is hit.
  if (JSON.stringify(seen).length <= MAX_SEEN_CHARS) return seen;
  const { failing: _failing, ...withoutFailing } = seen;
  if (JSON.stringify(withoutFailing).length <= MAX_SEEN_CHARS) return withoutFailing;
  const { check: _check, ...counts } = withoutFailing;
  return counts;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const compactTime = (seconds: number) =>
  seconds < 90
    ? `${seconds}s`
    : seconds < 5400
      ? `${Math.round(seconds / 60)}m`
      : `${Math.round(seconds / 360) / 10}h`;

/**
 * The seen block as one line for the lead's completion message, so it reads the app's facts
 * beside the subagent's own report without another tool call. Fewest words: every lead pays
 * for it on every finished task.
 */
export function seenLineForLead(seen: OrchestrationV2SubagentSeen): string {
  const check = seen.check;
  const parts = [
    check === undefined
      ? null
      : `${check.passed === undefined ? "check ran, result unseen" : check.passed ? "check passed" : "check FAILED"}: ${check.command}`,
    // A nonzero exit can mean a normal probe found nothing. Report the check's outcome above.
    seen.commands === undefined ? null : count(seen.commands, "command"),
    seen.files === undefined ? null : count(seen.files, "file"),
    seen.commits === undefined
      ? null
      : `${seen.commits.length === 1 ? "commit" : "commits"} ${seen.commits.join(" ")}`,
    seen.seconds === undefined ? null : compactTime(seen.seconds),
  ].filter((part): part is string => part !== null);
  return `App saw: ${parts.join("; ")}`;
}

/** A child sharing an existing path has no way to distinguish its commits from its siblings'. */
export function ownSubagentCheckout(
  path: string | null,
  parentPath: string | null,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "workspacePreparation">>,
) {
  const latest = runs.findLast((run) => run.workspacePreparation !== undefined);
  return path !== parentPath && latest?.workspacePreparation?.type === "worktree" ? path : null;
}

/** `git log` arguments for short ids of commits made since `sinceMs`, newest first. */
export function commitsSinceArgs(sinceMs: number): ReadonlyArray<string> {
  return [
    "log",
    `--since=@${Math.floor(sinceMs / 1000)}`,
    `--max-count=${MAX_COMMITS}`,
    "--format=%h",
    "HEAD",
  ];
}

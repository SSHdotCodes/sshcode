/**
 * Variables a Claude Code agent session sets for the processes it starts.
 * Anything launched from inside an agent inherits them, and so does whatever
 * that launches in turn: a Terminal opened from there gives every new window
 * these markers, and a `claude` started in one reports itself to Remote
 * Control as an SDK session and stops saving its transcript. SSHCode is never
 * an agent's child, so it drops them from its own environment.
 */
export const INHERITED_AGENT_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

/** Removes the markers in place; user settings such as `CLAUDE_CONFIG_DIR` stay. */
export function dropInheritedAgentSessionMarkers(env: NodeJS.ProcessEnv): void {
  for (const name of INHERITED_AGENT_SESSION_MARKERS) delete env[name];
}

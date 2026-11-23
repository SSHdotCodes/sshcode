import type * as Acp from "effect-acp/compat";
import { unknownRecord } from "./clientPolicy.ts";

type ToolUpdate = Extract<
  Acp.SessionNotification["update"],
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

/** Owns the client terminals created during one turn until their tool calls finish. */
export function makeRunningToolCalls() {
  const calls = new Map<string, { sessionId: string; command?: string }>();
  const terminals = new Map<
    string,
    { sessionId: string; commands: readonly string[]; owner?: string }
  >();

  function match(sessionId: string, commands: readonly string[]) {
    const candidates = [...calls].filter(([, call]) => call.sessionId === sessionId);
    const exact = candidates.filter(
      ([, call]) => call.command !== undefined && commands.includes(call.command),
    );
    if (exact.length === 1) return exact[0]![0];
    if (candidates.length === 1 && candidates[0]![1].command === undefined)
      return candidates[0]![0];
    return undefined;
  }

  return {
    created(sessionId: string, terminalId: string, command: string, args: readonly string[] = []) {
      const commands = [[command, ...args].join(" ")];
      // The tool may report shell source while terminal/create supplies the shell and argv.
      if (
        /(?:^|\/)(?:sh|bash|dash|zsh|ksh)$/.test(command) &&
        /^-[a-z]*c[a-z]*$/.test(args[0] ?? "") &&
        args[1] !== undefined
      )
        commands.push(args[1]);
      const owner = match(sessionId, commands);
      terminals.set(terminalId, { sessionId, commands, ...(owner === undefined ? {} : { owner }) });
    },
    track(sessionId: string, update: ToolUpdate) {
      const key = JSON.stringify([sessionId, update.toolCallId]);
      const command = unknownRecord(update.rawInput)?.command;
      if (update.kind === "execute" || typeof command === "string") {
        calls.set(key, {
          ...calls.get(key),
          sessionId,
          ...(typeof command === "string" ? { command } : {}),
        });
      }
      for (const [id, terminal] of terminals) {
        if (terminal.sessionId !== sessionId) continue;
        if (update.content?.some((entry) => entry.type === "terminal" && entry.terminalId === id)) {
          terminal.owner = key;
        } else if (terminal.owner === undefined && match(sessionId, terminal.commands) === key) {
          terminal.owner = key;
        }
        if (
          terminal.owner === key &&
          (update.status === "completed" || update.status === "failed")
        ) {
          terminals.delete(id);
        }
      }
      if (update.status === "completed" || update.status === "failed") calls.delete(key);
    },
    released(terminalId: string) {
      terminals.delete(terminalId);
    },
    foreground() {
      return Array.from(terminals, ([terminalId, { sessionId }]) => ({ sessionId, terminalId }));
    },
  };
}

/**
 * The command a person would recognize inside what agents actually run: Codex wraps each
 * command in `/bin/zsh -lc "…"`, and agents prefix `cd …&&`, env assignments or timeouts.
 */
export function commandLine(command: string): string {
  let line = command.trim();
  for (let pass = 0; pass < 3; pass++) {
    const wrapped = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(line);
    if (wrapped) line = wrapped[2]!.trim();
    line = line
      .replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "")
      .replace(/^(?:(?:env\s+(?:-\S+\s+)*)?(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+)/, "")
      .replace(/^(?:(?:timeout\s+\S+|sudo|nice|time|command)\s+)+/, "")
      .trim();
    if (!wrapped) break;
  }
  return line;
}

/**
 * Skills read the way Claude Code and Codex show them: the skill's own name
 * as a slash command. The composer still inserts `$name`, which both
 * harnesses dispatch from anywhere in a message.
 */
export function skillCommandLabel(skill: { readonly name: string }): string {
  return `/${skill.name}`;
}

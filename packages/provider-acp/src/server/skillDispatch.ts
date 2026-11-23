import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";

/**
 * Skill names an ACP agent lists beside its commands. Qwen Code sends them as
 * `_meta.availableSkills` on `available_commands_update`; agents that don't
 * get an empty set, so nothing is rewritten for them.
 */
export function acpAdvertisedSkillNames(meta: unknown): ReadonlySet<string> {
  const names =
    typeof meta === "object" && meta !== null && "availableSkills" in meta
      ? (meta as { availableSkills?: unknown }).availableSkills
      : undefined;
  return new Set(
    Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string" && name.length > 0)
      : [],
  );
}

/** `/name` typed by hand mid-prompt, as in Claude Code. */
const SLASH_MENTION_PATTERN = /(^|\s)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/**
 * Such agents run a skill only as a slash command opening the prompt. The
 * composer writes `$name` anywhere in a message, and people type `/name`
 * mid-sentence; move the first known skill to the front as `/name`, keep the
 * rest of the text as its arguments, and rewrite other mentions to `/name` so
 * the model can still start them. Unknown names stay literal (`$HOME`,
 * `/usr`), and a prompt that already opens with a slash is left alone.
 */
export function dispatchAcpSkillMention(prompt: string, skills: ReadonlySet<string>): string {
  if (skills.size === 0 || prompt.trimStart().startsWith("/")) return prompt;
  const mentions = [
    ...prompt.matchAll(SKILL_MENTION_PATTERN),
    ...prompt.matchAll(SLASH_MENTION_PATTERN),
  ]
    .flatMap((match) => {
      const name = match[2] ?? "";
      if (!skills.has(name)) return [];
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      return [{ name, start, end: (match.index ?? 0) + match[0].length }];
    })
    .sort((a, b) => a.start - b.start);
  const first = mentions[0];
  if (!first) return prompt;
  let rest = prompt;
  for (const mention of mentions.toReversed()) {
    const before = rest.slice(0, mention.start);
    let after = rest.slice(mention.end);
    if (mention !== first) {
      rest = `${before}/${mention.name}${after}`;
      continue;
    }
    // Drop the one space the mention leaves behind; the rest of the text stays as written.
    if ((before === "" || /\s$/u.test(before)) && /^[ \t]/u.test(after)) after = after.slice(1);
    rest = before + after;
  }
  const args = rest.trim();
  return args ? `/${first.name} ${args}` : `/${first.name}`;
}

import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SharedSkillSource = Schema.Literals(["folder", "git", "elsewhere"]);
export type SharedSkillSource = typeof SharedSkillSource.Type;

export const SharedSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  directoryName: TrimmedNonEmptyString,
  /** Absolute path of SKILL.md. */
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  source: SharedSkillSource,
  origin: TrimmedNonEmptyString,
  harnesses: TrimmedNonEmptyString,
  canRemove: Schema.Boolean,
  canUpdate: Schema.Boolean,
});
export type SharedSkill = typeof SharedSkill.Type;

export const SharedSkillsList = Schema.Struct({
  libraryRoot: TrimmedNonEmptyString,
  skills: Schema.Array(SharedSkill),
});
export type SharedSkillsList = typeof SharedSkillsList.Type;

const SkillName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const FolderPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const GitUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));

export const SharedSkillsCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("setSharing"),
    name: SkillName,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("addFolder"), path: FolderPath }),
  Schema.Struct({ type: Schema.Literal("addGit"), url: GitUrl }),
  Schema.Struct({ type: Schema.Literal("update"), name: SkillName }),
  Schema.Struct({ type: Schema.Literal("remove"), name: SkillName }),
]);
export type SharedSkillsCommand = typeof SharedSkillsCommand.Type;

export class SharedSkillsError extends Schema.TaggedError<SharedSkillsError>()(
  "SharedSkillsError",
  {
    message: Schema.String,
  },
) {}

const SHARED_SKILL_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "grok",
  "cursor",
  "pi",
  "antigravity",
]);

/** Harnesses that can load a skill from `~/.agents/skills` when SSHCode starts them. */
export function providerUsesSharedSkills(
  provider: {
    readonly driver: string;
    readonly instanceId?: string | null | undefined;
    readonly displayName?: string | null | undefined;
    readonly badgeLabel?: string | null | undefined;
  },
  agentId?: string | null,
): boolean {
  if (SHARED_SKILL_DRIVERS.has(provider.driver)) return true;
  if (provider.driver !== "acpRegistry") return false;
  const label = [agentId, provider.instanceId, provider.displayName, provider.badgeLabel]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
  return (
    /\bkimi(?:-code)?\b/.test(label) || /\bmistral-vibe\b/.test(label) || /\bvibe\b/.test(label)
  );
}

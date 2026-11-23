import { collectComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { ModelMentionChip } from "./ModelMentionChip";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills, type InlineSkill } from "@t3tools/shared/inlineSkills";

import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChip, ContextChipLabel } from "../ContextChip";

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  const chips = [
    ...[...matchInlineSkills(props.text, props.skills)].map(({ start, end, skill, rawText }) => ({
      start,
      end,
      node: <SkillChip key={`${start}:${skill.name}`} skill={skill} rawText={rawText} />,
    })),
    ...collectComposerModelMentions(props.text).map((mention) => ({
      start: mention.start,
      end: mention.end,
      node: (
        <ModelMentionChip
          key={`${mention.start}:model`}
          environmentId={props.environmentId ?? null}
          instanceId={mention.instanceId}
          model={mention.model}
          source={mention.source}
        />
      ),
    })),
  ].sort((left, right) => left.start - right.start);
  for (const chip of chips) {
    if (chip.start < cursor) continue;
    if (chip.start > cursor) nodes.push(props.text.slice(cursor, chip.start));
    nodes.push(chip.node);
    cursor = chip.end;
  }
  if (cursor === 0) return <>{props.text}</>;

  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
  environmentId?: EnvironmentId | null,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} environmentId={environmentId} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills, environmentId),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <ContextChip kind="skill" data-markdown-copy={props.rawText}>
      <SkillChipIcon />
      <ContextChipLabel>{formatProviderSkillDisplayName(props.skill)}</ContextChipLabel>
    </ContextChip>
  );
}

/** The skill glyph; the surrounding chip sizes its svg. */
export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}

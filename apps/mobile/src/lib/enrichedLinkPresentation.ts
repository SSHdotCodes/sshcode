import { collectModelLinks, parseModelLinkHref } from "@t3tools/shared/modelLinks";
import { formatComposerModelMention } from "@t3tools/client-runtime/composerModelMentions";
import type { SelectableMarkdownModel } from "../native/SelectableMarkdownText.types";
import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipPresentation } from "./composerChipPresentation";
import type { MarkdownFileIcon } from "./markdownLinks";
import type { SelectableMarkdownSkill } from "../native/SelectableMarkdownText.types";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";

const CONTEXT_ICONS: Readonly<Record<string, MarkdownFileIcon>> = {
  photo: "image",
  "play.rectangle": "video",
  terminal: "bash",
  "cursorarrow.click": "react",
  "text.bubble": "markdown",
  "git-pull-request": "git",
  cube: "mcp",
  doc: "default",
  ladybug: "bash",
};

/** Context identity comes from the URL, even when different chips share a label. */
export function enrichedContextLinkPresentation(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
) {
  const reference = parseComposerContextHref(href);
  if (!reference) return undefined;
  const record = records?.find((candidate) => candidate.contextId === reference.contextId);
  const presentation = contextChipPresentation(reference.kind, record);
  return {
    color: presentation.accent,
    icon: CONTEXT_ICONS[presentation.symbol] ?? "default",
  };
}

export function enrichedLinkVariantPattern(url: string) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Conservative recognition for Enriched's whole-span inline-code link hook. */
export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

export function enrichedSkillLinkRegex(skills?: ReadonlyArray<SelectableMarkdownSkill>) {
  const names = [...new Set(skills?.map((skill) => skill.name) ?? [])].filter(Boolean);
  if (names.length === 0) return null;
  names.sort((a, b) => b.length - a.length);
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?<!\\p{Sc})\\p{Sc}(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`,
    "u",
  );
}

export function enrichedSkillDisplayName(skill: SelectableMarkdownSkill) {
  return (
    skill.displayName?.trim() ||
    skill.name
      .split(/[\s:_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export function enrichedSkillReference(
  url: string,
  skills?: ReadonlyArray<SelectableMarkdownSkill>,
) {
  const match = /^\p{Sc}(.+)$/u.exec(url);
  return match ? skills?.find((skill) => skill.name === match[1]) : undefined;
}

export function buildEnrichedModelReferences(
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly displayName?: string | undefined;
    readonly iconUrl?: string | undefined;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly subProvider?: string | undefined;
    }>;
  }>,
  sources?: ReadonlySet<string>,
): ReadonlyArray<SelectableMarkdownModel> {
  const legacy = providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          !sources || sources.has(formatComposerModelMention(provider.instanceId, model.slug)),
      )
      .map((model) => {
        const qualifier = model.subProvider?.trim();
        const label = qualifier
          ? model.name
              .replace(
                new RegExp(
                  `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
                  "iu",
                ),
                "",
              )
              .trim() || model.name
          : model.name;
        return {
          source: formatComposerModelMention(provider.instanceId, model.slug),
          label,
          providerLabel: qualifier || provider.displayName || provider.instanceId,
          driver: provider.driver,
          iconUrl: provider.iconUrl,
        };
      }),
  );
  const links = [...(sources ?? [])].flatMap((source) =>
    collectModelLinks(source).map((link) => {
      const provider = providers.find((entry) => entry.instanceId === link.instanceId);
      const model = provider?.models.find((entry) => entry.slug === link.model);
      return {
        source,
        label: link.label || model?.name || link.model,
        providerLabel: provider?.displayName ?? link.instanceId,
        driver: model ? provider!.driver : "",
        iconUrl: model ? provider?.iconUrl : undefined,
      };
    }),
  );
  return [...legacy, ...links];
}

export function enrichedModelLinkRegex(models?: ReadonlyArray<SelectableMarkdownModel>) {
  if (!models?.length) return null;
  const alternatives = models
    .map((model) => model.source)
    .filter((source) => !source.startsWith("["))
    .sort((a, b) => b.length - a.length)
    .map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (alternatives.length === 0) return null;
  return new RegExp(
    `(?<![^\\s,(\\["'])(?:${alternatives.join("|")})(?=$|[\\s,"']|[.;:!?\\)\\]]+(?=$|[\\s,"']))`,
    "u",
  );
}

export function enrichedModelReference(
  source: string,
  models?: ReadonlyArray<SelectableMarkdownModel>,
) {
  const target = parseModelLinkHref(source);
  return models?.find(
    (model) =>
      model.source === source ||
      (target !== null &&
        collectModelLinks(model.source).some(
          (link) => link.instanceId === target.instanceId && link.model === target.model,
        )),
  );
}

export function enrichedModelDetails(model: SelectableMarkdownModel) {
  return `${model.providerLabel}\n${model.source}`;
}

export function enrichedTextLinkRegex(
  skills?: ReadonlyArray<SelectableMarkdownSkill>,
  models?: ReadonlyArray<SelectableMarkdownModel>,
) {
  const patterns = [enrichedSkillLinkRegex(skills), enrichedModelLinkRegex(models)]
    .filter((pattern) => pattern !== null)
    .map((pattern) => `(?:${pattern.source})`);
  return patterns.length ? new RegExp(patterns.join("|"), "u") : null;
}

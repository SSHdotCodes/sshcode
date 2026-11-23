import { modelChipIcon } from "../lib/contextChipIconSource";
import { contextChipPresentation } from "../lib/composerChipPresentation";
import { enrichedModelReference, enrichedTextLinkRegex } from "../lib/enrichedLinkPresentation";
import { useMemo } from "react";
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
  enrichedSkillReference,
} from "../lib/enrichedLinkPresentation";

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "models" | "textStyle">,
) {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkPresentation(url);
  if (context) return { color: context.color, icon: markdownFileIconSource(context.icon) };
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      color: props.textStyle.skillTextColor,
      label: enrichedSkillDisplayName(skill),
      icon: markdownFileIconSource("mcp"),
    };
  const model = enrichedModelReference(url, props.models);
  if (model)
    return {
      label: model.label,
      color: contextChipPresentation("model").accent,
      icon: model.driver ? modelChipIcon(model).source : undefined,
      iconTintColor: undefined,
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: props.textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: props.textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
) {
  const { linkCustomization, skills, models, textStyle } = props;
  const links = useMemo(() => {
    const byUrl = new Map<string, NonNullable<ReturnType<typeof presentation>>>();
    const regex = enrichedTextLinkRegex(skills, models);
    const urls = [
      ...assets.filter((asset) => asset.kind === "link").map((asset) => asset.url),
      ...(regex ? (props.markdown.match(new RegExp(regex.source, "gu")) ?? []) : []),
    ];
    for (const url of urls) {
      if (byUrl.has(url)) continue;
      const value = presentation(url, { linkCustomization, skills, models, textStyle });
      if (value) byUrl.set(url, value);
    }
    return byUrl;
  }, [assets, linkCustomization, skills, models, textStyle, props.markdown]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const color = link.color ?? textStyle.fileTextColor;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: "transparent",
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: textStyle.fontFamily,
              color,
              underline: false,
              backgroundColor: "transparent",
            },
          ];
        }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
            iconTintColor: link.iconTintColor,
          },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}

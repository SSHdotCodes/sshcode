import { CONTEXT_CHIP_ICON_SOURCES, PROVIDER_CHIP_ICONS } from "./contextChipIcons.generated";
import { markdownIconAssetUri } from "./markdownFileIcons";

/** Native attachments cannot decode the ACP registry's SVG logos. */
export function modelChipIcon(model: {
  readonly driver: string;
  readonly iconUrl?: string | undefined;
}) {
  if (model.iconUrl && !/\.svg(?:$|[?#])/iu.test(model.iconUrl))
    return { source: { uri: model.iconUrl }, tintsIcon: false };
  return (
    PROVIDER_CHIP_ICONS[model.driver] ?? { source: CONTEXT_CHIP_ICON_SOURCES.bot, tintsIcon: true }
  );
}

export function modelChipIconUri(model: Parameters<typeof modelChipIcon>[0]): string | null {
  return markdownIconAssetUri(modelChipIcon(model).source) ?? null;
}

/** GitHub and Hugging Face marks for link chips, pre-tinted since native chips can't tint. */
export function linkChipIconUri(site: "github" | "huggingface"): string | null {
  return markdownIconAssetUri(CONTEXT_CHIP_ICON_SOURCES[`link-${site}`]) ?? null;
}

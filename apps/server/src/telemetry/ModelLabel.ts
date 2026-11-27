import { BUNDLED_MODEL_MANIFEST } from "../provider/ModelManifest.ts";

const DATED_SNAPSHOT = /-\d{8}$/u;

const MANIFEST_LABELS: ReadonlyMap<string, string> = new Map(
  Object.values(BUNDLED_MODEL_MANIFEST.providers ?? {}).flatMap((catalog) =>
    catalog.models.flatMap((model) =>
      [model.slug, ...(model.aliases ?? [])].map((name) => [name, model.slug] as const),
    ),
  ),
);

/**
 * The model name analytics reports. A routed id, alias, or dated snapshot the
 * bundled manifest knows, such as `anthropic/claude-opus-5-5`, maps to its
 * catalog slug. Any other id can name a user, a deployment, or a local file, so
 * it reports only the driver as `custom:<driver>`. Ported from upstream #42465.
 */
export function analyticsModelLabel(driver: string, model: string): string {
  const leaf = model.slice(model.lastIndexOf("/") + 1);
  for (const candidate of [model, leaf, leaf.replace(DATED_SNAPSHOT, "")]) {
    const label = MANIFEST_LABELS.get(candidate);
    if (label !== undefined) return label;
  }
  return `custom:${driver}`;
}

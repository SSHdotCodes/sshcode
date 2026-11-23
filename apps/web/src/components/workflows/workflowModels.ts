import {
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection, getExplicitModelEffortLabel } from "@t3tools/shared/model";
import { useCallback, useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useServerConfigs } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";

export interface ModelDescription {
  readonly name: string;
  readonly driverKind: ProviderDriverKind;
  readonly instanceName: string;
  readonly entry: ProviderInstanceEntry | null;
}

const KNOWN_DRIVERS = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6.1-sol" → "GPT 6.1 Sol"; used when the catalog lacks it. */
export function prettifyModelSlug(slug: string): string {
  const words = slug
    .replace(/^claude-/u, "")
    .split(/[-_\s]+/u)
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const previous = out.at(-1);
    if (/^\d+$/u.test(word) && previous !== undefined && /\d$/u.test(previous)) {
      out[out.length - 1] = `${previous}.${word}`;
    } else if (word.toLowerCase() === "gpt") {
      out.push("GPT");
    } else {
      out.push(word.charAt(0).toUpperCase() + word.slice(1));
    }
  }
  return out.join(" ") || slug;
}

export function useWorkflowModelCatalog(environmentId: EnvironmentId) {
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const describe = useCallback(
    (selection: ModelSelection | null): ModelDescription | null => {
      if (selection === null) return null;
      return describeModel(
        instanceEntries,
        selection.instanceId,
        selection.model,
        selection.options,
      );
    },
    [instanceEntries],
  );
  return { instanceEntries, modelOptionsByInstance, describe };
}

export function describeModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  instanceId: ProviderInstanceId,
  slug: string,
  options?: ModelSelection["options"],
): ModelDescription {
  const entry = entries.find((candidate) => candidate.instanceId === instanceId) ?? null;
  const model = entry?.models.find((candidate) => candidate.slug === slug);
  const driverKind =
    entry?.driverKind ??
    ProviderDriverKind.make(
      KNOWN_DRIVERS.has(instanceId)
        ? instanceId
        : slug.startsWith("claude")
          ? "claudeAgent"
          : "codex",
    );
  const effort = getExplicitModelEffortLabel(
    { instanceId, model: slug, ...(options ? { options } : {}) },
    model?.capabilities,
  );
  return {
    name: [model?.shortName ?? model?.name ?? prettifyModelSlug(slug), effort]
      .filter(Boolean)
      .join(" · "),
    driverKind,
    instanceName: entry?.displayName ?? instanceId,
    entry,
  };
}

/** Keep explicit options only when the newly chosen model supports their values. */
export function changeWorkflowModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  current: ModelSelection | null,
  instanceId: ProviderInstanceId,
  model: string,
): ModelSelection {
  const descriptors =
    entries.find((e) => e.instanceId === instanceId)?.models.find((m) => m.slug === model)
      ?.capabilities?.optionDescriptors ?? [];
  const options = current?.options?.filter((option) => {
    const descriptor = descriptors.find((d) => d.id === option.id);
    return descriptor?.type === "boolean"
      ? typeof option.value === "boolean"
      : descriptor?.type === "select" && descriptor.options.some((o) => o.id === option.value);
  });
  return createModelSelection(instanceId, model, options);
}

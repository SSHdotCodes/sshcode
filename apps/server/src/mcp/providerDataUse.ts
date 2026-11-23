import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";

/** The model option that, switched on, lets the provider train on what it is sent. */
function trainingOptionId(provider: ServerProvider, model?: string): string | undefined {
  for (const candidate of provider.models) {
    if (model !== undefined && candidate.slug !== model) continue;
    const option = candidate.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "boolean" && descriptor.trainsOnContent === true,
    );
    if (option !== undefined) return option.id;
  }
  return undefined;
}

/** The catalog's line for a provider that trains on what it is sent; nothing for the rest. */
export function providerDataUse(provider: ServerProvider): string | undefined {
  if (provider.trainsOnContent === true) return "trains on what it is sent";
  const option = trainingOptionId(provider);
  return option === undefined ? undefined : `trains on what it is sent when option ${option} is on`;
}

/** Said once to the agent whose subagent starts on a provider that trains on what it is sent. */
export function trainingNotice(
  provider: ServerProvider,
  selection: ModelSelection,
): string | undefined {
  const name = provider.displayName ?? provider.instanceId;
  if (provider.trainsOnContent === true) return `${name} trains on what this subagent is sent.`;
  const option = trainingOptionId(provider, selection.model);
  return option !== undefined && getModelSelectionBooleanOptionValue(selection, option) === true
    ? `${name} trains on what this subagent is sent (option ${option} is on).`
    : undefined;
}

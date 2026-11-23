import type { ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { availableDefaultHarnesses } from "@t3tools/shared/harnessDefaults";

/**
 * The usual machine's default model (its server's `defaultModelSelection`) as
 * it runs on `to`: the same harness kind and model, keeping only options `to`
 * offers. The instance follows the harness kind when ids differ between
 * machines. Null when `to` does not offer that harness and model.
 */
export function borrowDefaultModelSelection(
  from: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly settings: Pick<ServerSettings, "defaultModelSelection" | "providerInstances">;
  } | null,
  to: { readonly providers: ReadonlyArray<ServerProvider> } | null,
): ModelSelection | null {
  const selection = from?.settings.defaultModelSelection;
  if (!from || !selection || !to) return null;
  const driver =
    from.providers.find((provider) => provider.instanceId === selection.instanceId)?.driver ??
    from.settings.providerInstances[selection.instanceId]?.driver;
  const candidates = availableDefaultHarnesses(to.providers).filter(
    (provider) =>
      (driver === undefined
        ? provider.instanceId === selection.instanceId
        : provider.driver === driver) &&
      provider.models.some((model) => model.slug === selection.model),
  );
  const provider =
    candidates.find((candidate) => candidate.instanceId === selection.instanceId) ?? candidates[0];
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  if (!provider || !model) return null;
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const options = (selection.options ?? []).filter((option) =>
    descriptors.some(
      (descriptor) =>
        descriptor.id === option.id &&
        descriptor.type === "select" &&
        descriptor.options.some((choice) => choice.id === option.value),
    ),
  );
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * Providers as though `selection` were its harness's own default: its model
 * is the default model and its options the default choices. New-chat
 * resolution then ranks it as it would that machine's own default, below the
 * harness and model the device last used and the options it remembers.
 */
export function withDefaultModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
): ReadonlyArray<ServerProvider> {
  if (!selection) return providers;
  return providers.map((provider) =>
    provider.instanceId !== selection.instanceId
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) => {
            const { isDefault: _isDefault, ...rest } = model;
            if (model.slug !== selection.model) return rest;
            const descriptors = model.capabilities?.optionDescriptors;
            if (!model.capabilities || !descriptors) return { ...rest, isDefault: true };
            return {
              ...rest,
              isDefault: true,
              capabilities: {
                ...model.capabilities,
                optionDescriptors: descriptors.map((descriptor) => {
                  const value = selection.options?.find(
                    (option) => option.id === descriptor.id,
                  )?.value;
                  const chosen =
                    descriptor.type === "select"
                      ? descriptor.options.find((choice) => choice.id === value)
                      : undefined;
                  if (descriptor.type !== "select" || !chosen) return descriptor;
                  return {
                    ...descriptor,
                    currentValue: chosen.id,
                    options: descriptor.options.map(({ isDefault: _choiceDefault, ...choice }) =>
                      choice.id === chosen.id ? { ...choice, isDefault: true } : choice,
                    ),
                  };
                }),
              },
            };
          }),
        },
  );
}

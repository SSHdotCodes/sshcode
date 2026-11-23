import type { HarnessDefaultsState, ServerProvider } from "@t3tools/contracts";
import { defaultModelOptions } from "@t3tools/shared/harnessDefaults";
import { applyNativeModelDefaults } from "./nativeModelDefaults.ts";

/** Project overrides onto the native snapshot. Resets always start from that untouched snapshot. */
export function applyHarnessDefaults(
  providers: ReadonlyArray<ServerProvider>,
  state: HarnessDefaultsState,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    const nativeModel = provider.models.find((model) => model.isDefault) ?? provider.models[0];
    const nativeModelDefaults = nativeModel
      ? {
          model: nativeModel.slug,
          options: Object.fromEntries(
            defaultModelOptions(nativeModel).map((option) => [option.id, option.value]),
          ),
        }
      : {};
    const override = state.harnesses[provider.instanceId];
    const models = provider.models.map((model) => {
      const descriptors = model.capabilities?.optionDescriptors;
      if (!descriptors) return model;
      return {
        ...model,
        capabilities: {
          ...model.capabilities,
          optionDescriptors: descriptors.map((option) => {
            if (option.type !== "select") return option;
            const nativeValue =
              option.currentValue ?? option.options.find((choice) => choice.isDefault)?.id;
            return nativeValue === undefined ? option : { ...option, nativeValue };
          }),
        },
      };
    });
    return {
      ...provider,
      ...(nativeModel ? { nativeModelDefaults } : {}),
      ...(state.defaultHarness === provider.instanceId ? { isHarnessDefault: true } : {}),
      // The input already has native defaults applied. Unknown choices leave them intact.
      models: applyNativeModelDefaults(models, {
        model: provider.models.some((model) => model.slug === override?.model)
          ? override?.model
          : undefined,
        options: override?.options ?? {},
      }),
    };
  });
}

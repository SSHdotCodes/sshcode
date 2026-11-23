import type {
  HarnessDefaultsPatch,
  HarnessDefaultsState,
  ServerProvider,
  ServerProviderModel,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";

export function patchHarnessDefaults(
  current: HarnessDefaultsState,
  patch: HarnessDefaultsPatch,
): HarnessDefaultsState {
  const next = { ...current, harnesses: { ...current.harnesses } };
  if (patch.defaultHarness === null) delete next.defaultHarness;
  else if (patch.defaultHarness !== undefined) next.defaultHarness = patch.defaultHarness;
  for (const id of Object.keys(patch.harnesses ?? {}) as ProviderInstanceId[]) {
    const entry = patch.harnesses?.[id];
    if (entry === undefined) continue;
    if (entry === null) {
      delete next.harnesses[id];
      continue;
    }
    const value = { ...next.harnesses[id] };
    if (entry.model === null) delete value.model;
    else if (entry.model !== undefined) value.model = entry.model;
    const options = { ...value.options };
    for (const [key, option] of Object.entries(entry.options ?? {})) {
      if (option === null) delete options[key];
      else options[key] = option;
    }
    if (Object.keys(options).length > 0) value.options = options;
    else delete value.options;
    if (value.model === undefined && value.options === undefined) delete next.harnesses[id];
    else next.harnesses[id] = value;
  }
  return next;
}

export function availableDefaultHarnesses(providers: ReadonlyArray<ServerProvider>) {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.models.length > 0,
  );
}

/** Shared settings rows keep native labels and invalid-choice feedback consistent on both clients. */
export function harnessDefaultsControls(provider: ServerProvider, state: HarnessDefaultsState) {
  const override = state.harnesses[provider.instanceId];
  const native = provider.nativeModelDefaults;
  const model =
    provider.models.find((entry) => entry.slug === override?.model) ??
    provider.models.find((entry) => entry.isDefault) ??
    provider.models[0];
  const nativeModel = provider.models.find((entry) => entry.slug === native?.model);
  const warnings: string[] = [];
  if (override?.model && !provider.models.some((entry) => entry.slug === override.model)) {
    warnings.push(`Model "${override.model}" is unavailable; using harness config.`);
  }
  const options = (model?.capabilities?.optionDescriptors ?? []).filter(
    (entry) => entry.type === "select",
  );
  for (const [id, value] of Object.entries(override?.options ?? {})) {
    if (
      !options.some(
        (entry) => entry.id === id && entry.options.some((choice) => choice.id === value),
      )
    ) {
      warnings.push(
        `Option "${id}: ${value}" is unavailable for this model; using harness config.`,
      );
    }
  }
  return {
    override,
    model,
    nativeModelLabel: nativeModel?.name ?? native?.model ?? "Catalog default",
    options,
    warnings,
  };
}

/** Capture what the composer displays so an adapter cannot substitute a different native effort. */
export function defaultModelOptions(model: ServerProviderModel) {
  return (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const value =
      descriptor.currentValue ?? descriptor.options.find((choice) => choice.isDefault)?.id;
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
}

/** Select values shown in the composer must reach the adapter even when no option was edited. */
export function withDefaultSelectOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const explicit = new Set(selections?.map((selection) => selection.id));
  return [
    ...(selections ?? []),
    ...descriptors.flatMap((descriptor) => {
      if (descriptor.type !== "select" || explicit.has(descriptor.id)) return [];
      const value =
        descriptor.currentValue ?? descriptor.options.find((choice) => choice.isDefault)?.id;
      return value === undefined ? [] : [{ id: descriptor.id, value }];
    }),
  ];
}

/** What a harness's folded row says: "Last used", or the choices pinned for new chats. */
export function harnessDefaultsSummary(
  controls: ReturnType<typeof harnessDefaultsControls>,
): string {
  const override = controls.override;
  if (!override) return "Last used";
  const parts: string[] = [];
  if (override.model) {
    parts.push(controls.model?.slug === override.model ? controls.model.name : override.model);
  }
  for (const option of controls.options) {
    const value = override.options?.[option.id];
    if (value === undefined || value === null) continue;
    parts.push(option.options.find((choice) => choice.id === value)?.label ?? String(value));
  }
  return parts.length > 0 ? parts.join(" · ") : "Last used";
}

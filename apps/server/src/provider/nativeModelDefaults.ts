import type { ProviderOptionDescriptor, ServerProviderModel } from "@t3tools/contracts";

/**
 * What the harness itself is configured to use for a new session: Codex's
 * `config.toml` (`model`, `model_reasoning_effort`, ...) or Claude Code's
 * `settings.json` (`model`, `effortLevel`). New threads start from these, so a
 * session in SSHCode runs as it would in the harness's own app.
 */
export interface NativeModelDefaults {
  /** A catalog slug, or an alias such as Claude's `sonnet`. */
  readonly model?: string | undefined;
  /** Option id to the configured choice, e.g. `{ reasoningEffort: "xhigh" }`. */
  readonly options?: Readonly<Record<string, string | undefined>>;
}

const normalizeModelName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "");

/** The catalog model a configured name refers to, by slug or alias. */
export function resolveNativeModel(
  models: ReadonlyArray<ServerProviderModel>,
  configured: string | undefined,
): ServerProviderModel | undefined {
  if (configured === undefined) return undefined;
  const name = normalizeModelName(configured);
  if (name.length === 0) return undefined;
  return (
    models.find((model) => model.slug.toLowerCase() === name) ??
    models.find((model) => model.aliases?.some((alias) => alias.toLowerCase() === name))
  );
}

function withDefaultChoice(
  descriptor: ProviderOptionDescriptor,
  value: string | undefined,
): ProviderOptionDescriptor {
  if (
    descriptor.type !== "select" ||
    value === undefined ||
    !descriptor.options.some((option) => option.id === value)
  ) {
    return descriptor;
  }
  return {
    ...descriptor,
    currentValue: value,
    options: descriptor.options.map(({ isDefault: _isDefault, ...option }) =>
      option.id === value ? { ...option, isDefault: true } : option,
    ),
  };
}

/**
 * Marks the harness's configured model as the default and makes each
 * configured option (where the model offers that choice) its default choice.
 * Anything the harness has no setting for, or that the catalog lacks, keeps
 * the catalog's default.
 */
export function applyNativeModelDefaults(
  models: ReadonlyArray<ServerProviderModel>,
  defaults: NativeModelDefaults,
): ReadonlyArray<ServerProviderModel> {
  const nativeModel = resolveNativeModel(models, defaults.model);
  const options = defaults.options ?? {};
  const hasOptions = Object.values(options).some((value) => value !== undefined);
  if (nativeModel === undefined && !hasOptions) return models;
  return models.map((model) => {
    let next: ServerProviderModel = model;
    if (nativeModel !== undefined) {
      const { isDefault: _isDefault, ...rest } = model;
      next = model.slug === nativeModel.slug ? { ...rest, isDefault: true } : rest;
    }
    const descriptors = next.capabilities?.optionDescriptors;
    if (!hasOptions || descriptors === undefined) return next;
    return {
      ...next,
      capabilities: {
        ...next.capabilities,
        optionDescriptors: descriptors.map((descriptor) =>
          withDefaultChoice(descriptor, options[descriptor.id]),
        ),
      },
    };
  });
}

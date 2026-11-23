import {
  type ModelSelection,
  type HarnessDefaultsState,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  resolveProjectProviderInstanceEnabled,
  type ResolvedServerSettings,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import { pickAccountForNewSession } from "./accountBalance.ts";
import { availableDefaultHarnesses, defaultModelOptions } from "./harnessDefaults.ts";
import { normalizeProjectPathForComparison } from "./path.ts";
import { fallbackTextGenerationModelSelection } from "./serverSettings.ts";

/**
 * Where a project-scoped value came from. The order is the priority order:
 * a project override, then the environment value, then the repository's
 * t3.json for keys in `PROJECT_FILE_BACKED_SETTINGS`, then the built-in
 * default (reported as "environment", since that is what the environment
 * value is when nothing set it).
 */
export type ProjectSettingSource = "environment" | "project" | "t3.json";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  /** Environment settings with the project's overrides applied. */
  readonly settings: Settings;
  /** Where each scopable key's effective value came from. */
  readonly sources: ProjectSettingSources;
  /** The project's raw override entry; `{}` when it has none. */
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

/** Cheap check so hot paths skip the projectId lookup when nothing is overridden. */
export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/**
 * The project aggregate's own model and workspace fields. They remain the
 * source of truth until the server has folded them into the override record;
 * after the fold the record alone decides, so a reset there cannot be undone
 * by a stale aggregate value.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

/**
 * Apply one project's overrides on top of environment settings. A model
 * override whose provider is disabled on this environment falls back to the
 * environment value, the same guard the environment-level selection gets.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  // Nullable, not just optional: the mobile new-task flow passes its selected
  // project straight through, and that is null until the shell snapshot lands.
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
/**
 * With the checkout's decoded t3.json (or null for a missing or invalid
 * one), every file-backed key resolves to a concrete value: the file fills
 * keys whose project and environment tiers are both unset, and the built-in
 * default fills what is left.
 */
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: T3ProjectFile | null,
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  return projectFile === undefined ? resolved : applyProjectFile(resolved, projectFile);
}

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    // A project override of null defers like an unset one, so the value did
    // not come from the project either way.
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

/**
 * The file and built-in tiers for one key, given the project-over-environment
 * value (`null` when neither is set). For callers that hold the settings tier
 * but only see the file later, such as the git driver reading the t3.json of
 * the checkout it just created. Same chain as `resolveProjectSettings`.
 */
export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "t3.json" };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // A forward-compatible decode leaves an unknown value as a present
    // undefined; that is not an override.
    if (value === undefined) continue;
    // A model on a disabled provider falls back to the environment, like the
    // environment-level guards do for these keys. An instance this project
    // enabled via `providerInstances[id].enabled` still counts as enabled here.
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !resolveProjectProviderInstanceEnabled(
        settings,
        projectId,
        (value as ModelSelection).instanceId,
      )
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  // Like the environment guard, text generation never runs on an instance
  // this project turned off.
  const textGeneration = effective.textGenerationModelSelection as ModelSelection;
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, textGeneration.instanceId)) {
    const fallback = fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId) => resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
      {
        includeConfiguredInstances: true,
        defaultModelSelection: effective.defaultModelSelection as ModelSelection | null,
      },
    );
    if (fallback !== null) effective.textGenerationModelSelection = fallback;
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/**
 * The workspace mode a new thread starts in. A project the environment made
 * from just a name (a folder directly inside `ServerConfig.newProjectsRoot`)
 * has only its first commit, so until it has a thread, a new thread works in
 * the project checkout even when the environment default is a new worktree.
 * Only that environment default is replaced: a project override still wins,
 * and so does a t3.json when the environment sets no default (the usual
 * precedence; the scaffold writes no t3.json).
 */
export function resolveNewThreadEnvMode(input: {
  readonly projectSettings: ResolvedProjectSettings<ResolvedServerSettings>;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = input.projectSettings.settings.defaultThreadEnvMode;
  if (
    configured === "local" ||
    input.projectHasThreads ||
    input.projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

/** Replace the project's entry, dropping it entirely when nothing is overridden. */
export function withProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  next: ProjectSettingsOverrides | null,
): ServerSettings["projectSettingsOverrides"] {
  const { [projectId]: _removed, ...rest } = settings.projectSettingsOverrides;
  return next === null || Object.keys(next).length === 0 ? rest : { ...rest, [projectId]: next };
}

/** The project's entry with `keys` removed; `null` when that leaves it empty. */
export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

/** Worktree rules are project-scoped; artifact and log retention stays environment-wide. */
export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeKeepWhen: settings.storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = settings.storageCleanup;
  return {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}

/** Existing native/catalog fallback when there is no usable device-local history. */
export function nativeHarnessModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  const provider =
    availableDefaultHarnesses(providers).find((entry) => entry.isHarnessDefault) ??
    providers.find((entry) => entry.instanceId === selection?.instanceId);
  const model =
    provider?.models.find((entry) => entry.isDefault) ??
    (provider?.isHarnessDefault ? provider.models[0] : undefined);
  if (!provider || !model) return selection ?? null;
  const options = defaultModelOptions(model);
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options.length ? { options } : {}),
  };
}

/** Resolve new-chat defaults from explicit settings, device-local history, then native defaults. */
export function resolveNewChatModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly harnessDefaults?: HarnessDefaultsState | null | undefined;
  readonly fallbackSelection?: ModelSelection | null | undefined;
  readonly stickyActiveProvider?: ProviderInstanceId | null | undefined;
  readonly stickyModelSelectionByProvider?:
    | Readonly<Partial<Record<ProviderInstanceId, ModelSelection>>>
    | undefined;
  readonly stickyOptionsByModelByProvider?:
    | Readonly<
        Partial<
          Record<
            ProviderInstanceId,
            Readonly<Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
          >
        >
      >
    | undefined;
  /**
   * Device history names a route, but it is the model that was chosen. Given the remembered
   * selection, this returns a better place to run that model now (the maker's own harness,
   * once a plan covers it), or null to keep the remembered one. Never asked for a harness or
   * model set in settings.
   */
  readonly rerouteSticky?:
    | ((
        selection: { readonly instanceId: ProviderInstanceId; readonly model: string },
        providers: ReadonlyArray<ServerProvider>,
      ) => { readonly instanceId: string; readonly model: string } | null)
    | undefined;
  /**
   * Starts the chat on whichever of the user's accounts of that provider has the most to
   * spare (see `accountBalance`); absent or null keeps the remembered account. A harness
   * set in settings stays that harness: its accounts are one harness, and the chat goes to
   * the roomier of them. `accepts` leaves out accounts the chat could not start the model
   * on (disabled for the project, or the model hidden there).
   */
  readonly balanceAccounts?:
    | {
        readonly now: number;
        readonly accepts?: ((provider: ServerProvider, model: string) => boolean) | undefined;
      }
    | null
    | undefined;
}): ModelSelection | null {
  const available = availableDefaultHarnesses(input.providers);
  const onRoomierAccount = (selection: ModelSelection | null): ModelSelection | null => {
    if (!input.balanceAccounts || !selection) return selection;
    const pick = pickAccountForNewSession(input.providers, selection, {
      now: input.balanceAccounts.now,
      accepts: (candidate) =>
        available.some((entry) => entry.instanceId === candidate.instanceId) &&
        (input.balanceAccounts?.accepts?.(candidate, selection.model) ?? true),
    });
    const roomier =
      pick && pick.instanceId !== selection.instanceId
        ? available.find((provider) => provider.instanceId === pick.instanceId)
        : undefined;
    return roomier ? { ...selection, instanceId: roomier.instanceId } : selection;
  };
  const explicitProvider = available.find(
    (provider) => provider.instanceId === input.harnessDefaults?.defaultHarness,
  );
  const stickyProvider = available.find(
    (provider) => provider.instanceId === input.stickyActiveProvider,
  );
  const fallback = nativeHarnessModelSelection(input.providers, input.fallbackSelection);
  let provider =
    explicitProvider ??
    stickyProvider ??
    input.providers.find((provider) => provider.instanceId === fallback?.instanceId);
  if (!provider) return fallback;

  let explicit = input.harnessDefaults?.harnesses[provider.instanceId];
  let sticky = input.stickyModelSelectionByProvider?.[provider.instanceId];
  if (
    !explicit &&
    !sticky &&
    !explicitProvider &&
    !stickyProvider &&
    Object.keys(input.stickyOptionsByModelByProvider?.[provider.instanceId] ?? {}).length === 0
  ) {
    return onRoomierAccount(fallback);
  }
  let model =
    provider.models.find((model) => model.slug === explicit?.model) ??
    provider.models.find((model) => model.slug === sticky?.model) ??
    provider.models.find((model) => model.isDefault) ??
    provider.models.find((model) => model.slug === fallback?.model) ??
    (explicitProvider || stickyProvider ? provider.models[0] : undefined);
  if (!model) return onRoomierAccount(fallback);

  if (
    input.rerouteSticky &&
    !explicitProvider &&
    stickyProvider &&
    !explicit?.model &&
    sticky?.model === model.slug
  ) {
    const better = input.rerouteSticky(
      { instanceId: provider.instanceId, model: model.slug },
      input.providers,
    );
    const betterProvider = better
      ? available.find((entry) => entry.instanceId === better.instanceId)
      : undefined;
    const betterModel = betterProvider?.models.find((entry) => entry.slug === better?.model);
    if (betterProvider && betterModel) {
      provider = betterProvider;
      model = betterModel;
      explicit = input.harnessDefaults?.harnesses[provider.instanceId];
      sticky = input.stickyModelSelectionByProvider?.[provider.instanceId];
    }
  }

  const remembered =
    input.stickyOptionsByModelByProvider?.[provider.instanceId]?.[model.slug] ??
    (sticky?.model === model.slug ? sticky.options : undefined);
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const options = new Map<string, ProviderOptionSelection>(
    defaultModelOptions(model).map((option) => [option.id, option]),
  );
  for (const option of remembered ?? []) {
    const descriptor = descriptors.find((descriptor) => descriptor.id === option.id);
    if (
      descriptor &&
      (descriptor.type !== "select" ||
        descriptor.options.some((choice) => choice.id === option.value))
    ) {
      options.set(option.id, option);
    }
  }
  for (const [id, value] of Object.entries(explicit?.options ?? {})) {
    const descriptor = descriptors.find((descriptor) => descriptor.id === id);
    if (descriptor?.type === "select" && descriptor.options.some((choice) => choice.id === value)) {
      options.set(id, { id, value });
    }
  }
  return onRoomierAccount({
    instanceId: provider.instanceId,
    model: model.slug,
    ...(options.size > 0 ? { options: [...options.values()] } : {}),
  });
}

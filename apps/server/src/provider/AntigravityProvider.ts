import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { unavailableGoogleLimits } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

import { antigravityThinkingConfig } from "./acp/AntigravityAcpSupport.ts";

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT = "90 seconds";
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";

type SessionSetupResult = Pick<
  AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

/** Keep the native model IDs, including model-specific thinking levels. */
type ThinkingConfig = NonNullable<ReturnType<typeof antigravityThinkingConfig>>;

/** Thinking options each model reported when selected; `null` means it has none. */
export type AntigravityThinkingLevels = ReadonlyMap<string, ThinkingConfig | null>;

function thinkingCapabilities(config: ThinkingConfig | null | undefined, observed: boolean) {
  const descriptor = config
    ? acpProviderOptionDescriptors({ configOptions: [config], modeState: undefined })[0]
    : undefined;
  if (descriptor?.type !== "select") return EMPTY_MODEL_CAPABILITIES;
  // Another model's selected level is not this model's default.
  const { currentValue: _currentValue, ...unobserved } = descriptor;
  return createModelCapabilities({ optionDescriptors: [observed ? descriptor : unobserved] });
}

function selectOptionValues(config: ThinkingConfig): ReadonlyArray<string> {
  return config.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

function mergeLiveThinkingConfig(
  existing: ThinkingConfig | null | undefined,
  next: ThinkingConfig | null,
): ThinkingConfig | null | undefined {
  if (existing === undefined) return undefined;
  if (next === null) return null;
  if (existing === null) return undefined;
  return selectOptionValues(next).includes(existing.currentValue)
    ? { ...next, currentValue: existing.currentValue }
    : next;
}

function sessionModelSlug(setup: SessionSetupResult): string | undefined {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  return config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
}

export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
  thinkingLevels: AntigravityThinkingLevels = new Map(),
  options?: {
    readonly defaultModel?: string | undefined;
    readonly authoritative?: boolean;
  },
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const authoritative = options?.authoritative ?? true;
  const defaultModel =
    options?.defaultModel !== undefined
      ? entries.some((entry) => entry.value === options.defaultModel)
        ? options.defaultModel
        : currentValue
      : authoritative
        ? currentValue
        : undefined;
  const currentThinking = antigravityThinkingConfig(setup.configOptions);
  const seen = new Set<string>();
  // The agent can list two IDs under one name; label the later ones so the picker tells them apart.
  const names = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    const baseName = entry.name.trim() ? entry.name : entry.value;
    const name = names.has(baseName) ? `${baseName} (${entry.value})` : baseName;
    names.add(baseName);
    const observed =
      authoritative && entry.value === currentValue
        ? (currentThinking ?? null)
        : thinkingLevels.get(entry.value);
    return [
      {
        slug: entry.value,
        name,
        isCustom: false,
        ...(entry.value === defaultModel
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        capabilities:
          observed === undefined
            ? thinkingCapabilities(authoritative ? currentThinking : undefined, false)
            : thinkingCapabilities(observed, true),
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface AntigravityProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  readonly resolveMaintenance?: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  /** Auth type and label published once a session authenticates. */
  readonly auth?: { readonly type: string; readonly label: string };
}

/**
 * Health uses initialize only. Session callbacks supply account-specific
 * metadata, which a disabled instance never shows.
 */
export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const usesCredentials =
    options.auth?.type === "gemini-api-key" || options.auth?.type === "agent-platform";
  const signInMessage = usesCredentials
    ? `Connect with ${options.auth.label} to use Antigravity and load models.`
    : SIGN_IN_MESSAGE;
  const authUncheckedMessage = usesCredentials
    ? `Antigravity is installed. Connect with ${options.auth.label} to load models.`
    : AUTH_UNCHECKED_MESSAGE;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: {
        displayName: "Antigravity",
        showInteractionModeToggle: false,
        // No automatic review, so Auto falls back to Supervised instead of approving everything.
        supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        // The configured method rides along so the registry can tell a saved
        // account for this method from one left by a previous configuration.
        auth: { status: "unknown", ...(options.auth ? { type: options.auth.type } : {}) },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in SSHCode settings.",
      },
    }),
    ...(settings.enabled && !usesCredentials
      ? { usageLimits: unavailableGoogleLimits(checkedAt) }
      : {}),
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  // Skills from the registry's last scan of each folder. A folder without them stays pending so it is scanned.
  const discoveredSkills = new Map<string, ServerProvider["skills"]>();
  // Commands of folders whose draft entry a skill scan dropped, so later scans still report them.
  const workspaceCommands = new Map<string, ServerProvider["slashCommands"]>();
  const thinkingLevels = new Map<string, ThinkingConfig | null>();
  let defaultModelSlug: string | undefined;
  const observeThinkingLevels = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
    authoritative: boolean,
  ) => {
    const model = configOptions?.find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (model?.type !== "select" || !model.currentValue) return;
    const next = antigravityThinkingConfig(configOptions) ?? null;
    if (authoritative) {
      thinkingLevels.set(model.currentValue, next);
      return;
    }
    const merged = mergeLiveThinkingConfig(thinkingLevels.get(model.currentValue), next);
    if (merged !== undefined) {
      thinkingLevels.set(model.currentValue, merged);
    }
  };
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const result = yield* options.probe.pipe(
      Effect.timeoutOption(HEALTH_CHECK_TIMEOUT),
      Effect.result,
    );
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const version = initialized?.agentInfo?.version;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity ACP runtime is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : `Antigravity did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, refreshing: _refreshing, ...draft } = state.draft;
      const authenticated = draft.auth.status === "authenticated";
      const message =
        errorMessage ??
        (authenticated
          ? undefined
          : draft.auth.status === "unauthenticated"
            ? signInMessage
            : authUncheckedMessage);
      return {
        ...state,
        draft: {
          ...draft,
          installed: !missingInstallation,
          // Custom launchers have no static version; their lightweight probe
          // must not erase the version learned from a real ACP handshake.
          version: version === "unknown" ? draft.version : version || draft.version,
          status: errorMessage ? "error" : authenticated ? "ready" : "warning",
          ...(Result.isSuccess(result) && Option.isNone(result.success)
            ? { refreshing: true }
            : {}),
          checkedAt: updatedAt,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration:
                  supportsTextGeneration && draft.auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("antigravity"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance:
      options.resolveMaintenance ?? (() => Effect.succeed(maintenanceCapabilities)),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((state) =>
          options.stampIdentity(state.draft).pipe(Effect.flatMap(publishSnapshot)),
        ),
      ),
  });

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd?: string,
    session?: { readonly resumed?: boolean },
  ) {
    if (!settings.enabled) return;
    const authoritative = session?.resumed !== true;
    if (authoritative) {
      const modelSlug = sessionModelSlug(started.sessionSetupResult);
      if (modelSlug) defaultModelSlug = modelSlug;
    }
    observeThinkingLevels(started.sessionSetupResult.configOptions, authoritative);
    const before = yield* SubscriptionRef.get(metadata);
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return state;
      }
      const { message: _previousMessage, refreshing: _refreshing, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      const skills = cwd ? discoveredSkills.get(cwd) : undefined;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: "ready",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: {
            status: "authenticated",
            type: options.auth?.type ?? "oauth-personal",
            label: options.auth?.label ?? "Google account",
          },
          checkedAt: updatedAt,
          models: buildAntigravityModelsFromSession(started.sessionSetupResult, thinkingLevels, {
            defaultModel: defaultModelSlug,
            authoritative,
          }),
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands:
                      workspace?.slashCommands ?? workspaceCommands.get(cwd) ?? draft.slashCommands,
                    skills: skills ?? workspace?.skills ?? [],
                    ...(skills ? {} : { slashCommandsPending: true }),
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("AntigravityProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    update?: { readonly fromCatalogProbe?: boolean },
  ) {
    // Only catalog probes report a model's default level; live sessions carry per-thread overrides.
    const authoritative = update?.fromCatalogProbe === true;
    observeThinkingLevels(configOptions, authoritative);
    const models = buildAntigravityModelsFromSession({ configOptions }, thinkingLevels, {
      defaultModel: defaultModelSlug,
      authoritative,
    });
    yield* SubscriptionRef.updateSome(metadata, (state) => {
      if (state.draft.auth.status !== "authenticated" || Equal.equals(state.draft.models, models)) {
        return Option.none();
      }
      return Option.some({ ...state, draft: { ...state.draft, models } });
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const skills = cwd ? discoveredSkills.get(cwd) : undefined;
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands,
                    skills:
                      skills ??
                      state.draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ??
                      [],
                    ...(skills ? {} : { slashCommandsPending: true }),
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* () {
    if (!settings.enabled) return;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          draft: {
            ...state.draft,
            auth: {
              status: "unauthenticated",
              ...(usesCredentials ? options.auth : {}),
            },
            status: "warning",
            message: signInMessage,
            checkedAt: updatedAt,
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
            supportsTextGeneration: false,
          },
        }) satisfies AntigravityProviderState,
    );
    discoveredSkills.clear();
    workspaceCommands.clear();
    thinkingLevels.clear();
    defaultModelSlug = undefined;
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    if (skills) {
      discoveredSkills.set(cwd, skills);
      if (workspace) workspaceCommands.set(cwd, workspace.slashCommands);
      // The registry keeps the folder it scans. Changing the entry mid-scan would discard the scan.
      yield* SubscriptionRef.updateSome(metadata, (state) =>
        state.draft.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
          ? Option.some({
              ...state,
              draft: {
                ...state.draft,
                workspaceSnapshots: state.draft.workspaceSnapshots.filter(
                  (entry) => entry.cwd !== cwd,
                ),
              },
            })
          : Option.none(),
      );
    }
    const resolvedSkills = skills ?? workspace?.skills ?? discoveredSkills.get(cwd) ?? [];
    const slashCommands = workspace?.slashCommands ?? workspaceCommands.get(cwd);
    return slashCommands
      ? { ...snapshot, slashCommands, skills: resolvedSkills }
      : { ...snapshot, skills: resolvedSkills };
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    onSignedOut: clearAccountMetadata(),
    onAuthRequired: clearAccountMetadata(),
    snapshotForCwd,
  };
});

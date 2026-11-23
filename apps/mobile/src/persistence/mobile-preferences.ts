import { profileImage } from "@t3tools/shared/discordProfile";
import type { UiMode, HarnessThemeSettings } from "@t3tools/shared/harnessThemes";
import { resolveMobileHarnessThemeSettings } from "../lib/harnessThemes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  EnvironmentId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  type ProviderInstanceId,
  type PullRequestMergeMethod,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { ComposerEnterBehavior } from "../lib/composerEnterBehavior";
import type { FollowUpBehavior } from "../lib/followUpBehavior";
import {
  sanitizeCombinedLimitRings,
  sanitizeLimitRingChoices,
  sanitizeStatusAccessoryItems,
  type LimitRingChoices,
  type StatusAccessoryItem,
} from "../lib/statusAccessoryItems";
import { isMicrophoneKind, type MicrophoneEntry } from "../lib/microphonePriority";
import { MOBILE_THEME_IDS, type MobileThemeId, type MobileThemeMode } from "../lib/mobileTheme";
import { sanitizeThreadHeaderItems, type ThreadHeaderItem } from "../lib/threadHeaderItems";
import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";

const PREFERENCES_KEY = "t3code.preferences";
const PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

/** The pull request list's filters and sort for one environment scope. */
export const PullRequestListControls = Schema.Struct({
  state: PullRequestListState,
  involvement: PullRequestInvolvement,
  filters: PullRequestListFilters,
  projectId: Schema.optional(Schema.String),
  projectEnvironmentId: Schema.optional(Schema.String),
  sort: Schema.Literals(["updated", "created", "oldest"]),
});
export type PullRequestListControls = typeof PullRequestListControls.Type;

const ThreadListFilters = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  projectKey: Schema.NullOr(Schema.String),
});
export type ThreadListFilters = typeof ThreadListFilters.Type;

/** Controls are keyed by environment id, with "" for all environments. */
const PullRequestListPreferences = Schema.Struct({
  environmentId: Schema.NullOr(Schema.String),
  controls: Schema.Record(Schema.String, PullRequestListControls),
});
export type PullRequestListPreferences = typeof PullRequestListPreferences.Type;

const isThreadListFilters = Schema.is(ThreadListFilters);
const isPullRequestListPreferences = Schema.is(PullRequestListPreferences);

export interface Preferences {
  readonly pullRequestHideTestFiles?: boolean;
  readonly pullRequestMergeMethod?: PullRequestMergeMethod;
  readonly liveActivitiesEnabled?: boolean;
  readonly themeId?: MobileThemeId;
  readonly lightThemeId?: MobileThemeId;
  readonly darkThemeId?: MobileThemeId;
  readonly themeMode?: MobileThemeMode;
  readonly uiMode?: UiMode;
  /** Off unless set. Discord mode does not turn this on. */
  readonly casualVoice?: boolean;
  readonly workflowsBeta?: boolean;
  readonly screenRecordingPrivacy?: boolean;
  readonly discordProfileImage?: string | null;
  readonly harnessThemes?: HarnessThemeSettings;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  /** Header shortcuts on this device; unset uses side chat and git controls. */
  readonly threadHeaderItems?: readonly ThreadHeaderItem[];
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
  /** What the Return key does in the composer on a hardware keyboard. iOS only. */
  readonly composerEnterBehavior?: ComposerEnterBehavior;
  /**
   * Device-local mirror of the web `followUpBehavior` client setting: whether a
   * message sent during a running turn queues behind it or steers it. Versioned
   * because the default moved from queue to steer: the old `followUpBehavior`
   * key mostly held the old default, so it is dropped and every device starts
   * steering once; a choice made after that is kept.
   */
  readonly followUpBehaviorV2?: FollowUpBehavior;
  /** What the phone tab bar's status capsule shows, in order; unset means the default. */
  readonly statusAccessoryItems?: ReadonlyArray<StatusAccessoryItem>;
  /** Which limit rings the capsule shows, where the user chose; see `LimitRingChoices`. */
  readonly statusAccessoryRings?: LimitRingChoices;
  /** Providers whose plans share one ring in the capsule; unset means none. */
  readonly statusAccessoryCombinedRings?: ReadonlyArray<string>;
  /** Microphone kinds and remembered devices, most preferred first. iOS only. */
  readonly microphones?: ReadonlyArray<MicrophoneEntry>;
  /** @deprecated Kept temporarily so older OTA bundles retain the selected mode. */
  readonly projectGroupingEnabled?: boolean;
  readonly projectGroupingMode?: SidebarProjectGroupingMode;
  /** Device-local counterpart of desktop's `planModeEnabled` legacy flag. */
  readonly planModeEnabled?: boolean;
  /** Device-local counterpart of web's `sidebarWorkingShelfEnabled` beta. */
  readonly workingShelfEnabled?: boolean;
  /** The Overview prototype's switch; unset means on. */
  readonly overviewEnabled?: boolean;
  /** The empty new-chat dashboard; unset means on for this device. */
  readonly newChatDashboardEnabled?: boolean;
  readonly chatBackdropEnabled?: boolean;
  /** The charging clock over the chat list after a minute idle; unset means on. */
  readonly bedsideScreenEnabled?: boolean;
  /** Suggests a model for a new chat's first message; unset means on. */
  readonly autoModelEnabled?: boolean;
  /** @deprecated Retained to migrate favorites to the connected environment. */
  readonly modelFavorites?: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
  /** Fresh keys reset both shelves to collapsed when users update. */
  readonly threadListSettledShelfExpanded?: boolean;
  readonly threadListSnoozedShelfExpanded?: boolean;
  readonly threadListWorkingShelfExpanded?: boolean;
  /**
   * Chats as session boxes instead of the classic rows; off unless chosen in Settings. (An
   * older `threadListLayout` field defaulted to boxes and is no longer read.)
   */
  readonly threadListBoxes?: boolean;
  /** The chat tab Home has open ("" for All). */
  readonly threadListChatTab?: string;
  /** Saved servers this phone gave a T3 Connect route on its own, once each. */
  readonly relayRouteIds?: ReadonlyArray<string>;
  /** Home list filters, restored on the next launch. */
  readonly threadListFilters?: ThreadListFilters;
  readonly pullRequestListFilters?: PullRequestListPreferences;
}

export class MobilePreferencesLoadError extends Schema.TaggedError<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedError<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: Preferences;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/persistence/MobilePreferencesStore") {}

function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    pullRequestHideTestFiles?: boolean;
    pullRequestMergeMethod?: PullRequestMergeMethod;
    liveActivitiesEnabled?: boolean;
    themeId?: MobileThemeId;
    lightThemeId?: MobileThemeId;
    darkThemeId?: MobileThemeId;
    themeMode?: MobileThemeMode;
    uiMode?: UiMode;
    casualVoice?: boolean;
    workflowsBeta?: boolean;
    screenRecordingPrivacy?: boolean;
    discordProfileImage?: string | null;
    harnessThemes?: HarnessThemeSettings;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    threadHeaderItems?: readonly ThreadHeaderItem[];
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
    composerEnterBehavior?: ComposerEnterBehavior;
    followUpBehaviorV2?: FollowUpBehavior;
    statusAccessoryItems?: ReadonlyArray<StatusAccessoryItem>;
    statusAccessoryRings?: LimitRingChoices;
    statusAccessoryCombinedRings?: ReadonlyArray<string>;
    microphones?: ReadonlyArray<MicrophoneEntry>;
    projectGroupingEnabled?: boolean;
    projectGroupingMode?: SidebarProjectGroupingMode;
    planModeEnabled?: boolean;
    workingShelfEnabled?: boolean;
    overviewEnabled?: boolean;
    newChatDashboardEnabled?: boolean;
    chatBackdropEnabled?: boolean;
    bedsideScreenEnabled?: boolean;
    autoModelEnabled?: boolean;
    modelFavorites?: Preferences["modelFavorites"];
    threadListSettledShelfExpanded?: boolean;
    threadListSnoozedShelfExpanded?: boolean;
    threadListWorkingShelfExpanded?: boolean;
    threadListBoxes?: boolean;
    threadListChatTab?: string;
    relayRouteIds?: ReadonlyArray<string>;
    threadListFilters?: ThreadListFilters;
    pullRequestListFilters?: PullRequestListPreferences;
  } = {};

  if (typeof parsed.pullRequestHideTestFiles === "boolean") {
    preferences.pullRequestHideTestFiles = parsed.pullRequestHideTestFiles;
  }

  if (
    parsed.pullRequestMergeMethod === "squash" ||
    parsed.pullRequestMergeMethod === "merge" ||
    parsed.pullRequestMergeMethod === "rebase"
  ) {
    preferences.pullRequestMergeMethod = parsed.pullRequestMergeMethod;
  }

  if (parsed.discordProfileImage !== undefined)
    preferences.discordProfileImage = profileImage(parsed.discordProfileImage);
  if (parsed.uiMode === "default" || parsed.uiMode === "discord") {
    preferences.uiMode = parsed.uiMode;
  }
  if (typeof parsed.casualVoice === "boolean") {
    preferences.casualVoice = parsed.casualVoice;
  }
  if (typeof parsed.workflowsBeta === "boolean") {
    preferences.workflowsBeta = parsed.workflowsBeta;
  }
  if (typeof parsed.screenRecordingPrivacy === "boolean") {
    preferences.screenRecordingPrivacy = parsed.screenRecordingPrivacy;
  }
  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (
    typeof parsed.themeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.themeId)
  ) {
    preferences.themeId = parsed.themeId as MobileThemeId;
  }
  if (
    typeof parsed.lightThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.lightThemeId)
  ) {
    preferences.lightThemeId = parsed.lightThemeId as MobileThemeId;
  }
  if (
    typeof parsed.darkThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.darkThemeId)
  ) {
    preferences.darkThemeId = parsed.darkThemeId as MobileThemeId;
  }
  if (
    parsed.themeMode === "system" ||
    parsed.themeMode === "light" ||
    parsed.themeMode === "dark"
  ) {
    preferences.themeMode = parsed.themeMode;
  }
  if (parsed.harnessThemes !== undefined) {
    preferences.harnessThemes = resolveMobileHarnessThemeSettings(parsed.harnessThemes);
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  const threadHeaderItems = sanitizeThreadHeaderItems(parsed.threadHeaderItems);
  if (threadHeaderItems !== undefined) preferences.threadHeaderItems = threadHeaderItems;
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (parsed.composerEnterBehavior === "send" || parsed.composerEnterBehavior === "newline") {
    preferences.composerEnterBehavior = parsed.composerEnterBehavior;
  }
  if (parsed.followUpBehaviorV2 === "queue" || parsed.followUpBehaviorV2 === "steer") {
    preferences.followUpBehaviorV2 = parsed.followUpBehaviorV2;
  }
  const statusAccessoryItems = sanitizeStatusAccessoryItems(parsed.statusAccessoryItems);
  if (statusAccessoryItems !== undefined) {
    preferences.statusAccessoryItems = statusAccessoryItems;
  }
  const statusAccessoryRings = sanitizeLimitRingChoices(parsed.statusAccessoryRings);
  if (statusAccessoryRings !== undefined) {
    preferences.statusAccessoryRings = statusAccessoryRings;
  }
  const statusAccessoryCombinedRings = sanitizeCombinedLimitRings(
    parsed.statusAccessoryCombinedRings,
  );
  if (statusAccessoryCombinedRings !== undefined) {
    preferences.statusAccessoryCombinedRings = statusAccessoryCombinedRings;
  }
  if (Array.isArray(parsed.microphones)) {
    preferences.microphones = parsed.microphones.flatMap((entry): MicrophoneEntry[] => {
      if (typeof entry !== "object" || entry === null || !isMicrophoneKind(entry.kind)) return [];
      if (!("uid" in entry)) return [{ kind: entry.kind }];
      return typeof entry.uid === "string" && typeof entry.name === "string"
        ? [{ kind: entry.kind, uid: entry.uid, name: entry.name }]
        : [];
    });
  }
  if (typeof parsed.projectGroupingEnabled === "boolean") {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }
  if (
    parsed.projectGroupingMode === "repository" ||
    parsed.projectGroupingMode === "repository_path" ||
    parsed.projectGroupingMode === "separate"
  ) {
    preferences.projectGroupingMode = parsed.projectGroupingMode;
  }
  if (typeof parsed.planModeEnabled === "boolean") {
    preferences.planModeEnabled = parsed.planModeEnabled;
  }
  if (typeof parsed.workingShelfEnabled === "boolean") {
    preferences.workingShelfEnabled = parsed.workingShelfEnabled;
  }
  if (typeof parsed.overviewEnabled === "boolean") {
    preferences.overviewEnabled = parsed.overviewEnabled;
  }
  if (typeof parsed.chatBackdropEnabled === "boolean") {
    preferences.chatBackdropEnabled = parsed.chatBackdropEnabled;
  }
  if (typeof parsed.bedsideScreenEnabled === "boolean") {
    preferences.bedsideScreenEnabled = parsed.bedsideScreenEnabled;
  }
  if (typeof parsed.newChatDashboardEnabled === "boolean") {
    preferences.newChatDashboardEnabled = parsed.newChatDashboardEnabled;
  }
  if (typeof parsed.autoModelEnabled === "boolean") {
    preferences.autoModelEnabled = parsed.autoModelEnabled;
  }
  if (Array.isArray(parsed.modelFavorites)) {
    preferences.modelFavorites = parsed.modelFavorites.filter(
      (favorite) =>
        typeof favorite === "object" &&
        favorite !== null &&
        typeof favorite.provider === "string" &&
        favorite.provider.length > 0 &&
        typeof favorite.model === "string" &&
        favorite.model.trim().length > 0,
    );
  }
  if (typeof parsed.threadListSettledShelfExpanded === "boolean") {
    preferences.threadListSettledShelfExpanded = parsed.threadListSettledShelfExpanded;
  }
  if (typeof parsed.threadListSnoozedShelfExpanded === "boolean") {
    preferences.threadListSnoozedShelfExpanded = parsed.threadListSnoozedShelfExpanded;
  }
  if (typeof parsed.threadListWorkingShelfExpanded === "boolean") {
    preferences.threadListWorkingShelfExpanded = parsed.threadListWorkingShelfExpanded;
  }
  if (typeof parsed.threadListBoxes === "boolean") {
    preferences.threadListBoxes = parsed.threadListBoxes;
  }
  if (typeof parsed.threadListChatTab === "string") {
    preferences.threadListChatTab = parsed.threadListChatTab;
  }
  if (Array.isArray(parsed.relayRouteIds)) {
    preferences.relayRouteIds = parsed.relayRouteIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  if (isThreadListFilters(parsed.threadListFilters)) {
    preferences.threadListFilters = parsed.threadListFilters;
  }
  if (isPullRequestListPreferences(parsed.pullRequestListFilters)) {
    preferences.pullRequestListFilters = parsed.pullRequestListFilters;
  }
  return preferences;
}

export const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null): Preferences | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );
      return null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("payload" in parsed) ||
      typeof parsed.payload !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    const preferences = parsePayload(parsed.payload);
    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: unknown,
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);
    return [next, next] as const;
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, { payload, updatedAt: timestamp });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);
      return;
    }
    yield* secureStorage
      .removeItem(PREFERENCES_FALLBACK_KEY)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove the mobile preferences fallback.").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );
  });

  const loadUnlocked = Effect.gen(function* () {
    const [databaseResult, fallbackResult] = yield* Effect.all(
      [
        Effect.result(database.loadPreferencesJson),
        Effect.result(secureStorage.getItem(PREFERENCES_FALLBACK_KEY)),
      ],
      { concurrency: 2 },
    );
    const databaseAvailable = databaseResult._tag === "Success";
    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    let fallbackJson: string | null = null;
    if (fallbackResult._tag === "Success") {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);
    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;
    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: Preferences | null = null;
    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));
      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));
      if (fallbackJson !== null) {
        yield* secureStorage
          .removeItem(PREFERENCES_FALLBACK_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove a stale mobile preferences fallback.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage.getItem(PREFERENCES_KEY);
      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;
      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(loadUnlocked)
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;
          const patch = yield* Effect.try({
            try: () => transform(current),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });
          const next: Preferences = { ...current, ...patch };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);
          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());

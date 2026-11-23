import type {
  ModelPreferencesQuery,
  ModelPreferencesResult,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  matchModelRankingCategory,
  migrateModelRankings,
  currentModelRankingCandidate,
  modelRankingCatalog,
  modelRankingEntryAvailability,
  orderedModelRankingEntries,
} from "@t3tools/shared/modelRankings";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { accountUnavailable } from "./accountAvailability.ts";

export class ModelPreferences extends Context.Service<
  ModelPreferences,
  {
    readonly lookup: (
      query: ModelPreferencesQuery,
    ) => Effect.Effect<ModelPreferencesResult, ServerSettingsError>;
  }
>()("t3/provider/ModelPreferences") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const lookup = Effect.fn("ModelPreferences.lookup")(function* (query: ModelPreferencesQuery) {
    const settings = yield* settingsService.getSettings;
    const snapshots = yield* providers.getProviders;
    const category = matchModelRankingCategory(
      migrateModelRankings(settings.modelRankings, settings.providerInstances, snapshots),
      query.task,
    );
    const notes = [
      "Explicit user model choices take priority. These family preferences resolve to current catalog models and inherit new releases automatically. Check orchestrator_capabilities and usage_limits before delegating. Never select old, legacy or supersededBy models without a concrete valid reason, such as the user requesting that exact version; explain the exception. Preferences never override quota or availability.",
    ];
    if (!category)
      return {
        matchedCategory: null,
        recommendations: [],
        unavailableCount: 0,
        notes: ["No saved preferences match this task. Choose from the current catalog.", ...notes],
      };
    const now = yield* Clock.currentTimeMillis;
    // Keep unavailable successors in the catalog so their older versions stay superseded.
    const byInstance = new Map(snapshots.map((provider) => [provider.instanceId, provider]));
    const catalog = modelRankingCatalog(settings, snapshots).map((candidate) => {
      const provider = byInstance.get(candidate.selection.instanceId);
      const account = provider && accountUnavailable(provider, now, candidate.selection.model);
      return account ? { ...candidate, unavailableReason: account.reason } : candidate;
    });
    const ordered = orderedModelRankingEntries(category);
    const available = ordered.filter(
      (entry) => modelRankingEntryAvailability(entry, catalog) === null,
    );
    const unavailableCount = ordered.length - available.length;
    if (unavailableCount > 0)
      notes.push(
        `${unavailableCount} saved preference(s) are unavailable or superseded; returning the next available ranked choices.`,
      );
    if (ordered.length === 0)
      notes.push(
        "This category has no ranked families. Unranked contenders are not recommendations.",
      );
    else if (available.length === 0)
      notes.push(
        "No ranked choices are currently available. Use the current catalog as fallback; no user preference is implied.",
      );
    return {
      matchedCategory: { id: category.id, name: category.name },
      recommendations: available.slice(0, Math.min(query.limit ?? 3, 5)).map((entry) => {
        const candidate = currentModelRankingCandidate(entry, catalog)!;
        const note = entry.note?.replace(/\s+/g, " ").trim();
        return {
          ...("family" in entry ? { family: entry.family } : {}),
          providerInstanceId: candidate.selection.instanceId,
          model: candidate.selection.model,
          ...(entry.tier ? { tier: entry.tier } : {}),
          ...(note ? { note: note.length > 180 ? `${note.slice(0, 179)}…` : note } : {}),
        };
      }),
      unavailableCount,
      notes,
    };
  });
  return ModelPreferences.of({ lookup });
});

export const layer = Layer.effect(ModelPreferences, make);

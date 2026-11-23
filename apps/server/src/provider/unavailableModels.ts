/**
 * Models a provider said are gone (deprecated, retired, unknown), per provider instance.
 * The registry files them as legacy with the provider's words, so pickers stop offering
 * them and agents cannot delegate to them twice. Kept in caches/unavailable-models.json:
 * at most MAX_UNAVAILABLE_MODELS entries, each for a week, and dropped early when a later
 * run on the model completes.
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const UNAVAILABLE_MODELS_FILE = "unavailable-models.json";
export const MAX_UNAVAILABLE_MODELS = 200;
export const UNAVAILABLE_MODEL_TTL_MS = 7 * 24 * 60 * 60_000;
/** Larger files are not read: 200 entries of bounded fields stay far below this. */
export const MAX_UNAVAILABLE_MODELS_FILE_BYTES = 256 * 1024;
const MAX_REASON_LENGTH = 200;

const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const UnavailableModel = Schema.Struct({
  instanceId: Bounded(128),
  model: Bounded(256),
  reason: Bounded(MAX_REASON_LENGTH),
  /** Epoch milliseconds of the failed run. */
  at: Schema.Number,
});
export type UnavailableModel = typeof UnavailableModel.Type;

export const UnavailableModelsFile = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(UnavailableModel),
});

/** The provider's words, on one line and short enough to show beside the model. */
export function unavailableModelReason(message: string): string {
  const text = message.trim().replace(/\s+/g, " ");
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

const sameModel = (entry: UnavailableModel, instanceId: string, model: string) =>
  entry.instanceId === instanceId && entry.model === model;

/** Entries still in force. */
export function liveUnavailableModels(
  entries: ReadonlyArray<UnavailableModel>,
  now: number,
): ReadonlyArray<UnavailableModel> {
  return entries.filter((entry) => now - entry.at < UNAVAILABLE_MODEL_TTL_MS);
}

/** Adds or refreshes one model, newest last; expired and overflow entries drop. */
export function rememberUnavailableModel(
  entries: ReadonlyArray<UnavailableModel>,
  entry: UnavailableModel,
  now: number,
): ReadonlyArray<UnavailableModel> {
  if (entry.instanceId.length > 128 || entry.model.length > 256) return entries;
  return [
    ...liveUnavailableModels(entries, now).filter(
      (saved) => !sameModel(saved, entry.instanceId, entry.model),
    ),
    { ...entry, reason: unavailableModelReason(entry.reason) },
  ].slice(-MAX_UNAVAILABLE_MODELS);
}

/** Drops one model; the same array when it was not listed. */
export function forgetUnavailableModel(
  entries: ReadonlyArray<UnavailableModel>,
  instanceId: string,
  model: string,
): ReadonlyArray<UnavailableModel> {
  return entries.some((entry) => sameModel(entry, instanceId, model))
    ? entries.filter((entry) => !sameModel(entry, instanceId, model))
    : entries;
}

/**
 * Files each remembered model as legacy with the provider's words. Runs before
 * supersession, so a gone model never retires an older one that still works.
 */
export function markUnavailableModels(
  providers: ReadonlyArray<ServerProvider>,
  entries: ReadonlyArray<UnavailableModel>,
  now: number,
): ReadonlyArray<ServerProvider> {
  const live = liveUnavailableModels(entries, now);
  if (live.length === 0) return providers;
  return providers.map((provider) => {
    let changed = false;
    const models = provider.models.map((model) => {
      const entry = live.find((saved) => sameModel(saved, provider.instanceId, model.slug));
      if (!entry) return model;
      changed = true;
      return {
        ...model,
        isLegacy: true,
        ...(entry.reason.trim() ? { unavailableReason: entry.reason.trim() } : {}),
      };
    });
    return changed ? { ...provider, models } : provider;
  });
}

import { type OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";

/** Failures another model can get past: usage limits and provider-side refusals or errors. */
export function canContinueOnAnotherModel(
  errorClass: OrchestrationV2ProviderFailureClass | null | undefined,
): boolean {
  return errorClass === "usage_limit" || errorClass === "provider_error";
}

// The strongest general harnesses first; others keep the order they were given in.
const DRIVER_ORDER = ["claudeAgent", "codex", "grok"];

/**
 * The providers a chat whose model stopped can continue on, strongest harness first: not the
 * one that failed, and not one whose own last run failed.
 */
export function continueOnProviders<
  P extends {
    readonly instanceId: string;
    readonly driver: string;
    readonly recentFailure?:
      | { readonly kind: string; readonly modelIds?: ReadonlyArray<string> }
      | undefined;
  },
>(providers: ReadonlyArray<P>, failedInstanceId: string | null): P[] {
  const rank = (driver: string) => {
    const index = DRIVER_ORDER.indexOf(driver);
    return index === -1 ? DRIVER_ORDER.length : index;
  };
  // A copied array sorted in place: the phone's Hermes has no Array#toSorted.
  const ranked = providers
    .filter(
      (provider) =>
        provider.instanceId !== failedInstanceId &&
        (provider.recentFailure === undefined ||
          (provider.recentFailure.kind === "usage_limit" &&
            provider.recentFailure.modelIds !== undefined)),
    )
    .map((provider, order) => ({ provider, order }));
  ranked.sort((a, b) => rank(a.provider.driver) - rank(b.provider.driver) || a.order - b.order);
  return ranked.map(({ provider }) => provider);
}

export interface ContinueOnHistoryEntry {
  /** "user" for a chat the owner started; subagent chats never count. */
  readonly createdBy: string;
  readonly createdAt: number;
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
}

export interface UsedModel {
  readonly instanceId: string;
  readonly model: string;
  /** The options (effort and so on) the owner most often runs this model with. */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

/** The main button plus three in the menu. */
export const CONTINUE_ON_CHOICES = 4;
const USED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// A chat from a week ago counts half: a newly adopted model shows up within days.
const USED_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
// Below a tenth of the favourite's use a model was tried, not adopted.
const USED_SHARE = 0.1;

/**
 * The models the owner starts chats with, most used first. One-off experiments stay out: the
 * choices offered when a model stops should be ones the owner would pick anyway.
 */
export function usedModels(
  history: ReadonlyArray<ContinueOnHistoryEntry>,
  now: number,
): UsedModel[] {
  const byModel = new Map<
    string,
    {
      score: number;
      at: number;
      readonly instanceId: string;
      readonly model: string;
      readonly variants: Map<string, { score: number; at: number; options: UsedModel["options"] }>;
    }
  >();
  for (const chat of history) {
    const age = now - chat.createdAt;
    if (chat.createdBy !== "user" || !(age >= 0) || age > USED_WINDOW_MS) continue;
    const weight = 0.5 ** (age / USED_HALF_LIFE_MS);
    const { instanceId, model, options } = chat.modelSelection;
    const key = `${instanceId}\0${model}`;
    const entry = byModel.get(key) ?? { score: 0, at: 0, instanceId, model, variants: new Map() };
    entry.score += weight;
    entry.at = Math.max(entry.at, chat.createdAt);
    const variantKey = JSON.stringify(
      (options ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
    );
    const variant = entry.variants.get(variantKey) ?? { score: 0, at: 0, options };
    variant.score += weight;
    variant.at = Math.max(variant.at, chat.createdAt);
    entry.variants.set(variantKey, variant);
    byModel.set(key, entry);
  }
  const ranked = Array.from(byModel.values());
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.at - a.at ||
      `${a.instanceId}\0${a.model}`.localeCompare(`${b.instanceId}\0${b.model}`),
  );
  const floor = (ranked[0]?.score ?? 0) * USED_SHARE;
  return ranked
    .filter((entry) => entry.score >= floor)
    .map(({ instanceId, model, variants }) => {
      const usual = Array.from(variants.values());
      usual.sort((a, b) => b.score - a.score || b.at - a.at);
      const options = usual[0]?.options;
      return options && options.length > 0 ? { instanceId, model, options } : { instanceId, model };
    });
}

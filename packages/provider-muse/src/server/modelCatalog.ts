import type { SendUserTurnOptions } from "@muse-code/sdk";
import { ModelCapabilities, type ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { buildBooleanOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";
import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "@t3tools/provider-core/server/selectionTransition";
import {
  createModelCapabilities,
  getModelSelectionBooleanOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHost } from "./sdk.ts";

type MuseReasoningEffort = NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>;

const REASONING_EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
} satisfies Record<MuseReasoningEffort, string>;

/** Muse's tiers, weakest first. */
const TIERS = Object.keys(REASONING_EFFORT_LABELS) as ReadonlyArray<MuseReasoningEffort>;

const isMuseReasoningEffort = (tier: string): tier is MuseReasoningEffort =>
  Object.hasOwn(REASONING_EFFORT_LABELS, tier);

/** Used when Muse does not report a model's efforts (custom slugs, older hosts, "unknown"). */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Muse's own CLI default. */
const FALLBACK_DEFAULT_EFFORT = "high";

const ModelCatalogEntry = Schema.Struct({
  modelId: Schema.NonEmptyString,
  displayLabel: Schema.String,
  providerId: Schema.String,
  isDefault: Schema.Boolean,
  variants: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")])),
  defaultReasoningEffort: Schema.optional(Schema.String),
  reasoningEffortVariants: Schema.optional(
    Schema.Array(
      Schema.Struct({ tier: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeModelList = Schema.decodeUnknownEffect(
  Schema.Struct({ providerId: Schema.String, models: Schema.Array(ModelCatalogEntry) }),
);

export const MUSE_CONTRIBUTOR_MODE_OPTION = "contributorMode";

/** Per chat, off unless switched on: the plan gives more usage, and Meta may train on the content. */
const CONTRIBUTOR_MODE = buildBooleanOptionDescriptor({
  id: MUSE_CONTRIBUTOR_MODE_OPTION,
  label: "Contributor mode",
  description: "More usage from your plan. Meta may use this chat to train its models.",
  currentValue: false,
  trainsOnContent: true,
});

/**
 * Models Muse refuses with contributor mode on ("does not exist or you lack access", seen with
 * 1.4.20 on a Power plan). Meta's price list has them as Standard only, yet `model/list`
 * returns them in both modes, so the catalog cannot tell.
 */
const STANDARD_ONLY_MODEL = /^muse-ember(-|$)/u;

/** Whether Muse runs this model in contributor mode. An unknown id counts as yes. */
export function museSupportsContributorMode(modelId: string | null | undefined): boolean {
  return !modelId || !STANDARD_ONLY_MODEL.test(modelId);
}

/**
 * Whether a chat's selection asks for contributor mode. Anything but an explicit yes is no,
 * and a model Muse does not run in that mode never asks for it.
 */
export function museContributorMode(selection: ModelSelection | null | undefined): boolean {
  return (
    getModelSelectionBooleanOptionValue(selection, MUSE_CONTRIBUTOR_MODE_OPTION) === true &&
    museSupportsContributorMode(selection?.model)
  );
}

/**
 * Contributor mode is a launch flag of the Muse host, so changing it needs a fresh host
 * that resumes the session; every other choice applies on the next turn.
 */
export function museSelectionTransition(
  input: Pick<ProviderSelectionTransitionInput, "current" | "target">,
): ProviderSelectionTransitionPlan {
  return museContributorMode(input.current) === museContributorMode(input.target)
    ? { type: "apply_on_next_turn" }
    : { type: "restart_session" };
}

/** Builds the reasoning picker from a `model/list` row, or the fallback when called without one. */
export function museModelCapabilities(
  model?: Pick<
    typeof ModelCatalogEntry.Type,
    "variants" | "defaultReasoningEffort" | "reasoningEffortVariants"
  > & { readonly modelId?: string },
): ModelCapabilities {
  const contributorMode = museSupportsContributorMode(model?.modelId) ? [CONTRIBUTOR_MODE] : [];
  const reported = model?.variants !== undefined && model.variants !== "unknown";
  const efforts = (reported ? model.variants : FALLBACK_EFFORTS).filter(isMuseReasoningEffort);
  const preferredDefault = reported ? model?.defaultReasoningEffort : FALLBACK_DEFAULT_EFFORT;
  const defaultValue = efforts.find((tier) => tier === preferredDefault) ?? efforts[0];
  if (!defaultValue) return createModelCapabilities({ optionDescriptors: contributorMode });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: defaultValue,
        options: efforts.map((id) => {
          const description = model?.reasoningEffortVariants?.find(
            (variant) => variant.tier === id,
          )?.description;
          return {
            id,
            label: REASONING_EFFORT_LABELS[id],
            ...(id === defaultValue ? { isDefault: true } : {}),
            ...(description ? { description } : {}),
          };
        }),
      },
      ...contributorMode,
    ],
  });
}

/**
 * Apply the advertised model choices to saved, remembered and implicit efforts at dispatch.
 * Without capabilities (the catalog has not listed the model yet) a chosen tier goes as is
 * and an unset one stays unset, so Muse applies the model's own default.
 */
export function resolveMuseReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  const known = effort !== undefined && isMuseReasoningEffort(effort) ? effort : undefined;
  if (!capabilities) return known;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((descriptor) => descriptor.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  // A tier this model does not offer (saved on another model) takes the nearest one it
  // does, the stronger on a tie, rather than the default, which may be far weaker.
  if (known && !descriptor.options.some((option) => option.id === known)) {
    const rank = (tier: string) => TIERS.indexOf(tier as MuseReasoningEffort);
    let nearest: string | undefined;
    for (const { id } of descriptor.options) {
      if (rank(id) < 0) continue;
      const distance = Math.abs(rank(id) - rank(known));
      const best = nearest === undefined ? Infinity : Math.abs(rank(nearest) - rank(known));
      if (distance < best || (distance === best && rank(id) > rank(nearest!))) nearest = id;
    }
    if (nearest) return nearest;
  }
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

/** Muse labels a model with its id; say it as a name ("Muse Wonder Full 1.0"). */
export function museModelName(modelId: string, displayLabel: string): string {
  const label = displayLabel.trim();
  if (label && label !== modelId) return label;
  return modelId
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

export const discoverMuseModels = Effect.fn("discoverMuseModels")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv | undefined,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const host = yield* Effect.acquireRelease(
    createMuseSdkHostEffect(
      {
        binaryPath: settings.binaryPath,
        ...(environment ? { environment } : {}),
        ...(cwd ? { cwd } : {}),
        readOnly: true,
        startupTimeoutMs: 8_000,
      },
      createHost,
    ),
    (host: MuseSdkHost) => Effect.promise(() => host.close()),
    { interruptible: true },
  );
  const result = yield* Effect.tryPromise(() => host.connection.request("model/list", {}));
  const catalog = yield* decodeModelList(result);
  if (catalog.providerId !== "meta") {
    return yield* new MuseCatalogError({ detail: "Muse returned a catalog for another provider." });
  }
  const seen = new Set<string>();
  return catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [
      {
        slug: model.modelId,
        name: museModelName(model.modelId, model.displayLabel),
        isCustom: false,
        isDefault: model.isDefault,
        capabilities: museModelCapabilities(model),
      },
    ];
  });
});

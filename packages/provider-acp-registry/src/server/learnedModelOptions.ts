import {
  ProviderOptionDescriptor,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

/** How many models' options the file keeps; agents list a few dozen. */
const MAX_SAVED_MODELS = 256;

const SavedModel = Schema.Struct({
  slug: Schema.String,
  read: Schema.optionalKey(Schema.Literal(true)),
  optionDescriptors: Schema.Array(ProviderOptionDescriptor),
});
type SavedModel = typeof SavedModel.Type;
const SavedModels = Schema.fromJsonString(Schema.Array(SavedModel));
const decodeSaved = Schema.decodeUnknownEffect(SavedModels);
const encodeSaved = Schema.encodeEffect(SavedModels);

const descriptorsOf = (model: ServerProviderModel) => model.capabilities?.optionDescriptors ?? [];

/**
 * The given models with what was saved for each: a saved entry fills in a model that knows
 * fewer options, and saved models the list lacks come after it, so a check run right after a
 * restart still finds every model's levels.
 */
export function withSavedModelOptions(
  models: ReadonlyArray<ServerProviderModel>,
  saved: ReadonlyArray<SavedModel>,
): ReadonlyArray<ServerProviderModel> {
  const bySlug = new Map(saved.map((entry) => [entry.slug, entry]));
  const listed = new Set(models.map((model) => model.slug));
  return [
    ...models.map((model) => {
      const entry = bySlug.get(model.slug);
      return model.isCustom ||
        entry === undefined ||
        (!entry.read && entry.optionDescriptors.length <= descriptorsOf(model).length)
        ? model
        : {
            ...model,
            capabilities: createModelCapabilities({ optionDescriptors: entry.optionDescriptors }),
          };
    }),
    ...saved
      .filter((entry) => !listed.has(entry.slug))
      .map((entry): ServerProviderModel => ({
        slug: entry.slug,
        name: entry.slug,
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: entry.optionDescriptors }),
      })),
  ];
}

/** The saved entries after a check: models that report options replace theirs, others stay. */
export function rememberModelOptions(
  saved: ReadonlyArray<SavedModel>,
  models: ReadonlyArray<ServerProviderModel>,
  readModelIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<SavedModel> {
  const previous = new Map(saved.map((entry) => [entry.slug, entry]));
  const reported = models
    .filter((model) => !model.isCustom)
    .flatMap((model) => {
      const entry = previous.get(model.slug);
      const verified = readModelIds.has(model.slug);
      const options = descriptorsOf(model);
      if (!verified && options.length === 0) return [];
      if (!verified && entry && (entry.read || entry.optionDescriptors.length > options.length))
        return [entry];
      return [
        {
          slug: model.slug,
          optionDescriptors: options,
          ...(verified || entry?.read ? { read: true as const } : {}),
        },
      ];
    });
  const replaced = new Set(reported.map((entry) => entry.slug));
  return [...reported, ...saved.filter((entry) => !replaced.has(entry.slug))].slice(
    0,
    MAX_SAVED_MODELS,
  );
}

/**
 * Per-model options (effort levels, speeds) the probe learns by switching an agent's model,
 * saved beside the provider status cache. A restart used to drop them: the agent reports only
 * its current model's options, and a probe under startup load reads few of the others.
 */
export const makeAcpRegistryLearnedModelOptions = Effect.fn("makeAcpRegistryLearnedModelOptions")(
  function* (input: { readonly cacheDir: string; readonly instanceId: ProviderInstanceId }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.cacheDir, `acp-model-options-${input.instanceId}.json`);
    const saved = yield* Ref.make(
      yield* fs.readFileString(filePath).pipe(
        Effect.flatMap(decodeSaved),
        Effect.orElseSucceed((): ReadonlyArray<SavedModel> => []),
      ),
    );
    let persisted = yield* encodeSaved(yield* Ref.get(saved)).pipe(Effect.orDie);
    const lock = yield* Semaphore.make(1);
    return {
      readModelIds: Ref.get(saved).pipe(
        Effect.map(
          (entries) => new Set(entries.filter((entry) => entry.read).map((entry) => entry.slug)),
        ),
      ),
      withSaved: (models: ReadonlyArray<ServerProviderModel>) =>
        Ref.get(saved).pipe(Effect.map((entries) => withSavedModelOptions(models, entries))),
      remember: (models: ReadonlyArray<ServerProviderModel>, readModelIds?: ReadonlySet<string>) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(saved);
            const next = rememberModelOptions(current, models, readModelIds);
            const contents = yield* encodeSaved(next);
            yield* Ref.set(saved, next);
            if (contents === persisted) return;
            yield* writeFileStringAtomically({ filePath, contents }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            persisted = contents;
          }).pipe(
            Effect.tapError(() => Effect.logWarning("Could not save ACP model options.")),
            Effect.ignore,
          ),
        ),
    };
  },
);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";
import { readyProviderModelSelection } from "@t3tools/shared/serverSettings";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateChatTabs"
  | "generateReviewGuide"
  | "rewriteProse";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/**
 * Settled as unable to write: off, missing from this build, signed out, or checked and not
 * installed. A provider still being checked at startup is not, so its work waits for it.
 */
const cannotWrite = (snapshot: ServerProvider) =>
  !snapshot.enabled ||
  !isProviderAvailable(snapshot) ||
  !isProviderTextGenerationCapable(snapshot) ||
  snapshot.status === "disabled" ||
  snapshot.auth.status === "unauthenticated" ||
  (!snapshot.installed && snapshot.status === "error");

/**
 * The selection an operation runs on: the chosen one unless its provider cannot write, else
 * a ready provider's cheap default. A fresh install picks Codex, which a machine with only
 * Claude (or any other single harness) does not have.
 */
const routeSelection = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  selection: ModelSelection,
): Effect.Effect<ModelSelection> =>
  Effect.gen(function* () {
    const chosen = yield* registry.getInstance(selection.instanceId);
    if (chosen !== undefined && !cannotWrite(yield* chosen.snapshot.getSnapshot)) return selection;
    const snapshots = yield* Effect.forEach(
      yield* registry.listInstances,
      (instance) => instance.snapshot.getSnapshot,
    );
    return (
      readyProviderModelSelection(snapshots, {
        textGeneration: true,
        byDriver: DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
      }) ?? selection
    );
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  /** Runs one operation on the instance its (possibly rerouted) selection names. */
  const run = <I extends { readonly modelSelection: ModelSelection }, A>(
    operation: TextGenerationOp,
    input: I,
    use: (
      generation: ProviderInstance["textGeneration"],
      input: I,
    ) => Effect.Effect<A, TextGenerationError>,
  ) =>
    routeSelection(registry, input.modelSelection).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstance(registry, operation, modelSelection.instanceId).pipe(
          Effect.flatMap((generation) =>
            use(
              generation,
              modelSelection === input.modelSelection ? input : { ...input, modelSelection },
            ),
          ),
        ),
      ),
    );
  return TextGeneration.of({
    rewriteProse: (input) =>
      run("rewriteProse", input, (generation, input) =>
        generation.rewriteProse
          ? generation.rewriteProse(input)
          : Effect.fail(
              new TextGenerationError({
                operation: "rewriteProse",
                detail: "This provider does not support casual voice.",
              }),
            ),
      ),
    generateCommitMessage: (input) =>
      run("generateCommitMessage", input, (textGeneration, input) =>
        textGeneration.generateCommitMessage(input),
      ),
    generatePrContent: (input) =>
      run("generatePrContent", input, (textGeneration, input) =>
        textGeneration.generatePrContent(input),
      ),
    generateBranchName: (input) =>
      run("generateBranchName", input, (textGeneration, input) =>
        textGeneration.generateBranchName(input),
      ),
    generateChatTabs: (input) =>
      run("generateChatTabs", input, (textGeneration, input) =>
        textGeneration.generateChatTabs(input),
      ),
    generateReviewGuide: (input) =>
      run("generateReviewGuide", input, (textGeneration, input) =>
        textGeneration.generateReviewGuide(input),
      ),
    generateThreadTitle: (input) =>
      run("generateThreadTitle", input, (textGeneration, input) =>
        Effect.gen(function* () {
          const linkedContext =
            input.linkedContext ??
            (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
              Effect.provideService(
                SourceControlProviderRegistry.SourceControlProviderRegistry,
                sourceControl,
              ),
            ));
          return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
        }),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);

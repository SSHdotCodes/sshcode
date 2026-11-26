import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { configuredOpenCodeEffort } from "./openCodeVariant.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { OpenCode2Model } from "./status.ts";
import { httpFailureOf } from "./v2/OpenCode2Server.ts";

/**
 * How long a provider read may take before the models are listed without it.
 * A server loads its provider list with the rest of its catalog, which takes a
 * couple of seconds on a cold start, and the model loader retries while the
 * catalog is empty anyway. Past that, the names are not worth waiting for.
 */
const PROVIDER_NAME_TIMEOUT = "3 seconds";

/**
 * A newly spawned OpenCode 2 server initializes its workspace lazily on the
 * first `/api/model` read and replies 503 if watcher/catalog startup is still
 * running. Retrying on the same borrowed server lets that boot finish instead
 * of failing the status check and falling back to a stale list.
 */
const SERVICE_UNAVAILABLE_RETRIES = 3;
const SERVICE_UNAVAILABLE_RETRY_WAIT = "2 seconds";

const isServiceUnavailable = (cause: unknown): boolean =>
  httpFailureOf(cause)?.response?.status === 503;

/**
 * Reads the model catalog of an OpenCode 2 server, and names the provider each
 * model belongs to.
 *
 * One instance fronts several providers: OpenCode Zen, OpenCode Go, and
 * whatever the user added themselves. Their catalogues overlap, so a model's
 * name alone cannot say which provider listed it and two rows for it read the
 * same. Reading the server's provider list in the same connection as its
 * models is what tells them apart.
 *
 * A server that cannot name its providers still lists its models, so the
 * provider read is optional: a model whose provider went unnamed keeps only
 * its id, which the status check then uses as the label. The models carry the
 * payload and the names are decoration, so a provider read is bounded as well
 * as optional: one that never answers must not hold the models back. Both
 * reads are issued at once, and only the slower of the two is waited on.
 */
export const loadOpenCode2Catalog = (
  client: OpenCodeClient,
  directory: string | undefined,
): Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError> => {
  const query = directory === undefined ? {} : { location: { directory } };
  return Effect.all(
    {
      models: client.model.list(query),
      providers: client.provider
        .list(query)
        .pipe(Effect.timeout(PROVIDER_NAME_TIMEOUT), Effect.option),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.retry({
      times: SERVICE_UNAVAILABLE_RETRIES,
      schedule: Schedule.spaced(SERVICE_UNAVAILABLE_RETRY_WAIT),
      while: isServiceUnavailable,
    }),
    Effect.map(({ models, providers }) => {
      const providerNames = new Map(
        (Option.getOrUndefined(providers)?.data ?? []).map((provider) => [
          provider.id,
          provider.name,
        ]),
      );
      return models.data.map((model) => {
        const providerName = providerNames.get(model.providerID);
        const effort =
          configuredOpenCodeEffort(model.body) ?? configuredOpenCodeEffort(model.settings);
        const defaultVariant =
          effort === undefined ? undefined : model.variants.find(({ id }) => id === effort)?.id;
        return {
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          ...(providerName ? { providerName } : {}),
          ...(defaultVariant ? { defaultVariant } : {}),
          variants: model.variants.map((variant) => ({ id: variant.id })),
          // The server's own catalogue: every listed model says what it reads.
          imageInput: model.capabilities.input.includes("image"),
        };
      });
    }),
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "model.list",
          detail: "The OpenCode server could not list its models.",
          cause,
        }),
    ),
  );
};

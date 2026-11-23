import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

/** How long a descriptor answered by an address stands in for asking it again. */
export const RECENT_DESCRIPTOR_TTL_MS = 10_000;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  );
});

/**
 * Descriptors that addresses answered moments ago. A connect checks each
 * route's descriptor, then authorizes and prepares over the chosen route, and
 * each of those steps used to ask the same address again. On a cellular link
 * every ask is a full round trip before the socket can open. Route checks
 * still always ask, since they test reachability, and record the answer for
 * the steps that follow.
 */
export class RecentEnvironmentDescriptors extends Context.Service<
  RecentEnvironmentDescriptors,
  {
    readonly remember: (
      httpBaseUrl: string,
      descriptor: ExecutionEnvironmentDescriptor,
    ) => Effect.Effect<void>;
    readonly recent: (
      httpBaseUrl: string,
    ) => Effect.Effect<Option.Option<ExecutionEnvironmentDescriptor>>;
  }
>()("@t3tools/client-runtime/environment/descriptor/RecentEnvironmentDescriptors") {}

export const layerRecentEnvironmentDescriptors = Layer.effect(
  RecentEnvironmentDescriptors,
  Effect.gen(function* () {
    const entries = yield* Ref.make(
      new Map<
        string,
        { readonly descriptor: ExecutionEnvironmentDescriptor; readonly atEpochMs: number }
      >(),
    );
    return RecentEnvironmentDescriptors.of({
      remember: (httpBaseUrl, descriptor) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((atEpochMs) =>
            Ref.update(entries, (current) =>
              new Map(current).set(httpBaseUrl, { descriptor, atEpochMs }),
            ),
          ),
        ),
      recent: (httpBaseUrl) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(entries)).get(httpBaseUrl);
          const now = yield* Clock.currentTimeMillis;
          return entry !== undefined && entry.atEpochMs + RECENT_DESCRIPTOR_TTL_MS > now
            ? Option.some(entry.descriptor)
            : Option.none();
        }),
    });
  }),
);

/**
 * The address's descriptor, reusing one it answered within
 * {@link RECENT_DESCRIPTOR_TTL_MS} when the cache is available.
 */
export const fetchRecentRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRecentRemoteEnvironmentDescriptor",
)(function* (
  recentDescriptors: Option.Option<RecentEnvironmentDescriptors["Service"]>,
  input: { readonly httpBaseUrl: string; readonly timeoutMs?: number },
) {
  if (Option.isSome(recentDescriptors)) {
    const recent = yield* recentDescriptors.value.recent(input.httpBaseUrl);
    if (Option.isSome(recent)) return recent.value;
  }
  const descriptor = yield* fetchRemoteEnvironmentDescriptor(input);
  if (Option.isSome(recentDescriptors)) {
    yield* recentDescriptors.value.remember(input.httpBaseUrl, descriptor);
  }
  return descriptor;
});

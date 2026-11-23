import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import {
  NetworkTiming,
  RequestProgress,
  makeNetworkTiming,
  withReceiveIdleTimeout,
} from "../connection/networkTiming.ts";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
    });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient | NetworkTiming> =>
  Layer.merge(
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const clock = yield* Clock.Clock;
        const timing = yield* NetworkTiming;
        return HttpClient.transformResponse(client, (responseEffect) =>
          Effect.gen(function* () {
            const progress = yield* RequestProgress;
            const startedAt = clock.monotonicTimeNanosUnsafe();
            const response = yield* responseEffect;
            timing.observe(
              response.url,
              Number(clock.monotonicTimeNanosUnsafe() - startedAt) / 1_000_000,
            );
            if (progress === undefined) return response;
            progress.received();
            const stream = response.stream.pipe(
              Stream.tap((bytes) =>
                Effect.sync(() => {
                  if (bytes.byteLength > 0) progress.received();
                }),
              ),
            );
            const arrayBuffer = yield* stream.pipe(
              Stream.runCollect,
              Effect.catchIf(
                (error) => error.reason._tag === "EmptyBodyError",
                () => Effect.succeed([]),
              ),
              Effect.map((chunks) => {
                const bytes = new Uint8Array(
                  chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
                );
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                return bytes.buffer;
              }),
              Effect.cached,
            );
            const text = arrayBuffer.pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));
            const json = text.pipe(
              Effect.flatMap((value) =>
                Effect.try({
                  // The endpoint's schema validates the JSON; this matches the HTTP client's parser.
                  // @effect-diagnostics-next-line preferSchemaOverJson:off
                  try: () => (value === "" ? null : (JSON.parse(value) as Schema.Json)),
                  catch: (cause) =>
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.DecodeError({
                        request: response.request,
                        response,
                        cause,
                      }),
                    }),
                }),
              ),
            );
            // Consume the body once, tracking actual reads rather than the
            // whole-response fetch promise. Keep status, cookies and headers intact.
            return Object.create(response, {
              arrayBuffer: { value: arrayBuffer },
              text: { value: text },
              json: { value: json },
              stream: { value: stream },
            }) as typeof response;
          }),
        );
      }),
    ).pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    ),
    HttpObservability.layer,
  ).pipe(Layer.provideMerge(Layer.sync(NetworkTiming, makeNetworkTiming)));

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

/** Contract-derived request URLs for authentication proofs, tracing, and structured errors. */
export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (
    cause instanceof RemoteEnvironmentAuthTimeoutError ||
    cause instanceof RemoteEnvironmentAuthInvalidJsonError ||
    cause instanceof RemoteEnvironmentAuthFetchError ||
    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError
  ) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  withReceiveIdleTimeout(requestUrl, timeoutMs, request, (budget) =>
    Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, budget)),
  ).pipe(Effect.catch((cause) => failRemoteRequest(requestUrl, cause)));

import {
  type DpopVerificationFailureCode as DpopVerificationFailureCodeType,
  verifyDpopProof,
} from "@t3tools/shared/dpop";
import type { DpopFailureReason } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthInvalidCredentialError,
  type ServerAuthInternalError,
} from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { withDpopReplayLock } from "./DpopReplayLock.ts";

/** Secret store name prefix of DPoP replay markers. The server prunes expired ones. */
export const DPOP_REPLAY_MARKER_PREFIX = "dpop-proof-";

export const mapDpopFailureReason = (code: DpopVerificationFailureCodeType): DpopFailureReason => {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
};

export const mapDpopReplayStoreError = (
  error: ServerSecretStore.SecretStoreError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError =>
  ServerSecretStore.isSecretAlreadyExistsError(error)
    ? new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed.",
        dpopFailureReason: "replay",
        cause: error,
      })
    : new ServerAuthDpopReplayStateRecordError({
        cause: error,
      });

export const prepareRequestDpopProof = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  /** Overrides the `DPoP` header for requests that cannot carry one, such as a WebSocket upgrade. */
  readonly proof?: string;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
}) =>
  Effect.gen(function* () {
    const proof = input.proof ?? input.request.headers.dpop;
    const url = HttpServerRequest.toURL(input.request);
    if (Option.isNone(url)) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "Invalid DPoP request URL.",
      });
    }
    const now = yield* DateTime.now;
    const result = verifyDpopProof({
      proof,
      method: input.request.method,
      url: url.value.href,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      yield* Effect.annotateCurrentSpan({
        "environment.dpop.failure_code": result.code,
      });
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: result.reason,
        dpopFailureReason: mapDpopFailureReason(result.code),
      });
    }
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const replayDigest = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(`${result.thumbprint}:${result.jti}`)),
      ),
      Effect.mapError(
        (cause) =>
          new ServerAuthDpopReplayKeyCalculationError({
            cause,
          }),
      ),
    );
    return {
      thumbprint: result.thumbprint,
      recordReplay: recordDpopReplayMarker(secretStore, replayDigest).pipe(
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) => {
          const mapped = mapDpopReplayStoreError(error);
          return Effect.fail(mapped);
        }),
      ),
    };
  });

/** Fixed slots bound disk usage; occupied slots are never evicted while a proof could still be valid. */
export const DPOP_REPLAY_MARKER_CAPACITY = 16_384;
// 300s validity + 5s future clock skew + the verifier's inclusive whole-second boundary.
const DPOP_REPLAY_RETENTION_MS = 306_000;
export const recordDpopReplayMarker = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  digest: Uint8Array,
) =>
  Effect.gen(function* () {
    const key = Base64Url.encode(digest);
    const replayed = () =>
      new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed or replay storage full.",
        dpopFailureReason: "replay",
      });
    // Honor markers written by earlier server versions through the proof's validity window.
    if (Option.isSome(yield* store.get(`${DPOP_REPLAY_MARKER_PREFIX}${key}`)))
      return yield* replayed();
    const now = yield* Clock.currentTimeMillis;
    let vacant: string | undefined;
    let replace = false;
    const candidates = new Set<string>();
    for (let offset = 0; offset + 1 < digest.length; offset += 2) {
      const slot = ((digest[offset]! << 8) | digest[offset + 1]!) % DPOP_REPLAY_MARKER_CAPACITY;
      const name = `${DPOP_REPLAY_MARKER_PREFIX}slot-${slot}`;
      if (candidates.has(name)) continue;
      candidates.add(name);
      const existing = yield* store.get(name);
      if (Option.isNone(existing)) {
        vacant ??= name;
        continue;
      }
      const [existingKey, expiry] = new TextDecoder().decode(existing.value).split(":");
      // Legacy slots have no age. Quarantine them for one full validity window
      // from first observation rather than pinning their capacity until the daily sweep.
      const expiresAt = expiry === undefined ? now + DPOP_REPLAY_RETENTION_MS : Number(expiry);
      if (existingKey?.length !== key.length || !Number.isFinite(expiresAt))
        return yield* replayed();
      if (expiry === undefined) {
        yield* store.set(name, new TextEncoder().encode(`${existingKey}:${expiresAt}`));
      }
      if (now >= expiresAt) {
        if (vacant === undefined) {
          vacant = name;
          replace = true;
        }
      } else if (existingKey === key) return yield* replayed();
    }
    if (vacant === undefined) return yield* replayed();
    const value = new TextEncoder().encode(`${key}:${now + DPOP_REPLAY_RETENTION_MS}`);
    yield* replace ? store.set(vacant, value) : store.create(vacant, value);
  }).pipe((task) => withDpopReplayLock(store, task));

export const verifyRequestDpopProof = (input: Parameters<typeof prepareRequestDpopProof>[0]) =>
  prepareRequestDpopProof(input).pipe(
    Effect.flatMap(({ thumbprint, recordReplay }) => recordReplay.pipe(Effect.as(thumbprint))),
  );

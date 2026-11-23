import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Base64Url from "effect/encoding/Base64Url";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import {
  mapDpopFailureReason,
  mapDpopReplayStoreError,
  recordDpopReplayMarker,
  DPOP_REPLAY_MARKER_CAPACITY,
} from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
      expect(error.dpopFailureReason).toBe("replay");
    }
  });

  it("reports replay-store availability failures as internal errors", () => {
    const error = mapDpopReplayStoreError(storeFailure("PermissionDenied"));

    expect(error._tag).toBe("ServerAuthDpopReplayStateRecordError");
    if (error._tag === "ServerAuthDpopReplayStateRecordError") {
      expect(error.message).toBe("Failed to record DPoP proof replay state.");
    }
  });
});

describe("mapDpopFailureReason", () => {
  it("maps verifier failures to safe client-facing categories", () => {
    const mappings = [
      ["time_window", "time_window"],
      ["key_mismatch", "key_mismatch"],
      ["method_mismatch", "request_mismatch"],
      ["url_mismatch", "request_mismatch"],
      ["access_token_hash_mismatch", "token_mismatch"],
      ["missing_proof", "invalid_proof"],
      ["malformed_proof", "invalid_proof"],
      ["invalid_signature", "invalid_proof"],
      ["invalid_proof", "invalid_proof"],
    ] as const;

    for (const [code, expected] of mappings) {
      expect(mapDpopFailureReason(code)).toBe(expected);
    }
  });
});

it.effect("rejects a replay in a later candidate after an earlier slot is pruned", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const older = new Uint8Array(32).fill(1);
    const proof = new Uint8Array(32).fill(2);
    proof[0] = 1;
    proof[1] = 1;
    yield* recordDpopReplayMarker(store, older);
    yield* recordDpopReplayMarker(store, proof);
    yield* store.remove("dpop-proof-slot-257");

    const replay = yield* recordDpopReplayMarker(store, proof).pipe(Effect.exit);
    expect(Exit.isFailure(replay)).toBe(true);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-pruned-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect.each([false, true])(
  "reclaims expired slots after proof validity and skew without daily pruning (legacy=%s)",
  (legacy) =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const digest = new Uint8Array(32).fill(1);
      const collision = new Uint8Array(32).fill(1);
      for (let i = 0; i < collision.length; i += 2) collision[i] = 65;
      if (legacy) {
        yield* store.create(
          "dpop-proof-slot-257",
          new TextEncoder().encode(Base64Url.encode(digest)),
        );
        expect(Exit.isFailure(yield* recordDpopReplayMarker(store, digest).pipe(Effect.exit))).toBe(
          true,
        );
      } else {
        yield* recordDpopReplayMarker(store, digest);
      }
      yield* TestClock.adjust("305 seconds");
      expect(
        Exit.isFailure(yield* recordDpopReplayMarker(store, collision).pipe(Effect.exit)),
      ).toBe(true);
      expect(Exit.isFailure(yield* recordDpopReplayMarker(store, digest).pipe(Effect.exit))).toBe(
        true,
      );
      yield* TestClock.adjust("1 second");
      const outcomes = yield* Effect.all(
        [
          recordDpopReplayMarker(store, collision).pipe(Effect.exit),
          recordDpopReplayMarker(store, collision).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-expiry-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "bounds replay slots and atomically rejects concurrent proofs without evicting live markers",
  () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const digest = new Uint8Array(32).fill(1);
      const outcomes = yield* Effect.all(
        [
          recordDpopReplayMarker(store, digest).pipe(Effect.exit),
          recordDpopReplayMarker(store, digest).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      // Every candidate collides with the first proof's slot, despite having a different full hash.
      const collision = new Uint8Array(32).fill(1);
      for (let i = 0; i < collision.length; i += 2) collision[i] = 65;
      const full = yield* recordDpopReplayMarker(store, collision).pipe(Effect.flip);
      expect(full._tag).toBe("ServerAuthInvalidCredentialError");
      const names = yield* fs.readDirectory(config.secretsDir);
      expect(names).toEqual([`dpop-proof-slot-${257 % DPOP_REPLAY_MARKER_CAPACITY}.bin`]);
      expect((yield* recordDpopReplayMarker(store, digest).pipe(Effect.flip))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-bounded-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

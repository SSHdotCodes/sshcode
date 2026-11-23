import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "@t3tools/client-runtime/platform";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  decodeStoredThreadSnapshot,
  encodeStoredThreadSnapshot,
  WEB_THREAD_CACHE_SCHEMA_VERSION,
} from "./thread-cache-encoding";

const v2Projection = makeThreadProjectionFixture();
const v2Now = v2Projection.updatedAt;

const message = {
  id: MessageId.make("message"),
  threadId: v2Projection.thread.id,
  runId: null,
  nodeId: null,
  role: "user" as const,
  text: "Message with substantial context. ".repeat(100),
  attachments: [],
  streaming: false,
  createdBy: "user" as const,
  creationSource: "web" as const,
  createdAt: v2Now,
  updatedAt: v2Now,
};
const item = {
  id: TurnItemId.make("item"),
  threadId: v2Projection.thread.id,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  type: "user_message" as const,
  messageId: message.id,
  text: message.text,
  attachments: [],
  inputIntent: "turn_start" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
};
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  messages: [message],
  turnItems: [item],
  visibleTurnItems: [
    {
      position: 0,
      visibility: "local",
      sourceThreadId: v2Projection.thread.id,
      sourceItemId: item.id,
      item,
    },
  ],
};
const stored = {
  schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  environmentId: EnvironmentId.make("environment"),
  threadId: projection.thread.id,
  snapshot: {
    snapshotSequence: 42,
    projection,
    historyCursor: "opaque-cursor",
    hasMoreHistory: true,
    latestLocalTurnOrdinal: 1,
  },
};
const legacyCodec = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
const encodeLegacy = Schema.encodeEffect(legacyCodec);
const decodeLegacy = Schema.decodeUnknownEffect(legacyCodec);

describe("web thread cache encoding", () => {
  it.effect("stores bodies once and restores the full projection and resume metadata", () =>
    Effect.gen(function* () {
      const full = yield* encodeLegacy(stored);
      const compact = yield* encodeStoredThreadSnapshot(stored);
      expect(compact.length).toBeLessThan(full.length / 2);
      expect(compact.match(/Message with substantial context/g)).toHaveLength(100);
      const decoded = yield* decodeStoredThreadSnapshot(compact);
      expect(decoded.schemaVersion).toBe(WEB_THREAD_CACHE_SCHEMA_VERSION);
      expect(decoded.snapshot).toEqual((yield* decodeLegacy(full)).snapshot);
      expect(decoded.snapshot.projection.turnItems[0]).toBe(
        decoded.snapshot.projection.visibleTurnItems[0]!.item,
      );
      expect(DateTime.formatIso(decoded.snapshot.projection.thread.updatedAt)).toBe(
        DateTime.formatIso(v2Now),
      );
      expect(decoded.snapshot.projection.turnItems[0]).not.toHaveProperty("textOmitted");
      expect(decoded.snapshot).not.toHaveProperty("turnItemsOmitLocalVisible");
      expect(projection.turnItems[0]).toBe(item);
      expect(item.text).toBe(message.text);
    }),
  );

  it.effect("keeps inherited, hidden and differing item bodies without changing order", () =>
    Effect.gen(function* () {
      const hidden = { ...item, id: TurnItemId.make("hidden"), text: "A distinct hidden item" };
      const inherited = {
        ...item,
        id: TurnItemId.make("inherited"),
        threadId: ThreadId.make("parent"),
        text: "Inherited context",
      };
      const changed = {
        ...stored,
        snapshot: {
          ...stored.snapshot,
          projection: {
            ...projection,
            // Hidden items can precede visible ones in full or legacy projections.
            turnItems: [hidden, item],
            visibleTurnItems: [
              {
                position: 0,
                visibility: "inherited" as const,
                sourceThreadId: inherited.threadId,
                sourceItemId: inherited.id,
                item: inherited,
              },
              { ...projection.visibleTurnItems[0]!, position: 1 },
            ],
          },
        },
      };
      const compact = yield* encodeStoredThreadSnapshot(changed);
      const decoded = yield* decodeStoredThreadSnapshot(compact);
      expect(decoded.snapshot).toEqual(
        (yield* decodeLegacy(yield* encodeLegacy(changed))).snapshot,
      );
      expect(decoded.snapshot.projection.turnItems.map((row) => row.id)).toEqual([
        hidden.id,
        item.id,
      ]);
    }),
  );

  it.effect("reads existing caches and makes older decoders reject compact caches", () =>
    Effect.gen(function* () {
      const legacy = yield* encodeLegacy(stored);
      const decodedLegacy = yield* decodeStoredThreadSnapshot(legacy);
      expect(decodedLegacy).toEqual(yield* decodeLegacy(legacy));
      const recached = yield* encodeStoredThreadSnapshot({
        ...decodedLegacy,
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      });
      expect(recached.length).toBeLessThan(legacy.length / 2);
      expect((yield* decodeStoredThreadSnapshot(recached)).snapshot).toEqual(
        decodedLegacy.snapshot,
      );
      const compact = yield* encodeStoredThreadSnapshot(stored);
      expect(yield* decodeLegacy(compact).pipe(Effect.isFailure)).toBe(true);
      expect(yield* decodeStoredThreadSnapshot("invalid-json").pipe(Effect.isFailure)).toBe(true);
    }),
  );
});

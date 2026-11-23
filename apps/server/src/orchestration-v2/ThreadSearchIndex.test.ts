import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { openSearchIndex, type SearchDocument } from "./ThreadSearchIndex.ts";

const doc = (messageId: string, threadId: string, text: string): SearchDocument => ({
  messageId,
  threadId,
  text,
  source: "user",
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
});
const threads = ["one", "two", "three"].map((threadId) => ({
  threadId,
  projectId: "project",
  title: `Chat ${threadId}`,
  archived: threadId === "three",
}));

it.effect("ranks phrases, unordered words, identifiers and paths, grouping by chat", () =>
  Effect.gen(function* () {
    const index = yield* openSearchIndex(":memory:");
    yield* index.syncThreads(threads);
    yield* index.upsert([
      doc("a", "one", "retry after a network connection failure"),
      doc("b", "two", "network retry handles failure"),
      doc("c", "three", "call satisfiesSemverRange in packages/shared/src/semver.ts for PR #1234"),
      doc("d", "three", "the satisfiesSemverRange helper"),
    ]);
    assert.equal((yield* index.keyword("network retry")).matches[0]?.threadId, "two");
    assert.lengthOf((yield* index.keyword("failure retry")).matches, 2);
    for (const query of [
      "satisfiesSemverRange",
      "SemverRange",
      "packages/shared/src/semver.ts",
      "shared/src/semver",
      "#1234",
    ]) {
      const result = yield* index.keyword(query);
      assert.lengthOf(result.matches, 1);
      assert.equal(result.matches[0]?.threadId, "three");
      assert.equal(result.matches[0]?.archived, true);
      assert.isNotNull(result.matches[0]?.messageId);
    }
    assert.lengthOf((yield* index.keyword('" OR * %')).matches, 0);
    yield* index.syncThreads(threads.slice(0, 2));
    assert.lengthOf((yield* index.keyword("satisfiesSemverRange")).matches, 0);
  }).pipe(Effect.scoped),
);

it.effect("updates remove old text and survives deleting the disposable index", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "search-index-" });
    const filename = `${dir}/search-index-v1.sqlite`;
    const index = yield* openSearchIndex(filename);
    yield* index.syncThreads(threads);
    yield* index.upsert([doc("a", "one", "old text")]);
    yield* index.upsert([
      { ...doc("a", "one", "new text"), updatedAt: "2026-10-27T00:01:00.000Z" },
    ]);
    assert.lengthOf((yield* index.keyword("old")).matches, 0);
    assert.lengthOf((yield* index.keyword("new")).matches, 1);
    yield* fs.remove(filename);
    assert.equal(yield* index.count, 0);
    yield* index.syncThreads(threads);
    yield* index.upsert([doc("a", "one", "rebuilt contents")]);
    assert.lengthOf((yield* index.keyword("rebuilt")).matches, 1);
    yield* index.removeMessage("a");
    assert.equal(yield* index.count, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finds paraphrases and invalidates vectors on edits, title changes and deletion", () =>
  Effect.gen(function* () {
    const index = yield* openSearchIndex(":memory:");
    yield* index.syncThreads(threads);
    yield* index.upsert([
      doc("a", "one", "Save credentials in the system keychain"),
      doc("b", "two", "The garden needs water"),
    ]);
    const pending = yield* index.pending();
    yield* index.storeVectors(
      pending.map((row) => ({ ...row, vector: row.id.startsWith("a:") ? [1, 0] : [0, 1] })),
    );
    assert.lengthOf((yield* index.keyword("secure password storage")).matches, 0);
    assert.equal((yield* index.semantic([1, 0])).matches[0]?.messageId, "a");
    assert.deepEqual(yield* index.stats, { totalChunks: 2, embeddedChunks: 2 });
    yield* index.upsert([
      { ...doc("a", "one", "A completely different topic"), updatedAt: "2026-10-28T00:00:00.000Z" },
    ]);
    yield* index.storeVectors(
      pending.filter((row) => row.id.startsWith("a:")).map((row) => ({ ...row, vector: [1, 0] })),
    );
    assert.lengthOf((yield* index.semantic([1, 0])).matches, 0);
    yield* index.syncThreads(threads.map((t) => ({ ...t, title: `Renamed ${t.title}` })));
    assert.equal((yield* index.stats).embeddedChunks, 0);
    yield* index.removeMessage("a");
    assert.equal((yield* index.stats).totalChunks, 1);
  }).pipe(Effect.scoped),
);

it.effect("meaning search returns the chats that stand out, not a padded list", () =>
  Effect.gen(function* () {
    const index = yield* openSearchIndex(":memory:");
    const ids = Array.from({ length: 40 }, (_, i) => `chat-${String(i).padStart(2, "0")}`);
    yield* index.syncThreads(
      ids.map((threadId) => ({ threadId, projectId: "project", title: threadId, archived: false })),
    );
    yield* index.upsert(
      ids.flatMap((threadId, i) =>
        Array.from({ length: 6 }, (_, j) => doc(`${threadId}-${j}`, threadId, `note ${i} ${j}`)),
      ),
    );
    // Like a real library: every chunk scores in a narrow band; four chats are clearly closer.
    const close = new Map([
      ["chat-00-0", 0.9],
      ["chat-01-0", 0.88],
      ["chat-02-0", 0.86],
      ["chat-03-0", 0.84],
    ]);
    // Vectors are stored in the batches the embedder would use.
    let stored = 0;
    for (;;) {
      const pending = yield* index.pending();
      if (pending.length === 0) break;
      yield* index.storeVectors(
        pending.map((row, n) => {
          // A chunk id is its message id plus the chunk's offset.
          const score =
            close.get(row.id.slice(0, row.id.lastIndexOf(":"))) ??
            0.62 + (((stored + n) * 7) % 10) * 0.004;
          return { ...row, vector: [score, Math.sqrt(1 - score * score)] };
        }),
      );
      stored += pending.length;
    }
    assert.equal(stored, 240);
    assert.deepEqual(
      (yield* index.semantic([1, 0])).matches.map((match) => match.threadId),
      ["chat-00", "chat-01", "chat-02", "chat-03"],
    );
    // A query nothing stands out for still answers with its three closest chats.
    assert.lengthOf((yield* index.semantic([0, 1])).matches, 3);
  }).pipe(Effect.scoped),
);

it.effect("splits long messages with overlap and returns a bounded matching snippet", () =>
  Effect.gen(function* () {
    const index = yield* openSearchIndex(":memory:");
    yield* index.syncThreads(threads);
    yield* index.upsert([doc("a", "one", "x".repeat(1400) + " secret " + "y".repeat(2000))]);
    const pending = yield* index.pending();
    assert.equal(pending.length, 3);
    assert.equal(pending[0]?.text.slice(1320), pending[1]?.text.slice(0, 180));
    yield* index.storeVectors(pending.map((p, i) => ({ ...p, vector: i === 1 ? [1, 0] : [0, 1] })));
    const result = yield* index.semantic([1, 0]);
    assert.include(result.matches[0]?.snippet ?? "", "secret");
    assert.isAtMost(result.matches[0]?.snippet.length ?? 0, 240);
  }).pipe(Effect.scoped),
);

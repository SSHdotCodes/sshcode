import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { NativeSessionIndex } from "./NativeSessionIndex.ts";

it.layer(NodeServices.layer)("NativeSessionIndex", (it) => {
  it.effect("replays a cursor without skipping a page and keeps provider instances distinct", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-session-index-" });
      const roots = ["first", "second"].map((name) => ({
        directory: path.join(directory, name),
        provider: "codex" as const,
        providerInstanceId: ProviderInstanceId.make(name),
      }));
      for (const root of roots) {
        yield* fs.makeDirectory(root.directory);
        for (const [name, at] of [
          ["new", 20],
          ["old", 10],
        ] as const) {
          const file = path.join(root.directory, name + ".jsonl");
          yield* fs.writeFileString(file, "fixture");
          yield* fs.utimes(file, at, at);
        }
      }
      const index = new NativeSessionIndex(async function* (file) {
        const name = path.basename(file.filePath, ".jsonl");
        yield { nativeId: name, cwd: "/workspace", title: name, firstPrompt: name };
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => index.close()));
      let first = yield* Effect.promise(() => index.discover({ limit: 1 }, roots));
      while (first.sessions.length === 0 && first.nextCursor) {
        first = yield* Effect.promise(() =>
          index.discover({ limit: 1, cursor: first.nextCursor! }, roots),
        );
      }
      expect(first.sessions[0]?.head.nativeId).toBe("new");
      const second = yield* Effect.promise(() =>
        index.discover({ limit: 1, cursor: first.nextCursor! }, roots),
      );
      const retry = yield* Effect.promise(() =>
        index.discover({ limit: 1, cursor: first.nextCursor! }, roots),
      );
      expect(retry).toEqual(second);
      const sessions = [...first.sessions, ...second.sessions];
      let cursor = second.nextCursor;
      while (cursor) {
        const page = yield* Effect.promise(() =>
          index.discover({ limit: 1, cursor: cursor! }, roots),
        );
        sessions.push(...page.sessions);
        cursor = page.nextCursor;
      }
      expect(sessions.map((session) => session.head.nativeId)).toEqual([
        "new",
        "new",
        "old",
        "old",
      ]);
      expect(new Set(sessions.map((session) => session.file.providerInstanceId))).toEqual(
        new Set(["first", "second"]),
      );
    }),
  );
});

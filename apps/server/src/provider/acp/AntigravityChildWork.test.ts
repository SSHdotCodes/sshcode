import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readAntigravityChildrenAtWork } from "./AntigravityChildWork.ts";

const writeJson = (filePath: string, value: unknown) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, JSON.stringify(value));
  });

const launchEnvelope = (parentSessionId: string, toolCallId: string) => ({
  sender: parentSessionId,
  sourceMetadata: {
    tool: {
      toolCall: { id: toolCallId, name: "invoke_subagent" },
    },
  },
});

describe("readAntigravityChildrenAtWork", () => {
  it.effect(
    "keeps reporting active children when a sibling child has no messages directory yet",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-child-work-",
        });
        const sessionId = "parent-session";

        yield* writeJson(
          path.join(
            dataDirectory,
            "brain",
            sessionId,
            ".system_generated",
            "subagents",
            "child-a.json",
          ),
          { id: "child-a" },
        );
        yield* writeJson(
          path.join(
            dataDirectory,
            "brain",
            sessionId,
            ".system_generated",
            "subagents",
            "child-b.json",
          ),
          { id: "child-b" },
        );
        // child-a has a launch message; child-b has no messages directory yet.
        yield* writeJson(
          path.join(
            dataDirectory,
            "brain",
            "child-a",
            ".system_generated",
            "messages",
            "launch.json",
          ),
          launchEnvelope(sessionId, "call-a"),
        );

        const active = yield* readAntigravityChildrenAtWork({
          dataDirectory,
          sessionId,
          nativeTaskIds: ["call-a", "call-b"],
          fileSystem,
          path,
        });

        assert.deepEqual(active, ["call-a"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps reporting active children when a sibling or same-child inbox has a corrupt or oversized file",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-child-work-",
        });
        const sessionId = "parent-session";

        yield* writeJson(
          path.join(
            dataDirectory,
            "brain",
            sessionId,
            ".system_generated",
            "subagents",
            "child-a.json",
          ),
          { id: "child-a" },
        );
        yield* writeJson(
          path.join(
            dataDirectory,
            "brain",
            sessionId,
            ".system_generated",
            "subagents",
            "child-b.json",
          ),
          { id: "child-b" },
        );
        // child-a has a partial/corrupt file alongside its valid launch envelope.
        const childAMessages = path.join(
          dataDirectory,
          "brain",
          "child-a",
          ".system_generated",
          "messages",
        );
        yield* fileSystem.makeDirectory(childAMessages, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(childAMessages, "0-partial.json"),
          "{truncated",
        );
        yield* writeJson(
          path.join(childAMessages, "1-launch.json"),
          launchEnvelope(sessionId, "call-a"),
        );

        // child-b has an oversized message file (>256 KiB).
        const childBMessages = path.join(
          dataDirectory,
          "brain",
          "child-b",
          ".system_generated",
          "messages",
        );
        yield* fileSystem.makeDirectory(childBMessages, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(childBMessages, "huge.json"),
          "x".repeat(300 * 1024),
        );

        const active = yield* readAntigravityChildrenAtWork({
          dataDirectory,
          sessionId,
          nativeTaskIds: ["call-a", "call-b"],
          fileSystem,
          path,
        });

        assert.deepEqual(active, ["call-a"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses symlinked inbox files pointing outside the data directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-ag-child-work-root-",
      });
      const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-ag-child-work-outside-",
      });
      const sessionId = "parent-session";

      const outsideLaunch = path.join(outsideDirectory, "launch.json");
      yield* writeJson(outsideLaunch, launchEnvelope(sessionId, "call-escaped"));

      yield* writeJson(
        path.join(
          dataDirectory,
          "brain",
          sessionId,
          ".system_generated",
          "subagents",
          "child-escaped.json",
        ),
        { id: "child-escaped" },
      );
      const escapedMessages = path.join(
        dataDirectory,
        "brain",
        "child-escaped",
        ".system_generated",
        "messages",
      );
      yield* fileSystem.makeDirectory(escapedMessages, { recursive: true });
      yield* fileSystem.symlink(outsideLaunch, path.join(escapedMessages, "launch.json"));

      const active = yield* readAntigravityChildrenAtWork({
        dataDirectory,
        sessionId,
        nativeTaskIds: ["call-escaped"],
        fileSystem,
        path,
      });

      assert.deepEqual(active, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

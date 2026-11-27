import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readAntigravityChildImages,
  readAntigravityChildrenAtWork,
} from "./AntigravityChildWork.ts";

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

describe("readAntigravityChildImages", () => {
  it.effect(
    "lists the pictures each launched child saved, in order, inside the parent folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-child-images-",
        });
        const root = yield* fileSystem.realPath(dataDirectory);
        const sessionId = "parent-session";
        const artifacts = path.join(root, "brain", sessionId);
        const subagents = path.join(artifacts, ".system_generated", "subagents");
        yield* writeJson(path.join(subagents, "child-feast.json"), { id: "child-feast" });
        yield* writeJson(path.join(subagents, "child-turkey.json"), { id: "child-turkey" });
        for (const [child, call] of [
          ["child-feast", "call-feast"],
          ["child-turkey", "call-turkey"],
        ] as const) {
          yield* writeJson(
            path.join(root, "brain", child, ".system_generated", "messages", "launch.json"),
            launchEnvelope(sessionId, call),
          );
        }
        const step = (child: string, index: number, text: string) =>
          Effect.gen(function* () {
            const directory = path.join(
              root,
              "brain",
              child,
              ".system_generated",
              "steps",
              `${index}`,
            );
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(path.join(directory, "output.txt"), text);
          });
        const outside = path.join(root, "elsewhere.png");
        const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-ag-child-images-outside-",
        });
        for (const name of ["feast.jpg", "feast_v2.jpg", "feast_final.jpg", "turkey.jpg"]) {
          yield* fileSystem.writeFileString(path.join(artifacts, name), "image");
        }
        yield* fileSystem.writeFileString(outside, "image");
        const outsideOutput = path.join(outsideDirectory, "output.txt");
        yield* fileSystem.writeFileString(
          outsideOutput,
          `Generated image is saved at ${path.join(artifacts, "turkey.jpg")}`,
        );
        const linkedStep = path.join(
          root,
          "brain",
          "child-feast",
          ".system_generated",
          "steps",
          "1",
        );
        yield* fileSystem.makeDirectory(linkedStep, { recursive: true });
        yield* fileSystem.symlink(outsideOutput, path.join(linkedStep, "output.txt"));
        yield* step(
          "child-feast",
          2,
          `Generated image is saved at ${path.join(artifacts, "feast.jpg")}`,
        );
        yield* step(
          "child-feast",
          10,
          `Generated image is saved at ${path.join(artifacts, "feast_final.jpg")}`,
        );
        yield* step(
          "child-feast",
          4,
          `Generated image is saved at ${path.join(artifacts, "feast_v2.jpg")}`,
        );
        yield* step("child-feast", 6, `Generated image is saved at ${outside}`);
        yield* step("child-feast", 8, "Looks good; sending it back.");
        yield* step(
          "child-turkey",
          2,
          `Generated image is saved at ${path.join(artifacts, "turkey.jpg")}`,
        );

        const read = (nativeTaskId: string) =>
          readAntigravityChildImages({ dataDirectory, sessionId, nativeTaskId, fileSystem, path });
        assert.deepStrictEqual(yield* read("call-feast"), [
          path.join(artifacts, "feast.jpg"),
          path.join(artifacts, "feast_v2.jpg"),
          path.join(artifacts, "feast_final.jpg"),
        ]);
        assert.deepStrictEqual(yield* read("call-turkey"), [path.join(artifacts, "turkey.jpg")]);
        assert.deepStrictEqual(yield* read("call-unknown"), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- A real loopback fake server verifies the embedding HTTP contract without Ollama.
import * as NodeHttp from "node:http";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import { embed, fuseSearchResults } from "./ThreadSearchEmbeddings.ts";

const match = (threadId: string, snippet: string): OrchestrationThreadSearchMatch => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("p"),
  source: "user",
  snippet,
  messageId: MessageId.make(threadId),
  messageCreatedAt: null,
});
it("fuses ranks once per chat while keeping exact matches first", () => {
  const phrase = match("exact", "network retry");
  const both = match("both", "Retry after a connection failure");
  assert.deepEqual(
    fuseSearchResults(
      "network retry",
      [phrase, both],
      [both, match("meaning", "Connection recovery")],
      3,
    ).map((m) => m.threadId),
    ["exact", "both", "meaning"],
  );
});
it.effect("uses a fake local OpenAI endpoint and normalizes vectors", () =>
  Effect.gen(function* () {
    const bodies: string[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve) => {
            const s = NodeHttp.createServer(async (request, response) => {
              let body = "";
              for await (const chunk of request) body += chunk;
              bodies.push(body);
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }));
            });
            s.listen(0, "127.0.0.1", () => resolve(s));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const result = yield* embed({ url: `http://127.0.0.1:${address.port}/v1`, model: "fake" }, [
      "task: search result | query: secure password storage",
    ]);
    assert.deepEqual(result, [[0.6, 0.8]]);
    assert.equal(JSON.parse(bodies[0]!).model, "fake");
    assert.equal(
      JSON.parse(bodies[0]!).input[0],
      "task: search result | query: secure password storage",
    );
  }).pipe(Effect.scoped),
);
it.effect("refuses external endpoints before sending private text", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      embed({ url: "https://example.com/v1", model: "fake" }, ["private"]),
    );
    assert.equal(error._tag, "EmbeddingError");
  }),
);

it("chooses the stronger message target when both lists match a chat", () => {
  const lexical = match("target", "storage for keeping things secure");
  const semantic = {
    ...match("target", "Credentials stay in the keychain"),
    messageId: MessageId.make("best-message"),
  };
  const results = fuseSearchResults(
    "secure storage",
    [match("other", "storage can be secure"), lexical],
    [semantic],
    2,
  );
  assert.equal(results.find((m) => m.threadId === "target")?.messageId, "best-message");
});

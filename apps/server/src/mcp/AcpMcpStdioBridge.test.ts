// The harness asserts raw JSON-RPC wire strings, mirroring the bridge's
// schema-free passthrough.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  AcpMcpBridgeError,
  callAcpMcpTool,
  renderAcpMcpToolResult,
  runAcpMcpStdioBridge,
} from "./AcpMcpStdioBridge.ts";

function makeHarness(
  responder: (request: Request) => Promise<Response> | Response,
  input = new NodeStream.PassThrough(),
) {
  const written: Array<string> = [];
  const requests: Array<{
    readonly method: string;
    readonly headers: Headers;
    readonly body: string;
  }> = [];
  const bridge = runAcpMcpStdioBridge({
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    fetchImplementation: async (_url, init) => {
      const request = new Request("http://127.0.0.1:1/mcp", init);
      requests.push({
        method: init?.method ?? "GET",
        headers: request.headers,
        body: String(init?.body ?? ""),
      });
      return responder(request);
    },
  });
  return { input, written, requests, bridge };
}

function pendingFetch(started: Deferred.Deferred<AbortSignal | undefined>) {
  return (_url: string, init?: RequestInit): Promise<Response> => {
    Deferred.doneUnsafe(started, Effect.succeed(init?.signal ?? undefined));
    return new Promise(() => {});
  };
}

describe("AcpMcpStdioBridge", () => {
  it("prints structured content once with distinct supplemental text and error status", async () => {
    const structuredContent = { answer: "x".repeat(8_000) };
    const result = {
      isError: true,
      structuredContent,
      content: [
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        { type: "text", text: "Recover with itemId=source-item." },
        { type: "text", text: JSON.stringify(structuredContent) },
      ],
    };
    const text = await renderAcpMcpToolResult(result);
    expect(text).toBe(
      `isError: true\n${JSON.stringify(structuredContent, null, 2)}\nRecover with itemId=source-item.`,
    );
    expect(text.length).toBeLessThan(8_100);
    expect(
      await renderAcpMcpToolResult({
        structuredContent,
        content: [{ type: "text", text: "Summary" }],
      }),
    ).toBe(`Summary\n${JSON.stringify(structuredContent)}`);
    expect(await renderAcpMcpToolResult({ content: [{ type: "text", text: "plain text" }] })).toBe(
      "plain text",
    );
  });

  it("recognizes duplicate structured JSON regardless of key order", async () => {
    const text = '{"b":2,"a":1}';
    expect(
      await renderAcpMcpToolResult({
        structuredContent: { a: 1, b: 2 },
        content: [{ type: "text", text }],
      }),
    ).toBe(text);
  });

  it("saves image bytes and prints a readable path instead of base64", async () => {
    const bytes = Buffer.from("image bytes retained exactly");
    const text = await renderAcpMcpToolResult({
      isError: false,
      content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }],
    });
    const saved = JSON.parse(text.split("\n")[1]!);
    try {
      expect(saved.type).toBe("image");
      expect(saved.mimeType).toBe("image/png");
      expect(NodePath.isAbsolute(saved.path)).toBe(true);
      expect(await NodeFSP.readFile(saved.path)).toEqual(bytes);
      expect(text).not.toContain(bytes.toString("base64"));
    } finally {
      await NodeFSP.rm(NodePath.dirname(saved.path), { recursive: true });
    }
  });
  it.effect("keeps overlapping old calls on their own session during reinitialization", () =>
    Effect.gen(function* () {
      let releaseOld!: () => void;
      let oldStarted!: () => void;
      const oldGate = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const oldRequestStarted = new Promise<void>((resolve) => {
        oldStarted = resolve;
      });
      const writtenById = new Map<number, () => void>();
      const waitFor = (id: number) =>
        new Promise<void>((resolve) => {
          writtenById.set(id, resolve);
        });
      const input = new NodeStream.PassThrough();
      const requests: { method: string; session: string | null }[] = [];
      let nextSession = 0;
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer fake",
          input,
          output: {
            write: (chunk) => {
              writtenById.get(JSON.parse(chunk).id)?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const headers = new Headers(init?.headers);
            const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
            requests.push({
              method: init?.method === "DELETE" ? "DELETE" : body.method!,
              session: headers.get("mcp-session-id"),
            });
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            if (body.id === 2) {
              oldStarted();
              await oldGate;
            }
            const id =
              body.method === "initialize"
                ? `session-${++nextSession}`
                : headers.get("mcp-session-id")!;
            return Response.json(
              { jsonrpc: "2.0", id: body.id, result: {} },
              { headers: { "mcp-session-id": id } },
            );
          },
        }),
      );
      const first = waitFor(1);
      input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      yield* Effect.promise(() => first);
      input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n');
      yield* Effect.promise(() => oldRequestStarted);
      const second = waitFor(3);
      input.write('{"jsonrpc":"2.0","id":3,"method":"initialize"}\n');
      yield* Effect.promise(() => second);
      expect(
        requests.some((request) => request.method === "DELETE" && request.session === "session-1"),
      ).toBe(false);
      const oldDone = waitFor(2);
      releaseOld();
      yield* Effect.promise(() => oldDone);
      const last = waitFor(4);
      input.write('{"jsonrpc":"2.0","id":4,"method":"tools/list"}\n');
      yield* Effect.promise(() => last);
      input.end();
      yield* Fiber.join(fiber);
      expect(requests.find((request) => request.method === "tools/list")?.session).toBe(
        "session-2",
      );
      expect(
        requests.filter((request) => request.method === "DELETE").map((request) => request.session),
      ).toEqual(["session-1"]);
    }),
  );
  it.effect("preserves the original transport failure as the typed error cause", () =>
    Effect.gen(function* () {
      const source = new Error("fetch failed");
      const failure = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: () => Promise.reject(source),
      }).pipe(Effect.asVoid, Effect.flip);

      expect(failure).toBeInstanceOf(AcpMcpBridgeError);
      expect(failure.cause).toBe(source);
    }),
  );

  it.effect("calls one tool through a fresh authenticated MCP session", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
      const result = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const body: unknown = JSON.parse(String(init?.body ?? "{}"));
          requests.push({ body, headers });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { structuredContent: { providers: ["codex"] } },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      expect(result).toEqual({ structuredContent: { providers: ["codex"] } });
      expect(requests).toHaveLength(3);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests[2]?.body).toMatchObject({
        method: "tools/call",
        params: { name: "orchestrator_capabilities", arguments: {} },
      });
    }),
  );

  it.effect("forwards requests and replays the session id and protocol version", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness((request) => {
        const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
        void request;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
      expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }),
  );

  it.effect("starts a fresh upstream session when the client initializes again (Kimi CLI)", () =>
    Effect.gen(function* () {
      let sessions = 0;
      const { input, written, requests, bridge } = makeHarness(() => {
        const last = requests.at(-1)!;
        if (last.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(last.body) as { id?: number; method?: string };
        if (body.method === "initialize") sessions += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": `session-${sessions}`,
            },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      for (const message of [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/call" },
        { jsonrpc: "2.0", id: 3, method: "initialize" },
        { jsonrpc: "2.0", id: 4, method: "tools/call" },
      ]) {
        input.write(`${JSON.stringify(message)}\n`);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4]);
      expect(requests.map((request) => request.method)).toEqual([
        "POST",
        "POST",
        "DELETE",
        "POST",
        "POST",
      ]);
      expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-1");
      expect(requests[3]?.headers.get("mcp-session-id")).toBeNull();
      expect(requests[3]?.headers.get("mcp-protocol-version")).toBeNull();
      expect(requests[4]?.headers.get("mcp-session-id")).toBe("session-2");
    }),
  );

  it.effect("acknowledges notifications silently and synthesizes errors for failed requests", () =>
    Effect.gen(function* () {
      let call = 0;
      const { input, written, bridge } = makeHarness(() => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 202 })
          : new Response("upstream broke", { status: 500 });
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({
        id: 3,
        error: { code: -32603 },
      });
    }),
  );

  it.effect("emits parse errors for malformed JSON-RPC input", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => new Response(null, { status: 202 }),
      );
      const fiber = yield* Effect.forkChild(bridge);

      input.end("{not-json}\n");
      yield* Fiber.join(fiber);

      expect(requests).toHaveLength(0);
      expect(JSON.parse(written[0]!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }),
  );

  it.effect("keeps U+2028 and U+2029 inside a message instead of splitting it", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => Response.json({ jsonrpc: "2.0", id: 4, result: { ok: true } }),
        // Object mode keeps the two writes as separate chunks instead of one buffered read.
        new NodeStream.PassThrough({ objectMode: true }),
      );
      const fiber = yield* Effect.forkChild(bridge);
      // JSON.stringify leaves both separators unescaped, as MCP stdio clients send them.
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "a\u2028b\u2029c\u{1f30d}" } },
      });

      // Split inside the emoji's UTF-8 bytes and leave the last line unterminated, as stdin may.
      const bytes = Buffer.from(message);
      const split = bytes.indexOf(Buffer.from("\u{1f30d}")) + 2;
      input.write(bytes.subarray(0, split));
      input.end(bytes.subarray(split));
      yield* Fiber.join(fiber);

      expect(requests.map((request) => request.body)).toEqual([message]);
      expect(written.map((chunk) => JSON.parse(chunk))).toEqual([
        { jsonrpc: "2.0", id: 4, result: { ok: true } },
      ]);
    }),
  );

  it.effect("forwards SSE messages before the HTTP response closes", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      let firstWrite: (() => void) | undefined;
      const firstWritten = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              firstWrite?.();
            },
          },
          fetchImplementation: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  resolveResponseController(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      const responseController = yield* Effect.promise(() => responseControllerReady);
      responseController.enqueue(
        new TextEncoder().encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ),
      );
      yield* Effect.promise(() => firstWritten);
      expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

      responseController.enqueue(
        new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );
      responseController.close();
      input.end();
      yield* Fiber.join(fiber);
      expect(written).toHaveLength(2);
    }),
  );

  it.effect("forwards client responses while an SSE request is still open", () =>
    Effect.gen(function* () {
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let serverRequestWritten: (() => void) | undefined;
      const serverRequestReachedClient = new Promise<void>((resolve) => {
        serverRequestWritten = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly id?: unknown;
              readonly method?: unknown;
              readonly result?: unknown;
            };
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    responseController = controller;
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
            responseController?.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            responseController?.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => serverRequestReachedClient);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
    }),
  );

  it.effect("forwards cancellation while a tool SSE response is still open", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      const methods: Array<string> = [];
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: { write: (chunk) => written.push(chunk) },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly method?: string;
            };
            methods.push(body.method ?? "");
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: resolveResponseController,
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            const controller = await responseControllerReady;
            controller.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            controller.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => responseControllerReady);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
    }),
  );
  it.effect("aborts the pending fetch when a tool call is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const fiber = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: pendingFetch(started),
      }).pipe(Effect.scoped, Effect.forkChild);

      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );

  it.effect("answers a server ping that arrives before the tool result on its SSE stream", () =>
    Effect.gen(function* () {
      const sent: Array<{ id?: unknown; method?: string; result?: unknown }> = [];
      const result = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (_url, init) => {
          if (init?.method === "DELETE") return new Response(null, { status: 204 });
          const message = JSON.parse(String(init?.body)) as (typeof sent)[number];
          sent.push(message);
          if (message.method === "initialize") {
            return Response.json(
              { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
              { headers: { "mcp-session-id": "session-42" } },
            );
          }
          if (message.method !== "tools/call") return new Response(null, { status: 202 });
          const ping = { jsonrpc: "2.0", id: "server-ping", method: "ping" };
          const reply = { jsonrpc: "2.0", id: message.id, result: { content: [] } };
          return new Response(
            `data: ${JSON.stringify(ping)}\n\ndata: ${JSON.stringify(reply)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });

      expect(result).toEqual({ content: [] });
      expect(sent).toContainEqual({ jsonrpc: "2.0", id: "server-ping", result: {} });
    }),
  );

  it.effect("aborts the pending fetch when the stdio bridge is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const input = new NodeStream.PassThrough();
      const fiber = yield* runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: { write: () => undefined },
        fetchImplementation: pendingFetch(started),
      }).pipe(Effect.forkChild);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );
});

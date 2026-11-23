// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics preferSchemaOverJson:off

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";

/**
 * Stdio-to-HTTP bridge for T3's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `sshcode acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to T3's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 *
 * This entry sits on the ACP first-message critical path (bin.ts fast-paths
 * it before the CLI graph), so it imports only effect core and the Node stream adapter; keep the
 * import list lean when changing it.
 */

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function replyToServerRequest(envelope: JsonRpcEnvelope): unknown {
  return envelope.method === "ping"
    ? { jsonrpc: "2.0", id: envelope.id, result: {} }
    : { jsonrpc: "2.0", id: envelope.id, error: { code: -32601, message: "Method not found" } };
}

export interface AcpMcpToolCallOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export function callAcpMcpTool(
  options: AcpMcpToolCallOptions,
): Effect.Effect<unknown, AcpMcpBridgeError> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // The bridge is single-fibered at creation time; concurrent sends only
    // read these after the sequential handshake, so plain locals suffice.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (message: unknown): Effect.Effect<ReadonlyArray<unknown>, AcpMcpBridgeError> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: JSON.stringify(message),
              signal,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          yield* discardResponseBody(response);
          return yield* Effect.fail(
            new AcpMcpBridgeError(`SSHCode MCP endpoint responded with HTTP ${response.status}.`),
          );
        }
        const payloads: Array<unknown> = [];
        yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) => {
          protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
          const envelope = asEnvelope(payload);
          if (envelope?.id !== undefined && typeof envelope.method === "string") {
            return send(replyToServerRequest(envelope)).pipe(Effect.asVoid);
          }
          payloads.push(payload);
          return Effect.void;
        });
        return payloads;
      });

    const initializeId = "t3-acp-cli-initialize";
    const initialized = yield* send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-acp-cli", version: "0.0.0" },
      },
    });
    const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
    if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError("SSHCode MCP endpoint rejected initialization."),
      );
    }
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const callId = "t3-acp-cli-tool-call";
    const responses = yield* send({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: options.tool, arguments: options.arguments },
    });
    const response = responses.find((entry) => asEnvelope(entry)?.id === callId);
    const envelope = asEnvelope(response);
    if (envelope === null || envelope.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError(
          `SSHCode MCP tool call failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ),
      );
    }
    return envelope.result;
  });
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // Dispatch happens synchronously on the single stream fiber, so plain
    // locals carry the shared session state; forwards mutate them in
    // completion order exactly like the wire does.
    type Session = {
      id: string | null;
      version: string | null;
      pending: number;
      retired: boolean;
      deleting: boolean;
    };
    let session: Session = { id: null, version: null, pending: 0, retired: false, deleting: false };
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = (owner: Session, payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          owner.version = protocolVersionOf(entry) ?? owner.version;
          yield* writeMessage(entry);
        }
      });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const retire = (owner: Session): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!owner.retired || owner.pending !== 0 || owner.id === null || owner.deleting) return;
        owner.deleting = true;
        yield* Effect.tryPromise(() =>
          fetchImplementation(options.endpoint, {
            method: "DELETE",
            headers: {
              authorization: options.authorization,
              "mcp-session-id": owner.id!,
              ...(owner.version === null ? {} : { "mcp-protocol-version": owner.version }),
            },
          }).then((response) => response.body?.cancel()),
        ).pipe(Effect.ignore);
      });

    const forward = (line: string, envelope: JsonRpcEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A client can open a new MCP session over this same process: Kimi CLI does
        // for every tool call. The endpoint rejects an initialize that carries the
        // old session id (HTTP 400), so end that session and start a fresh one.
        if (envelope.method === "initialize") {
          const previous = session;
          previous.retired = true;
          session = { id: null, version: null, pending: 0, retired: false, deleting: false };
          yield* retire(previous);
        }
        const owner = session;
        owner.pending += 1;
        yield* Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetchImplementation(options.endpoint, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  authorization: options.authorization,
                  ...(owner.id === null ? {} : { "mcp-session-id": owner.id }),
                  ...(owner.version === null ? {} : { "mcp-protocol-version": owner.version }),
                },
                body: line,
                signal,
              }),
            catch: bridgeError,
          });
          owner.id = response.headers.get("mcp-session-id") ?? owner.id;
          if (!response.ok) {
            if (envelope.id !== undefined) {
              yield* respondWithError(
                envelope.id,
                `SSHCode MCP endpoint responded with HTTP ${response.status}.`,
              );
            }
            return yield* discardResponseBody(response);
          }
          yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) =>
            handleServerPayload(owner, payload),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              owner.pending -= 1;
              yield* retire(owner);
            }),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) => {
          if (envelope.id === undefined) return Effect.void;
          const error = Cause.squash(cause);
          return respondWithError(
            envelope.id,
            `SSHCode MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = (task: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(task);
        running.add(fiber);
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
              }),
            ),
          ),
        );
      });

    const dispatch = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return yield* respondWithError(null, "Parse error", -32700);
        }
        const envelope = asEnvelope(parsed);
        if (envelope === null) return;
        const isResponse =
          envelope.id !== undefined && ("result" in envelope || "error" in envelope);
        const isSessionHandshake =
          envelope.method === "initialize" || envelope.method === "notifications/initialized";
        if (isResponse) {
          return yield* launch(forward(line, envelope));
        }
        if (isSessionHandshake) {
          const prior = sessionBarrier;
          const fiber = yield* Effect.forkChild(
            prior.pipe(Effect.andThen(forward(line, envelope))),
          );
          running.add(fiber);
          const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
          sessionBarrier = barrier;
          sessionBarrierPending = true;
          yield* Effect.forkChild(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  running.delete(fiber);
                  if (sessionBarrier === barrier) sessionBarrierPending = false;
                }),
              ),
            ),
          );
          return;
        }
        const task = sessionBarrierPending
          ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
          : forward(line, envelope);
        return yield* launch(task);
      });

    // Split only wire line endings; Unicode separators inside JSON strings stay intact.
    // The Node adapter also cancels a pending read when the bridge is interrupted.
    yield* NodeStream.fromReadable<Uint8Array | string, AcpMcpBridgeError>({
      evaluate: () => options.input,
      onError: bridgeError,
    }).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(dispatch),
      Effect.catchCause(() => Effect.void),
    );
    yield* Fiber.awaitAll(running);
  });
}

/** Terminal fallback output is model-facing, unlike the opaque stdio transport. */
export async function renderAcpMcpToolResult(result: unknown): Promise<string> {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return JSON.stringify(result) ?? String(result);
  const { content, structuredContent, isError, ...supplemental } = result as Record<
    string,
    unknown
  >;
  const lines: Array<string> = [];
  if (typeof isError === "boolean") lines.push(`isError: ${isError}`);
  const jsonIdentity = (value: unknown) =>
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
          )
        : entry,
    );
  const structuredIdentity = jsonIdentity(structuredContent);
  const seenText = new Set<string>();
  let structuredPrinted = false;
  let imageDirectory: string | undefined;
  for (const entry of Array.isArray(content) ? content : []) {
    if (typeof entry !== "object" || entry === null) {
      lines.push(JSON.stringify(entry));
      continue;
    }
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      if (seenText.has(block.text)) continue;
      seenText.add(block.text);
      let duplicatesStructured = false;
      try {
        duplicatesStructured =
          structuredContent !== undefined &&
          jsonIdentity(JSON.parse(block.text)) === structuredIdentity;
      } catch {
        // Supplemental prose is independent of the structured result.
      }
      if (!duplicatesStructured || !structuredPrinted) lines.push(block.text);
      structuredPrinted ||= duplicatesStructured;
    } else if (block.type === "image" && typeof block.data === "string") {
      // Load filesystem modules only for the terminal fallback's image path,
      // keeping the stdio bridge's first-message import graph small.
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      imageDirectory ??= await fs.mkdtemp(path.join(os.tmpdir(), "t3-acp-mcp-"));
      const extension =
        block.mimeType === "image/jpeg" ? "jpg" : block.mimeType === "image/png" ? "png" : "image";
      const imagePath = path.join(imageDirectory, `image-${lines.length}.${extension}`);
      await fs.writeFile(imagePath, Buffer.from(block.data, "base64"));
      const { data: _data, ...metadata } = block;
      lines.push(JSON.stringify({ ...metadata, path: imagePath }));
    } else {
      lines.push(JSON.stringify(block));
    }
  }
  if (structuredContent !== undefined && !structuredPrinted)
    lines.push(JSON.stringify(structuredContent));
  if (Object.keys(supplemental).length > 0) lines.push(JSON.stringify(supplemental));
  return lines.join("\n");
}

/**
 * Argv runner for `sshcode acp-mcp-bridge` and `sshcode acp-mcp-call`, shared by the
 * fast-path dispatch in bin.ts and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  process.stdout.write(`${await renderAcpMcpToolResult(result)}\n`);
}

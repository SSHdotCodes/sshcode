// MCP responses carry opaque JSON-RPC that callers relay verbatim.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Reads the JSON-RPC payloads of a response from an MCP streamable-HTTP
 * endpoint. Used on the ACP bridge fast path, so it imports only effect core.
 *
 * @module mcpResponsePayloads
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Stream.fromAsyncIterable would wait for the generator to return before releasing its reader.
// Pull directly so cancellation can close a reader that is still waiting for the next event.
function sseStream<E>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onError: (cause: unknown) => E,
) {
  const events = sseDataLines(reader);
  return Stream.fromEffectRepeat(
    Effect.tryPromise({ try: () => events.next(), catch: onError }).pipe(
      Effect.flatMap((event) => (event.done ? Cause.done() : Effect.succeed(event.value))),
    ),
  );
}

const SSE_EVENT_SEPARATOR = /\n\n|\r\n\r\n/u;
// A separator is at most four characters, so one that a new chunk completes starts within the
// last three characters already read. Scanning only those plus the chunk keeps parsing linear.
const SEPARATOR_OVERLAP = 3;

function sseEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
}

async function* sseDataLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let eventParts: string[] = [];
  let unscanned = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    let text = unscanned + decoder.decode(value, { stream: true });
    let separator = SSE_EVENT_SEPARATOR.exec(text);
    while (separator !== null) {
      eventParts.push(text.slice(0, separator.index));
      const data = sseEventData(eventParts.join(""));
      eventParts = [];
      text = text.slice(separator.index + separator[0].length);
      if (data.length > 0) yield data;
      separator = SSE_EVENT_SEPARATOR.exec(text);
    }
    const scannedLength = Math.max(0, text.length - SEPARATOR_OVERLAP);
    eventParts.push(text.slice(0, scannedLength));
    unscanned = text.slice(scannedLength);
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

// Interrupting a read cannot settle the promise parked on read(), so the reader is cancelled
// from a finalizer instead; that settles the read and closes the body.
const scopedReader = (body: ReadableStream<Uint8Array>) =>
  Effect.acquireRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.promise(() =>
        reader
          .cancel()
          .catch(() => undefined)
          .then(() => reader.releaseLock()),
      ),
  );

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const body = response.body;
  if (body === null) return Stream.empty;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return Stream.unwrap(
      scopedReader(body).pipe(Effect.map((reader) => sseStream(reader, onError))),
    ).pipe(Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })));
  }
  return Stream.unwrap(
    scopedReader(body).pipe(
      Effect.flatMap((reader) =>
        Effect.tryPromise({ try: () => readText(reader), catch: onError }),
      ),
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: onError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}

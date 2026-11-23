import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

const yieldToHost = Effect.callback<void>((resume) => {
  // @effect-diagnostics-next-line globalTimersInEffect:off - Hermes setImmediate only yields to microtasks.
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

/** Each save gets its own budget; immutable rows share cached encodings across saves. */
export function makeThreadCacheRowEncoder(
  options: {
    readonly maxJsonLength?: number;
    readonly yieldToHost?: Effect.Effect<void>;
  } = {},
) {
  const cache = new WeakMap<object, { encoded: unknown; length: number }>();
  const limit = options.maxJsonLength ?? 4 * 1024 * 1024;
  return () => {
    let length = 0;
    let worked = false;
    return Effect.fnUntraced(function* <Row extends object>(
      rows: ReadonlyArray<Row>,
      encodeChunk: (chunk: ReadonlyArray<Row>) => Effect.Effect<unknown, Schema.SchemaError>,
    ) {
      const result: unknown[] = [];
      for (let offset = 0; offset < rows.length; offset += 32) {
        if (worked) yield* options.yieldToHost ?? yieldToHost;
        worked = true;
        const chunk = rows.slice(offset, offset + 32);
        const missing = chunk.filter((row) => !cache.has(row));
        if (missing.length > 0) {
          // toCodecJson types its encoded output as Json even for an array codec.
          const encoded = (yield* encodeChunk(missing)) as ReadonlyArray<unknown>;
          encoded.forEach((row, index) =>
            cache.set(missing[index]!, { encoded: row, length: JSON.stringify(row).length }),
          );
        }
        for (const row of chunk) {
          const saved = cache.get(row)!;
          length += saved.length;
          if (length > limit) return undefined;
          result.push(saved.encoded);
        }
      }
      return result;
    });
  };
}

/** Invalidate a yielding save when a newer save, removal, or environment clear begins. */
export function makeThreadCacheWriteOrder() {
  let latest = 0;
  const tickets = new Map<string, number>();
  const key = (environmentId: string, threadId: string) =>
    JSON.stringify([environmentId, threadId]);
  return {
    beginSave(environmentId: string, threadId: string) {
      const ticket = ++latest;
      tickets.set(key(environmentId, threadId), ticket);
      return () =>
        tickets.get(key(environmentId, threadId)) === ticket &&
        (tickets.get(environmentId) ?? 0) < ticket;
    },
    removeThread(environmentId: string, threadId: string) {
      tickets.set(key(environmentId, threadId), ++latest);
    },
    clearEnvironment(environmentId: string) {
      tickets.set(environmentId, ++latest);
    },
  };
}

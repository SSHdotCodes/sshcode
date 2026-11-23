import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Each subscription starts with full records, including after reconnect or replay. */
export function restoreThreadTextAppends<E, R>(
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
): Stream.Stream<OrchestrationV2ThreadStreamItem, E | OrchestrationV2GetThreadProjectionError, R> {
  return Stream.suspend(() => {
    const texts = new Map<string, string>();
    const key = (thread: string, id: string) => `${thread}:${id}`;
    // The server remembers the 32 records it last sent (LIVE_DEDUPE_MEMORY) and
    // only appends to those. Holding twice as many here keeps every base it can
    // name even if the two limits ever drift apart.
    const remember = (id: string, text: string) => {
      texts.delete(id);
      texts.set(id, text);
      if (texts.size > 64) texts.delete(texts.keys().next().value!);
    };
    const restore = (
      item: OrchestrationV2ThreadStreamItem,
    ): Effect.Effect<OrchestrationV2ThreadStreamItem, OrchestrationV2GetThreadProjectionError> => {
      if (item.kind === "snapshot") {
        texts.clear();
        for (const message of item.projection.messages)
          remember(key(message.threadId, message.id), message.text);
      }
      if (item.kind !== "event") return Effect.succeed(item);
      const { textAppendFrom, ...full } = item;
      const event = item.event;
      if (event.type !== "message.updated") {
        return textAppendFrom === undefined
          ? Effect.succeed(item)
          : Effect.fail(
              new OrchestrationV2GetThreadProjectionError({
                threadId: event.threadId,
                message: "Invalid thread text update; resynchronizing.",
              }),
            );
      }
      const id = key(event.payload.threadId, event.payload.id);
      const previous = texts.get(id);
      if (
        textAppendFrom !== undefined &&
        (previous === undefined || previous.length !== textAppendFrom)
      ) {
        // The surrounding RPC subscription retries from the last applied cursor.
        // Never advance that cursor or display a suffix with an unknown base.
        return Effect.fail(
          new OrchestrationV2GetThreadProjectionError({
            threadId: event.threadId,
            message: "Thread text update has no matching base; resynchronizing.",
          }),
        );
      }
      const text =
        textAppendFrom === undefined ? event.payload.text : previous! + event.payload.text;
      remember(id, text);
      return Effect.succeed(
        textAppendFrom === undefined
          ? item
          : {
              ...full,
              event: { ...event, payload: { ...event.payload, text } },
            },
      );
    };
    // Preserve RPC batches: splitting a replay into individual emissions would
    // make React publish once per event instead of once per received batch.
    return stream.pipe(Stream.mapArrayEffect((items) => Effect.forEach(items, restore)));
  });
}

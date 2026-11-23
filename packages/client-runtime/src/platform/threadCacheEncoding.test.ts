import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadCacheRowEncoder, makeThreadCacheWriteOrder } from "./threadCacheEncoding.ts";

const codec = Schema.encodeEffect(Schema.Array(Schema.Struct({ text: Schema.String })));
it.effect("yields between chunks, reuses immutable rows, and gives each save a budget", () =>
  Effect.gen(function* () {
    let yields = 0;
    let encodedRows = 0;
    const makeRows = makeThreadCacheRowEncoder({
      maxJsonLength: 3000,
      yieldToHost: Effect.sync(() => {
        yields++;
      }),
    });
    const encode = (rows: ReadonlyArray<{ text: string }>) => {
      encodedRows += rows.length;
      return codec(rows);
    };
    const rows = Array.from({ length: 70 }, (_, index) => ({ text: String(index) }));
    expect(yield* makeRows()(rows, encode)).toEqual(rows);
    expect(yields).toBe(2);
    expect(encodedRows).toBe(70);
    expect(yield* makeRows()(rows, encode)).toEqual(rows);
    expect(encodedRows).toBe(70);
    expect(yield* makeRows()([{ text: "x".repeat(3000) }], encode)).toBeUndefined();
  }),
);
it.effect("invalidates yielding saves per thread and environment", () =>
  Effect.sync(() => {
    const order = makeThreadCacheWriteOrder();
    const first = order.beginSave("env", "thread");
    const other = order.beginSave("other", "thread");
    const next = order.beginSave("env", "thread");
    expect(first()).toBe(false);
    expect(next()).toBe(true);
    order.removeThread("env", "thread");
    expect(next()).toBe(false);
    const again = order.beginSave("env", "thread");
    order.clearEnvironment("env");
    expect(again()).toBe(false);
    expect(other()).toBe(true);
  }),
);

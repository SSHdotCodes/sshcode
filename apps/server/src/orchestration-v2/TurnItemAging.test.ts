// @effect-diagnostics nodeBuiltinImport:off - runs the offline slim script on a scratch database.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemAging from "./TurnItemAging.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const CAP = TurnItemAging.AGED_OUTPUT_CHARS;
const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2999-01-01T00:00:00.000Z";

const age = (item: object) => {
  const aged = TurnItemAging.ageTurnItemJson(encodeJson(item));
  return aged === undefined ? undefined : (decodeJson(aged) as Record<string, unknown>);
};
const screenshot = "iVBORw0KGgo".repeat(400);
const text = (length: number, fill = "a") => `start${fill.repeat(length)}end`;

describe("ageTurnItemJson", () => {
  it("keeps three quarters of an old text from its start and a fifth from its end", () => {
    const output = text(10_000);
    const aged = age({ id: "item:command", type: "command_execution", input: "make", output });
    const head = output.slice(0, CAP * 0.75);
    const tail = output.slice(-(CAP * 0.2));
    expect(aged).toEqual({
      id: "item:command",
      type: "command_execution",
      input: "make",
      output: `${head}\n… ${(output.length - head.length - tail.length).toLocaleString("en-US")} characters removed to save space …\n${tail}`,
    });
    expect(String(aged?.output).length).toBeLessThanOrEqual(CAP);
    // Aging an aged item changes nothing.
    expect(TurnItemAging.ageTurnItemJson(encodeJson(aged))).toBeUndefined();
    expect(age({ type: "command_execution", output: "short" })).toBeUndefined();
  });

  it("drops screenshot bytes in both image shapes and keeps generated images whole", () => {
    const aged = age({
      type: "dynamic_tool",
      toolName: "computer-use.get_app_state",
      output: {
        content: [
          { type: "text", text: text(5_000) },
          { type: "image", data: screenshot, mimeType: "image/png" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot } },
        ],
        structuredContent: { note: "small" },
      },
    });
    expect(aged?.output).toMatchObject({
      content: [
        { type: "text" },
        { type: "image", mimeType: "image/png", imageUnavailable: true },
        { type: "image", mimeType: "image/jpeg", imageUnavailable: true },
      ],
      structuredContent: { note: "small" },
    });
    const generated = {
      type: "dynamic_tool",
      toolName: "image_gen",
      output: [{ type: "image", data: screenshot.repeat(10), mimeType: "image/png" }],
    };
    expect(age(generated)).toBeUndefined();
  });

  it("cuts down a large structured output whole and leaves other items alone", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      index,
      path: `/src/file-${index}.ts`,
    }));
    const aged = age({ type: "dynamic_tool", toolName: "Glob", output: { rows } });
    expect(typeof aged?.output).toBe("string");
    expect(String(aged?.output).startsWith('{"rows":[{"index":0')).toBe(true);
    expect(
      age({ type: "file_change", diffStr: text(3_000), oldStr: "small", newStr: text(3_000) }),
    ).toMatchObject({ oldStr: "small" });
    for (const item of [
      { type: "assistant_message", text: text(10_000) },
      { type: "subagent", prompt: text(10_000) },
    ]) {
      expect(age(item)).toBeUndefined();
    }
    expect(TurnItemAging.ageTurnItemJson("not json")).toBeUndefined();
  });
});

const insertItems = (
  items: ReadonlyArray<{ readonly payload: object; readonly updatedAt: string }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
      items.map(({ payload, updatedAt }, index) => ({
        turn_item_id: `item:${index + 1}`,
        thread_id: "thread:aging",
        ordinal: index + 1,
        type: (payload as { readonly type: string }).type,
        status: "completed",
        updated_at: updatedAt,
        payload_json: encodeJson({ id: `item:${index + 1}`, ...payload }),
      })),
    )}`;
  });

const storedPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly turn_item_id: string; readonly payload_json: string }>`
    SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items ORDER BY rowid
  `;
});

it.effect("ages rows in order up to the first recent one and resumes there", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const big = { type: "command_execution", output: text(10_000) };
    yield* insertItems([
      { payload: big, updatedAt: OLD },
      { payload: big, updatedAt: RECENT },
      { payload: big, updatedAt: OLD },
    ]);
    const saved: number[] = [];
    const pass = (afterRowId: number) =>
      TurnItemAging.ageTurnItems({
        cutoffIso: "2026-06-01T00:00:00.000Z",
        afterRowId,
        saveAgedThrough: (rowId) => Effect.sync(() => saved.push(rowId)),
      });
    const lengths = Effect.map(storedPayloads, (rows) =>
      rows.map((row) => row.payload_json.length < 3 * CAP),
    );

    expect(yield* pass(0)).toBe(1);
    expect(saved).toEqual([1]);
    expect(yield* lengths).toEqual([true, false, false]);

    yield* sql`UPDATE orchestration_v2_projection_turn_items SET updated_at = ${OLD} WHERE rowid = 2`;
    expect(yield* pass(1)).toBe(2);
    expect(saved).toEqual([1, 3]);
    expect(yield* lengths).toEqual([true, true, true]);
    // Nothing is left to change.
    expect(yield* pass(0)).toBe(0);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.live("an aged row and a row the offline slim trimmed are byte for byte the same", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const old = (payload: object) => ({ payload, updatedAt: OLD });
    // Every rule, then a recent row last so the server's pass ages everything before it.
    yield* insertItems([
      old({ type: "command_execution", input: "make", output: text(10_000, "é😀") }),
      old({ type: "command_execution", input: "ls", output: "small" }),
      old({
        type: "dynamic_tool",
        toolName: "mcp__t3-code__preview_snapshot",
        output: {
          content: [
            { type: "text", text: text(5_000) },
            { type: "image", data: screenshot, mimeType: "image/png" },
          ],
          structuredContent: { tree: text(3_000), screenshot: { index: 0 } },
        },
      }),
      old({
        type: "dynamic_tool",
        toolName: "Read",
        output: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot } },
        ],
      }),
      old({
        type: "dynamic_tool",
        toolName: "Glob",
        output: { rows: Array.from({ length: 500 }, (_, index) => `/src/file-${index}.ts`) },
      }),
      old({
        type: "dynamic_tool",
        toolName: "image_gen",
        output: [{ type: "image", data: screenshot.repeat(3), mimeType: "image/png" }],
      }),
      old({ type: "file_change", diffStr: text(4_000), oldStr: text(4_000), newStr: "small" }),
      old({ type: "assistant_message", text: text(10_000) }),
      old({ type: "subagent", prompt: text(10_000) }),
      { payload: { type: "command_execution", output: text(10_000) }, updatedAt: RECENT },
    ]);

    // The script reads a file database with the same tables and rows.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "turn-item-aging-"));
    const source = NodePath.join(dir, "source.sqlite");
    const slimmed = NodePath.join(dir, "slimmed.sqlite");
    const schema = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE name IN ('orchestration_events', 'orchestration_v2_projection_turn_items')
    `;
    const items = yield* sql<Record<string, string | number | null>>`
      SELECT * FROM orchestration_v2_projection_turn_items ORDER BY rowid
    `;
    const file = new NodeSqlite.DatabaseSync(source);
    for (const row of schema) file.exec(row.sql);
    file.exec(`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('event:1', 'thread', 'thread:aging', 0, 'thread.created', '${RECENT}', 'server', '{}', '{}', 2)`);
    const columns = Object.keys(items[0]!);
    const insert = file.prepare(
      `INSERT INTO orchestration_v2_projection_turn_items (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of items) insert.run(...columns.map((column) => row[column] ?? null));
    file.close();
    const script = NodeURL.fileURLToPath(
      new URL("../../../../scripts/maintenance/slim-statev2.mjs", import.meta.url),
    );
    yield* Effect.promise(() =>
      execFile(process.execPath, [
        script,
        source,
        slimmed,
        "--output-days",
        "7",
        "--cap",
        String(CAP),
      ]),
    );
    const slimmedFile = new NodeSqlite.DatabaseSync(slimmed, { readOnly: true });
    const slimmedRows = slimmedFile
      .prepare(
        "SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items ORDER BY rowid",
      )
      .all();
    slimmedFile.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });

    // Live clock: the script measures its cutoff from the wall clock too.
    const now = yield* Clock.currentTimeMillis;
    const cutoffIso = DateTime.formatIso(
      DateTime.makeUnsafe(now - Duration.toMillis(TurnItemAging.AGING_PERIOD)),
    );
    yield* TurnItemAging.ageTurnItems({
      cutoffIso,
      afterRowId: 0,
      saveAgedThrough: () => Effect.void,
    });
    const aged = yield* storedPayloads;
    expect(aged.map((row) => ({ ...row }))).toEqual(slimmedRows.map((row) => ({ ...row })));
    // The fixture exercises the rule: most rows changed.
    expect(
      aged.filter((row, index) => row.payload_json !== items[index]!.payload_json),
    ).toHaveLength(5);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

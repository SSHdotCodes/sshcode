/**
 * Shrinks the tool outputs of turn items that have not changed for a week.
 * Old work shows collapsed, its screenshots and full logs are rarely reopened,
 * and those outputs grew the turn item table by about 0.9 GB a week.
 *
 * `ageTurnItemJson` is the one definition of the rule. The offline slim
 * (scripts/maintenance/slim-statev2.mjs) carries a copy, and a test runs the
 * script to check that an aged row and a slimmed row are byte for byte the same.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

/** Items whose last update is older than this get their outputs aged. */
export const AGING_PERIOD = Duration.days(7);
/** An aged text keeps this many characters: three quarters from its start, a fifth from its end. */
export const AGED_OUTPUT_CHARS = 2_000;
/** Rows whose leading columns are read per slice; a cold slice of 2,000 held the reader 0.3 s. */
const AGING_SLICE = 500;
/**
 * Rows read and rewritten per batch. Rewrites run on the event loop's
 * connection, and replacing a payload frees its overflow pages.
 */
const REWRITE_BATCH_ROWS = 50;
const REWRITE_BATCH_BYTES = 4 * 1024 * 1024;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ageText = (text: string): string => {
  if (text.length <= AGED_OUTPUT_CHARS) return text;
  const head = text.slice(0, Math.floor(AGED_OUTPUT_CHARS * 0.75));
  const tail = text.slice(text.length - Math.floor(AGED_OUTPUT_CHARS * 0.2));
  const removed = (text.length - head.length - tail.length).toLocaleString("en-US");
  return `${head}\n… ${removed} characters removed to save space …\n${tail}`;
};

/** An image's bytes become the marker clients show for an unavailable image (see readToolOutputImage). */
const omitImage = (block: unknown): unknown => {
  if (!isRecord(block) || block.type !== "image") return block;
  const source = isRecord(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return block;
  const data = source === undefined ? block.data : source.data;
  if (typeof data !== "string") return block;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  return { type: "image", mimeType, imageUnavailable: true };
};

/** The block positions toolOutputImages reads: a block, a list of blocks, or an MCP `content` list. */
const omitImages = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(omitImage);
  if (isRecord(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omitImage) };
  }
  return omitImage(value);
};

const ageStrings = (value: unknown): unknown => {
  if (typeof value === "string") return ageText(value);
  if (Array.isArray(value)) return value.map(ageStrings);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, ageStrings(entry)]),
    );
  }
  return value;
};

/**
 * A stored turn item with its tool outputs aged: a command's output, a tool's
 * output (screenshot bytes dropped, a large rest cut down whole) and a file
 * change's texts. Generated images (`image_gen`), every other item type and
 * every other field stay as they are. Returns undefined when nothing changes
 * or the JSON does not parse.
 */
export function ageTurnItemJson(payloadJson: string): string | undefined {
  let item: unknown;
  try {
    item = decodeJson(payloadJson);
  } catch {
    return undefined;
  }
  if (!isRecord(item)) return undefined;
  let aged: Record<string, unknown> = item;
  if (item.type === "command_execution" && typeof item.output === "string") {
    aged = { ...item, output: ageText(item.output) };
  } else if (
    item.type === "dynamic_tool" &&
    item.output !== undefined &&
    item.toolName !== "image_gen"
  ) {
    const output = ageStrings(omitImages(item.output));
    const json = encodeJson(output);
    aged = { ...item, output: json.length > AGED_OUTPUT_CHARS * 4 ? ageText(json) : output };
  } else if (item.type === "file_change") {
    aged = { ...item };
    for (const key of ["diffStr", "oldStr", "newStr"]) {
      const text = item[key];
      if (typeof text === "string") aged[key] = ageText(text);
    }
  }
  const json = encodeJson(aged);
  return json === payloadJson ? undefined : json;
}

/**
 * Ages the outputs of turn items not updated since `cutoffIso`, in row order
 * from `afterRowId`. Rows follow creation order and nearly every item settles
 * within minutes, so the pass stops at the first item updated since the
 * cutoff and resumes there next time. `saveAgedThrough` records progress.
 */
export const ageTurnItems = <E, R>(input: {
  readonly cutoffIso: string;
  readonly afterRowId: number;
  readonly saveAgedThrough: (rowId: number) => Effect.Effect<void, E, R>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let agedThrough = input.afterRowId;
    let rewritten = 0;
    while (true) {
      // Leading columns only: octet_length needs no payload read.
      const rows = yield* sql<{
        readonly row_id: number;
        readonly updated_at: string;
        readonly bytes: number;
      }>`
        SELECT rowid AS row_id, updated_at, octet_length(payload_json) AS bytes
        FROM orchestration_v2_projection_turn_items
        WHERE rowid > ${agedThrough}
          AND type IN ('command_execution', 'dynamic_tool', 'file_change')
        ORDER BY rowid
        LIMIT ${AGING_SLICE}
      `.pipe(NodeSqliteClient.readOnly);
      const batches: number[][] = [];
      let batch: number[] = [];
      let batchBytes = 0;
      let reachedRecent = false;
      let scannedThrough = agedThrough;
      for (const row of rows) {
        if (row.updated_at >= input.cutoffIso) {
          reachedRecent = true;
          break;
        }
        scannedThrough = row.row_id;
        if (row.bytes <= AGED_OUTPUT_CHARS) continue;
        if (
          batch.length >= REWRITE_BATCH_ROWS ||
          (batch.length > 0 && batchBytes + row.bytes > REWRITE_BATCH_BYTES)
        ) {
          batches.push(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(row.row_id);
        batchBytes += row.bytes;
      }
      if (batch.length > 0) batches.push(batch);
      for (const rowIds of batches) {
        // `length` counts characters, as the offline slim selects rows.
        const stored = yield* sql<{
          readonly row_id: number;
          readonly updated_at: string;
          readonly payload_json: string;
          readonly chars: number;
        }>`
          SELECT rowid AS row_id, updated_at, payload_json, length(payload_json) AS chars
          FROM orchestration_v2_projection_turn_items
          WHERE rowid IN ${sql.in(rowIds)}
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of stored) {
          // An item updated since the scan is recent again; leave it.
          if (row.chars <= AGED_OUTPUT_CHARS || row.updated_at >= input.cutoffIso) continue;
          const aged = ageTurnItemJson(row.payload_json);
          if (aged === undefined) continue;
          // Nor one updated between this read and the write.
          yield* sql`
            UPDATE orchestration_v2_projection_turn_items SET payload_json = ${aged}
            WHERE rowid = ${row.row_id} AND updated_at = ${row.updated_at}
          `;
          rewritten += 1;
        }
        // Let requests through between batches.
        yield* Effect.yieldNow;
      }
      if (scannedThrough > agedThrough) {
        agedThrough = scannedThrough;
        yield* input.saveAgedThrough(agedThrough);
      }
      if (reachedRecent || rows.length < AGING_SLICE) return rewritten;
      yield* Effect.yieldNow;
    }
  });

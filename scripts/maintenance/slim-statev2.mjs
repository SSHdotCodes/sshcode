// One-time slim of SSHCode's statev2.sqlite into a new file. The source is only read.
// Run with SSHCode's own runtime so SQLite and JSON match the server:
//   ELECTRON_RUN_AS_NODE=1 /Applications/SSHCode.app/Contents/MacOS/SSHCode slim.mjs SRC DST [--event-days 2] [--output-days 7] [--cap 2000]
// Keeps every chat, message, run and step. Drops event-log rows older than --event-days except each
// thread's creation and newest event, project events and referenced subagent prompt anchors.
// Tool outputs older than --output-days are trimmed to --cap characters (head and tail kept), and
// their screenshot bytes are dropped; generated images (image_gen) stay whole. That rule
// (slimItem below) is a copy of ageTurnItemJson in apps/server/src/orchestration-v2/TurnItemAging.ts,
// which the server applies to items a week old; with the default --cap, an aged row and a slimmed
// row are byte for byte the same (TurnItemAging.test.ts runs this script to check). Change both.
// Prints the retention floor (first kept recent sequence) for event-log-compaction.json.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

const args = process.argv.slice(2);
const [src, dst] = args;
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const EVENT_DAYS = flag("--event-days", 2);
const OUTPUT_DAYS = flag("--output-days", 7);
const CAP = flag("--cap", 2_000);
if (!src || !dst)
  throw new Error("usage: slim.mjs SRC DST [--event-days N] [--output-days N] [--cap N]");
if (NodeFS.existsSync(dst)) throw new Error(`${dst} exists; refusing to overwrite`);

const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

const db = new NodeSqlite.DatabaseSync(dst);
db.exec(`
  PRAGMA page_size = 4096;
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -1048576;
`);
db.exec(`ATTACH DATABASE ${quote(`file:${src}?mode=ro`).replaceAll('"', "'")} AS src`);
// One transaction: every read of src sees the same snapshot, even if a server is still writing.
db.exec("BEGIN");

const tables = db
  .prepare(
    "SELECT name, sql FROM src.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all();
for (const { sql } of tables) db.exec(sql);
log(`created ${tables.length} tables`);

const columnsOf = (table) =>
  db.prepare(`SELECT name, type, pk FROM pragma_table_info(?, 'src')`).all(table);
const isRowidTable = (table) => !/WITHOUT\s+ROWID/i.test(table.sql);
// A rowid table whose single INTEGER PRIMARY KEY is the rowid keeps it through its column.
const rowidAlias = (table) => {
  const pk = columnsOf(table.name).filter((column) => column.pk > 0);
  return pk.length === 1 && /^INTEGER$/i.test(pk[0].type);
};
const copyStatement = (table, where = "") => {
  const columns = columnsOf(table.name).map((column) => quote(column.name));
  const withRowid = isRowidTable(table) && !rowidAlias(table);
  const target = (withRowid ? ["rowid", ...columns] : columns).join(", ");
  const source = (withRowid ? ["rowid", ...columns] : columns).join(", ");
  return `INSERT INTO main.${quote(table.name)} (${target}) SELECT ${source} FROM src.${quote(table.name)} ${where}`;
};

// The first event at or after the cutoff time. Sequences grow with time; occurred_at has no index.
const cutoffIso = new Date(Date.now() - EVENT_DAYS * 86_400_000).toISOString();
const outputCutoffIso = new Date(Date.now() - OUTPUT_DAYS * 86_400_000).toISOString();
const bounds = db
  .prepare("SELECT MIN(sequence) AS lo, MAX(sequence) AS hi FROM src.orchestration_events")
  .get();
const firstAtOrAfter = db.prepare(
  "SELECT sequence, occurred_at FROM src.orchestration_events WHERE sequence >= ? ORDER BY sequence LIMIT 1",
);
let lo = bounds.lo;
let hi = bounds.hi + 1;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const row = firstAtOrAfter.get(mid);
  if (row === undefined || row.occurred_at >= cutoffIso) hi = mid;
  else lo = row.sequence + 1;
}
const floor = firstAtOrAfter.get(lo)?.sequence ?? bounds.hi + 1;
log(`cutoff ${cutoffIso}: event floor sequence ${floor} (max ${bounds.hi})`);

const special = new Set(["orchestration_events", "orchestration_v2_projection_turn_items"]);
for (const table of tables) {
  if (special.has(table.name)) continue;
  db.exec(copyStatement(table));
}
log("copied the other tables");

// Event log: recent rows plus the anchors older rows still provide.
db.exec(`
  CREATE TEMP TABLE keep_seq (sequence INTEGER PRIMARY KEY);
  INSERT OR IGNORE INTO keep_seq SELECT sequence FROM src.orchestration_events WHERE sequence >= ${floor};
  INSERT OR IGNORE INTO keep_seq SELECT sequence FROM src.orchestration_events
    WHERE NOT (application_event_version = 2 AND aggregate_kind = 'thread');
  INSERT OR IGNORE INTO keep_seq SELECT sequence FROM src.orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND event_type = 'thread.created';
  INSERT OR IGNORE INTO keep_seq SELECT MAX(sequence) FROM src.orchestration_events
    GROUP BY aggregate_kind, stream_id;
  INSERT OR IGNORE INTO keep_seq
    SELECT CAST(json_extract(event.payload_json, '$.promptSequence') AS INTEGER)
    FROM src.orchestration_events AS event JOIN keep_seq AS kept ON kept.sequence = event.sequence
    WHERE event.event_type IN ('turn-item.updated', 'subagent.updated')
      AND json_type(event.payload_json, '$.promptSequence') = 'integer';
`);
const eventsTable = tables.find((table) => table.name === "orchestration_events");
db.exec(
  `${copyStatement(eventsTable, "WHERE sequence IN (SELECT sequence FROM temp.keep_seq)")} ORDER BY sequence`,
);
log(
  `events kept ${db.prepare("SELECT COUNT(*) AS n FROM main.orchestration_events").get().n} of ${db.prepare("SELECT COUNT(*) AS n FROM src.orchestration_events").get().n}`,
);

// Turn items: old tool outputs trimmed, everything else byte for byte.
const trimText = (text) => {
  if (text.length <= CAP) return text;
  const head = text.slice(0, Math.floor(CAP * 0.75));
  const tail = text.slice(text.length - Math.floor(CAP * 0.2));
  return `${head}\n… ${(text.length - head.length - tail.length).toLocaleString("en-US")} characters removed to save space …\n${tail}`;
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
// Same shapes as packages/shared/src/toolOutput.ts readToolOutputImage / omitToolOutputImageData.
const omitImage = (block) => {
  if (!isObject(block) || block.type !== "image") return block;
  const source = isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return block;
  const data = source === undefined ? block.data : source.data;
  if (typeof data !== "string") return block;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  return { type: "image", mimeType, imageUnavailable: true };
};
const omitImages = (value) => {
  if (Array.isArray(value)) return value.map(omitImage);
  if (isObject(value) && Array.isArray(value.content))
    return { ...value, content: value.content.map(omitImage) };
  return omitImage(value);
};
const trimStrings = (value) => {
  if (typeof value === "string") return trimText(value);
  if (Array.isArray(value)) return value.map(trimStrings);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v)]));
  return value;
};
const slimItem = (payloadJson) => {
  const item = JSON.parse(payloadJson);
  if (item.type === "command_execution" && typeof item.output === "string") {
    item.output = trimText(item.output);
  } else if (
    item.type === "dynamic_tool" &&
    item.output !== undefined &&
    item.toolName !== "image_gen"
  ) {
    let output = trimStrings(omitImages(item.output));
    const json = JSON.stringify(output);
    if (json !== undefined && json.length > CAP * 4) output = trimText(json);
    item.output = output;
  } else if (item.type === "file_change") {
    for (const key of ["diffStr", "oldStr", "newStr"])
      if (typeof item[key] === "string") item[key] = trimText(item[key]);
  }
  return JSON.stringify(item);
};
const itemsTable = tables.find((table) => table.name === "orchestration_v2_projection_turn_items");
const needsTrim = `type IN ('command_execution', 'dynamic_tool', 'file_change') AND updated_at < '${outputCutoffIso}' AND length(payload_json) > ${CAP}`;
db.exec(copyStatement(itemsTable, `WHERE NOT (${needsTrim})`));
const itemColumns = columnsOf(itemsTable.name).map((column) => column.name);
const insertItem = db.prepare(
  `INSERT INTO main.${quote(itemsTable.name)} (rowid, ${itemColumns.map(quote).join(", ")}) VALUES (${["?", ...itemColumns.map(() => "?")].join(", ")})`,
);
let trimmed = 0;
let kept = 0;
let bytesBefore = 0;
let bytesAfter = 0;
for (const row of db
  .prepare(`SELECT rowid AS _rowid, * FROM src.${quote(itemsTable.name)} WHERE ${needsTrim}`)
  .iterate()) {
  let payload = row.payload_json;
  try {
    payload = slimItem(row.payload_json);
    trimmed += 1;
  } catch {
    kept += 1;
  }
  bytesBefore += row.payload_json.length;
  bytesAfter += payload.length;
  insertItem.run(
    row._rowid,
    ...itemColumns.map((name) => (name === "payload_json" ? payload : row[name])),
  );
}
log(
  `turn items: trimmed ${trimmed} old outputs (${(bytesBefore / 1e9).toFixed(2)} GB -> ${(bytesAfter / 1e9).toFixed(2)} GB), ${kept} left as is`,
);

// AUTOINCREMENT counters, so new sequences never reuse a deleted one.
if (tables.some((table) => /AUTOINCREMENT/i.test(table.sql))) {
  db.exec(
    "DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM src.sqlite_sequence;",
  );
}
const indexes = db
  .prepare(
    "SELECT sql FROM src.sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL",
  )
  .all();
for (const { sql } of indexes) db.exec(sql);
log(`created ${indexes.length} indexes, triggers and views`);
// The server's planner reads sqlite_stat1; keep its statistics so query plans stay the same.
db.exec("ANALYZE main.sqlite_sequence");
if (db.prepare("SELECT 1 FROM src.sqlite_master WHERE name = 'sqlite_stat1'").get()) {
  db.exec(
    "DELETE FROM main.sqlite_stat1; INSERT INTO main.sqlite_stat1 SELECT * FROM src.sqlite_stat1;",
  );
}
db.exec("COMMIT");
db.exec("DETACH DATABASE src");

// Checks: every table but the event log has the same rows; the file is sound.
const check = new NodeSqlite.DatabaseSync(dst);
check.exec(`ATTACH DATABASE 'file:${src}?mode=ro' AS src`);
const mismatches = [];
for (const table of tables) {
  if (table.name === "orchestration_events") continue;
  const a = check.prepare(`SELECT COUNT(*) AS n FROM src.${quote(table.name)}`).get().n;
  const b = check.prepare(`SELECT COUNT(*) AS n FROM main.${quote(table.name)}`).get().n;
  if (a !== b) mismatches.push(`${table.name}: ${a} -> ${b}`);
}
const quick = check
  .prepare("PRAGMA main.quick_check")
  .all()
  .map((row) => Object.values(row)[0]);
check.exec("PRAGMA main.journal_mode = WAL");
check.close();
log(`row counts: ${mismatches.length === 0 ? "all equal" : mismatches.join("; ")}`);
log(`quick_check: ${quick.join(", ")}`);
log(
  `size ${(NodeFS.statSync(src).size / 1e9).toFixed(2)} GB -> ${(NodeFS.statSync(dst).size / 1e9).toFixed(2)} GB`,
);
console.log(
  JSON.stringify({
    retainedFrom: floor,
    cutoff: cutoffIso,
    ok: mismatches.length === 0 && quick[0] === "ok",
  }),
);
if (mismatches.length > 0 || quick[0] !== "ok") process.exit(1);

import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OrchestrationSearchThreadsResult } from "@t3tools/contracts";

export class SearchIndexError extends Schema.TaggedError<SearchIndexError>()("SearchIndexError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The chat search index is unavailable.";
  }
}

export interface SearchDocument {
  readonly messageId: string;
  readonly threadId: string;
  readonly text: string;
  readonly source: "user" | "assistant";
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SearchThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly archived: boolean;
}

// The index has its own worker: FTS reads, bulk writes and (later) vector scans
// must never hold the orchestration connection or occupy the server event loop.
const source = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
let db;
let generation = 0;
let vectors = null;
const byMessage = new Map();
function open() {
  generation++;
  db = new DatabaseSync(workerData.filename);
  if (workerData.filename !== ':memory:') fs.chmodSync(workerData.filename, 0o600);
  db.exec("PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;");
  // A write-ahead log never shrinks by itself: one large removal left a 500 MB log beside an
  // 800 MB index. Cap it at 64 MB from now on and hand back what an earlier run left behind.
  db.exec("PRAGMA journal_size_limit=67108864;");
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  db.exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS threads(threadId TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS documents(messageId TEXT PRIMARY KEY, threadId TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT, updatedAt TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,messageId TEXT NOT NULL,offset INTEGER NOT NULL,text TEXT NOT NULL,vector BLOB);");
  db.exec("CREATE INDEX IF NOT EXISTS chunks_message ON chunks(messageId);");
  db.exec("CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(id) WHERE vector IS NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS documents_thread ON documents(threadId);");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(title, text, content='documents', content_rowid='rowid', tokenize='unicode61', prefix='2 3');");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fragments USING fts5(title, text, content='documents', content_rowid='rowid', tokenize='trigram');");
  for (const name of ['words', 'fragments']) {
    db.exec('CREATE TRIGGER IF NOT EXISTS ' + name + '_ai AFTER INSERT ON documents BEGIN INSERT INTO ' + name + '(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;');
    db.exec('CREATE TRIGGER IF NOT EXISTS ' + name + '_ad AFTER DELETE ON documents BEGIN INSERT INTO ' + name + '(' + name + ',rowid,title,text) VALUES(\'delete\',old.rowid,old.title,old.text); END;');
    db.exec('CREATE TRIGGER IF NOT EXISTS ' + name + '_au AFTER UPDATE ON documents BEGIN INSERT INTO ' + name + '(' + name + ',rowid,title,text) VALUES(\'delete\',old.rowid,old.title,old.text); INSERT INTO ' + name + '(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;');
  }
}
open();
function forget(messageId) {
  for (const id of byMessage.get(messageId) ?? []) vectors?.delete(id);
  byMessage.delete(messageId);
}
function remember(row) {
  const bytes = row.vector.byteOffset % 4 === 0 ? row.vector : row.vector.slice();
  const vector = new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  vectors.set(row.id, {messageId:row.messageId,vector});
  if (!byMessage.has(row.messageId)) byMessage.set(row.messageId,new Set());
  byMessage.get(row.messageId).add(row.id);
}
function transaction(f) { db.exec('BEGIN'); try { const result = f(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
function snippet(text, query) {
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= 240) return text;
  const offset = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.min(Math.max(0, offset - 72), text.length - 236);
  return (start ? '…' : '') + text.slice(start, start + 236) + (start + 236 < text.length ? '…' : '');
}
function quote(text) { return '"' + text.replaceAll('"', '""') + '"'; }
function keyword(query, limit) {
  const parts = query.trim().split(/\s+/).slice(0, 20);
  const candidates = new Map();
  for (const name of ['words', 'fragments']) {
    const terms = name === 'words' ? parts.filter(p => /[\p{L}\p{N}]/u.test(p)) : parts.filter(p => [...p].length >= 3);
    if (!terms.length) continue;
    const match = terms.map(p => quote(p) + (name === 'words' ? '*' : '')).join(' AND ');
    if(name === 'fragments' && candidates.size >= 50) continue;
    const rows = db.prepare('WITH hits AS MATERIALIZED (SELECT d.rowid AS id,d.threadId,bm25(' + name + ',3,1) AS rank,instr(lower(d.text),lower(?))>0 AS exact FROM ' + name + ' JOIN documents d ON d.rowid=' + name + '.rowid WHERE ' + name + ' MATCH ?), best AS (SELECT *,row_number() OVER(PARTITION BY threadId ORDER BY exact DESC,rank,id DESC) AS n FROM hits) SELECT d.*,t.projectId,t.archived,best.rank FROM best JOIN documents d ON d.rowid=best.id JOIN threads t ON t.threadId=d.threadId WHERE n=1 ORDER BY best.exact DESC,best.rank LIMIT 200').all(query,match);
    rows.forEach((row, i) => { if (!candidates.has(row.messageId)) candidates.set(row.messageId, {...row, order:i}); });
  }
  const exact = text => text.toLowerCase().includes(query.toLowerCase());
  const rows = [...candidates.values()].sort((a,b) => Number(exact(b.text)) - Number(exact(a.text)) || a.order - b.order || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const seen = new Set();
  return rows.filter(row => { if(seen.has(row.threadId)) return false; seen.add(row.threadId); return true; }).slice(0,limit).map(row => ({ threadId:row.threadId, projectId:row.projectId, title:row.title, archived:!!row.archived, source:row.source, snippet:snippet(row.text, query), messageId:row.messageId.startsWith('title:') ? null : row.messageId, messageCreatedAt:row.createdAt }));
}
function semantic(vector, limit) {
  if (vectors === null) {
    vectors = new Map(); byMessage.clear();
    for (const row of db.prepare('SELECT id,messageId,vector FROM chunks WHERE vector IS NOT NULL').iterate()) remember(row);
  }
  const scored = [];
  let count = 0, sum = 0, squares = 0;
  for (const [id, row] of vectors) {
    if(row.vector.length !== vector.length) continue;
    let score = 0;
    for(let i=0;i<vector.length;i++) score += vector[i]*row.vector[i];
    count++; sum += score; squares += score*score;
    if(score > 0.2) scored.push({id,score});
  }
  scored.sort((a,b) => b.score-a.score);
  // One query's scores sit in a narrow band across a whole library (measured: every chat
  // between 0.66 and 0.83), so a fixed floor passes everything and meaning search padded each
  // result list to its limit. Keep only what stands out from this query's own spread; a small
  // index has too few scores to measure one.
  const mean = count ? sum/count : 0;
  const standsOut = count >= 200 ? mean + 3.5*Math.sqrt(Math.max(0, squares/count - mean*mean)) : 0;
  const seen = new Set(); const matches = [];
  const get = db.prepare('SELECT d.*,c.text AS chunkText,t.projectId,t.archived FROM chunks c JOIN documents d ON d.messageId=c.messageId JOIN threads t ON t.threadId=d.threadId WHERE c.id=?');
  for (const {id,score} of scored) {
    // The three closest chats always show, so a flat spread still answers something.
    if(score < standsOut && matches.length >= 3) break;
    const row = get.get(id);
    if(!row || seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    matches.push({threadId:row.threadId,projectId:row.projectId,title:row.title,archived:!!row.archived,source:row.source,snippet:snippet(row.chunkText,''),messageId:row.messageId,messageCreatedAt:row.createdAt});
    if(matches.length === limit) break;
  }
  return matches;
}
function run(op, input) {
  // An unlinked cache is reopened on the next operation; deleting it is always safe.
  if (workerData.filename !== ':memory:' && !fs.existsSync(workerData.filename)) { db.close(); vectors = null; byMessage.clear(); open(); }
  switch(op) {
    case 'generation': return generation;
    case 'configure': return transaction(() => {
      const old = db.prepare("SELECT value FROM metadata WHERE key='embedding'").get();
      if(old?.value !== input) {db.exec('UPDATE chunks SET vector=NULL');vectors=null;byMessage.clear();}
      db.prepare("INSERT INTO metadata VALUES('embedding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input);
    });
    case 'threads': return transaction(() => {
      const alive = new Set(input.map(t => t.threadId));
      for (const {threadId} of db.prepare('SELECT threadId FROM threads').all()) if(!alive.has(threadId)) {
        for (const {messageId} of db.prepare('SELECT messageId FROM documents WHERE threadId=?').all(threadId)) { forget(messageId); db.prepare('DELETE FROM chunks WHERE messageId=?').run(messageId); }
        db.prepare('DELETE FROM documents WHERE threadId=?').run(threadId);
        db.prepare('DELETE FROM threads WHERE threadId=?').run(threadId);
      }
      for (const t of input) {
        const old = db.prepare('SELECT title,projectId,archived FROM threads WHERE threadId=?').get(t.threadId);
        if(old && old.title === t.title && old.projectId === t.projectId && !!old.archived === t.archived) continue;
        db.prepare('INSERT INTO threads VALUES(?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET projectId=excluded.projectId,title=excluded.title,archived=excluded.archived').run(t.threadId,t.projectId,t.title,Number(t.archived));
        if (!old || old.title !== t.title) {
          for (const {messageId} of db.prepare('SELECT messageId FROM documents WHERE threadId=?').all(t.threadId)) forget(messageId);
          db.prepare('UPDATE chunks SET vector=NULL WHERE messageId IN (SELECT messageId FROM documents WHERE threadId=?)').run(t.threadId);
          db.prepare('UPDATE documents SET title=? WHERE threadId=?').run(t.title,t.threadId);
          db.prepare('INSERT OR REPLACE INTO documents VALUES(?,?,?,?,?,?,?)').run('title:'+t.threadId,t.threadId,t.title,t.title,'user',null,'');
        }
      }
    });
    case 'documents': return transaction(() => {
      for (const d of input) {
        const thread = db.prepare('SELECT title FROM threads WHERE threadId=?').get(d.threadId);
        if(!thread) continue;
        const old = db.prepare('SELECT text,updatedAt FROM documents WHERE messageId=?').get(d.messageId);
        if(old && (old.updatedAt > d.updatedAt || (old.text === d.text && old.updatedAt === d.updatedAt))) continue;
        forget(d.messageId);
        db.prepare('DELETE FROM chunks WHERE messageId=?').run(d.messageId);
        for(let offset=0;offset<d.text.length;offset+=1320) {
          db.prepare('INSERT INTO chunks VALUES(?,?,?,?,NULL)').run(d.messageId+':'+offset,d.messageId,offset,d.text.slice(offset,offset+1500));
          if(offset+1500>=d.text.length) break;
        }
        db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?) ON CONFLICT(messageId) DO UPDATE SET title=excluded.title,text=excluded.text,source=excluded.source,updatedAt=excluded.updatedAt').run(d.messageId,d.threadId,thread.title,d.text,d.source,d.createdAt,d.updatedAt);
      }
    });
    case 'removeMessage': return transaction(() => { forget(input); db.prepare('DELETE FROM chunks WHERE messageId=?').run(input); db.prepare('DELETE FROM documents WHERE messageId=?').run(input); });
    case 'pending': return db.prepare('SELECT c.id,c.text,d.title,d.updatedAt FROM chunks c JOIN documents d ON d.messageId=c.messageId WHERE c.vector IS NULL ORDER BY d.updatedAt DESC,c.offset LIMIT ?').all(input);
    case 'vectors': return transaction(() => { for(const v of input) {
      // A batch finishing after an edit/deletion cannot put stale vectors back.
      const row = db.prepare('SELECT c.id,c.messageId FROM chunks c JOIN documents d ON d.messageId=c.messageId WHERE c.id=? AND d.updatedAt=? AND c.text=? AND d.title=?').get(v.id,v.updatedAt,v.text,v.title);
      if(!row) continue;
      const data = new Float32Array(v.vector);
      const bytes = new Uint8Array(data.buffer);
      db.prepare('UPDATE chunks SET vector=? WHERE id=?').run(bytes,v.id);
      if(vectors !== null) remember({...row,vector:bytes});
    } });
    case 'semantic': return { matches:semantic(input.vector,input.limit ?? 50) };
    case 'stats': return db.prepare('SELECT count(*) AS totalChunks,count(vector) AS embeddedChunks FROM chunks').get();
    case 'keyword': return { matches:keyword(input.query,input.limit ?? 50) };
    case 'count': return db.prepare("SELECT count(*) AS count FROM documents WHERE messageId NOT LIKE 'title:%'").get().count;
    case 'rebuild': db.exec('DELETE FROM chunks; DELETE FROM documents; DELETE FROM threads;'); vectors = null; byMessage.clear(); return;
    default: throw new Error('Unknown search operation');
  }
}
parentPort.on('message', ({id,op,input}) => {
  try { parentPort.postMessage({id,value:run(op,input)}); }
  catch (error) { parentPort.postMessage({id,error}); }
});
`;

const PendingChunk = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
});
const VectorStats = Schema.Struct({ totalChunks: Schema.Number, embeddedChunks: Schema.Number });

export const openSearchIndex = Effect.fnUntraced(function* (filename: string) {
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new NodeWorkerThreads.Worker(source, { eval: true, workerData: { filename } }),
      catch: (cause) => new SearchIndexError({ cause }),
    }),
    (worker) => Effect.promise(() => worker.terminate()),
  );
  let nextId = 0;
  let failed = false;
  const pending = new Map<
    number,
    (result: { readonly value?: unknown; readonly error?: unknown }) => void
  >();
  const fail = () => {
    failed = true;
    for (const resume of pending.values()) resume({ error: true });
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on(
    "message",
    (reply: { readonly id: number; readonly value?: unknown; readonly error?: unknown }) => {
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    },
  );
  const request = (op: string, input?: unknown) =>
    Effect.callback<unknown, SearchIndexError>((resume) => {
      if (failed) {
        resume(Effect.fail(new SearchIndexError({ cause: "worker exited" })));
        return;
      }
      const id = ++nextId;
      pending.set(id, (result) =>
        resume(
          result.error
            ? Effect.fail(new SearchIndexError({ cause: result.error }))
            : Effect.succeed(result.value),
        ),
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
      worker.postMessage({ id, op, input });
      return Effect.sync(() => {
        pending.delete(id);
      });
    });
  return {
    configure: (identity: string) => request("configure", identity).pipe(Effect.asVoid),
    pending: (limit = 16) =>
      request("pending", limit).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PendingChunk))),
        Effect.mapError((cause) => new SearchIndexError({ cause })),
      ),
    storeVectors: (
      rows: ReadonlyArray<typeof PendingChunk.Type & { readonly vector: ReadonlyArray<number> }>,
    ) => request("vectors", rows).pipe(Effect.asVoid),
    semantic: (vector: ReadonlyArray<number>, limit = 50) =>
      request("semantic", { vector, limit }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OrchestrationSearchThreadsResult)),
        Effect.mapError((cause) => new SearchIndexError({ cause })),
      ),
    stats: request("stats").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(VectorStats)),
      Effect.mapError((cause) => new SearchIndexError({ cause })),
    ),
    syncThreads: (threads: ReadonlyArray<SearchThread>) =>
      request("threads", threads).pipe(Effect.asVoid),
    upsert: (documents: ReadonlyArray<SearchDocument>) =>
      request("documents", documents).pipe(Effect.asVoid),
    removeMessage: (messageId: string) => request("removeMessage", messageId).pipe(Effect.asVoid),
    keyword: (query: string, limit = 50) =>
      request("keyword", { query, limit }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OrchestrationSearchThreadsResult)),
        Effect.mapError((cause) => new SearchIndexError({ cause })),
      ),
    count: request("count").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Number)),
      Effect.mapError((cause) => new SearchIndexError({ cause })),
    ),
    generation: request("generation").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Number)),
      Effect.mapError((cause) => new SearchIndexError({ cause })),
    ),
    rebuild: request("rebuild").pipe(Effect.asVoid),
  };
});

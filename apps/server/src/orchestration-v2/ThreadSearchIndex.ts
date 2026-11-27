import { makeThreadSearchContextMatcher } from "@t3tools/shared/threadSearch";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  OrchestrationSearchThreadsResult,
  type OrchestrationSearchThreadsInput,
} from "@t3tools/contracts";

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
  readonly activityAt?: string;
  readonly context?: ReadonlyArray<string>;
  readonly firstUserMessageId?: string | null;
  readonly model?: string | null;
  readonly harness?: string | null;
}

// The index has its own worker: FTS reads, bulk writes and (later) vector scans
// must never hold the orchestration connection or occupy the server event loop.
const source = String.raw`
const makeThreadSearchContextMatcher = ${makeThreadSearchContextMatcher.toString()};
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
let db;
let generation = 0;
let vectors = null;
const byMessage = new Map();
// Activity and search context are projections. Keep them in memory so old
// disposable indexes can be reused without a schema change.
const threadMetadata = new Map();
const maxThreadMetadata = 4096;
function open() {
  generation++;
  threadMetadata.clear();
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
function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
function tokens(text) {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}
function snippet(text, query) {
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= 240) return text;
  const lower = text.toLowerCase();
  const phrase = query.toLowerCase().replace(/\s+/g, ' ');
  let offset = phrase.length ? lower.indexOf(phrase) : 0;
  if (offset < 0) {
    for (const word of phrase.split(' ').sort((a, b) => b.length - a.length)) {
      offset = lower.indexOf(word);
      if (offset !== -1) break;
    }
  }
  let start = Math.min(Math.max(0, offset - 18), text.length - 238);
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = start + 238;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
function oneEdit(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  if (left.length < right.length) return left.slice(index) === right.slice(index + 1);
  if (left.length > right.length) return left.slice(index + 1) === right.slice(index);
  if (left.slice(index + 1) === right.slice(index + 1)) return true;
  return left[index] === right[index + 1] && left[index + 1] === right[index] &&
    left.slice(index + 2) === right.slice(index + 2);
}
function nameMatch(query, terms, title, metadata) {
  const name = fold(title).trim().replace(/\s+/g, ' ');
  if (name === query) return { score: 8 };
  if (!terms.length) return null;
  const titleWords = tokens(title).map(word => ({ word, folded: fold(word) }));
  const words = titleWords.map(({ folded }) => folded);
  const unmatched = terms.filter(term => !words.some(word => word.startsWith(term)));
  if (unmatched.length === 0) {
    const wholeWords = terms.every(term => words.includes(term));
    if (name.startsWith(query)) return { score: wholeWords ? 7 : 6 };
    if (name.includes(query)) return { score: wholeWords ? 6 : 5 };
    return { score: wholeWords ? 5 : 4 };
  }
  const modelWords = metadata?.model ? tokens(fold(metadata.model)) : [];
  const harnessWords = metadata?.harness ? tokens(fold(metadata.harness)) : [];
  const hasTerm = (words, term) => words.some(word => word === term ||
    (term.length >= 3 && word.startsWith(term)));
  const harnessTerms = unmatched.filter(term => hasTerm(harnessWords, term));
  const modelTerms = unmatched.filter(term => !hasTerm(harnessWords, term));
  if (modelTerms.every(term => hasTerm(modelWords, term))) {
    return {
      score: 3,
      ...(modelTerms.length ? { matchedModel: metadata.model } : {}),
      ...(harnessTerms.length ? { matchedHarness: metadata.harness } : {}),
    };
  }
  if (name.includes(query)) return { score: 2 };
  if (unmatched.length === 1 && /^\p{L}{5,32}$/u.test(unmatched[0])) {
    const correction = titleWords.find(({ folded }) => oneEdit(unmatched[0], folded));
    if (correction) return { score: 1, titleCorrection: correction.word };
  }
  return null;
}
function compareCandidates(a, b) {
  return b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) ||
    a.threadId.localeCompare(b.threadId);
}
function namedCandidates(query, cancel) {
  const phrase = fold(query).trim().replace(/\s+/g, ' ');
  const terms = [...new Set(tokens(phrase))].slice(0, 20);
  const matchesContext = makeThreadSearchContextMatcher(query);
  const candidates = new Map();
  const viaContext = [];
  let total = 0;
  for (const thread of db.prepare('SELECT threadId, projectId, title, archived FROM threads').iterate()) {
    if (cancel && Atomics.load(cancel, 0)) return new Map();
    total++;
    const metadata = threadMetadata.get(thread.threadId);
    const name = nameMatch(phrase, terms, thread.title, metadata);
    const titleAbout = matchesContext(thread.title);
    const about = titleAbout || metadata?.context?.some(matchesContext) === true;
    if (!name && !about) continue;
    if (about && !titleAbout) viaContext.push(thread.threadId);
    const {matchedModel, matchedHarness, titleCorrection} = name ?? {};
    candidates.set(thread.threadId, {
      threadId: thread.threadId,
      updatedAt: metadata?.activityAt ?? '',
      score: Number(about),
      name: {
        ...thread, archived: !!thread.archived, source: 'user',
        snippet: thread.title.slice(0, 240), messageId: null, messageCreatedAt: null,
        ...(matchedModel ? { matchedModel } : {}),
        ...(matchedHarness ? { matchedHarness } : {}),
        ...(titleCorrection ? { titleCorrection } : {}),
      },
      contextOnly: !name,
    });
  }
  // A workspace field most chats share ("No project", a scratch folder, one
  // repo) says nothing about a chat. Those matches drop to passing mentions.
  if (viaContext.length > Math.max(20, total / 2)) {
    for (const threadId of viaContext) {
      const candidate = candidates.get(threadId);
      if (candidate.contextOnly) candidates.delete(threadId);
      else candidate.score = 0;
    }
  }
  return candidates;
}
function quote(text) { return '"' + text.replaceAll('"', '""') + '"'; }
function appendMessageHits(table, expression, candidates, priority, cancel) {
  // Scan FTS postings before applying the chat limit. A chat can have recent
  // activity even if its only matching message is old or was indexed early.
  const rows = db.prepare('SELECT d.threadId, d.messageId, d.rowid, bm25(' + table + ') AS rank FROM ' + table +
    ' JOIN documents d ON d.rowid = ' + table + '.rowid WHERE ' + table + ' MATCH ? AND d.createdAt IS NOT NULL');
  for (const row of rows.iterate(expression)) {
    if (cancel && Atomics.load(cancel, 0)) return;
    const metadata = threadMetadata.get(row.threadId);
    let candidate = candidates.get(row.threadId);
    const opening = metadata?.firstUserMessageId === row.messageId;
    if (!candidate) {
      candidate = {threadId: row.threadId, updatedAt: metadata?.activityAt ?? '', score: 0};
      candidates.set(row.threadId, candidate);
    }
    if (opening) candidate.score = 1;
    const hit = candidate.hit;
    // Preserve the best excerpt within the first matching query form.
    if (!hit || (hit.priority === priority &&
        (row.rank < hit.rank || (row.rank === hit.rank && row.rowid > hit.rowid)))) {
      candidate.hit = {...row, priority};
    }
  }
}
function resultPage(candidates, query, limit, cursor) {
  const ordered = [...candidates.values()]
    .filter(candidate => !cursor || compareCandidates(candidate, cursor) > 0)
    .sort(compareCandidates);
  const document = db.prepare('SELECT d.messageId, d.text, d.source, d.createdAt, t.title, t.projectId, t.archived' +
    ' FROM documents d JOIN threads t ON t.threadId=d.threadId WHERE d.rowid=?');
  const page = limit > 0 ? ordered.slice(0, limit) : [];
  const matches = page.flatMap(candidate => {
    const {threadId, updatedAt, score, name, hit} = candidate;
    const order = {about: score === 1, ...(updatedAt ? {activityAt: updatedAt} : {})};
    if (name && (!hit || (!candidate.contextOnly && !name.titleCorrection))) return [{...name, ...order}];
    const row = hit ? document.get(hit.rowid) : undefined;
    if (!row) return [];
    return [{
      ...order, threadId, projectId: row.projectId, title: row.title, archived: !!row.archived,
      source: row.source, snippet: snippet(row.text, query), messageId: row.messageId,
      messageCreatedAt: row.createdAt,
    }];
  });
  if (page.length === 0 || ordered.length <= page.length) return {matches};
  // Keep the existing cursor wire shape for clients already able to page searches.
  const {score, updatedAt, threadId} = page[page.length - 1];
  return {matches, nextCursor: {names: {score, archived: 0, updatedAt, threadId}}};
}
function keyword({query, limit, cursor}, cancel) {
  const cancelled = () => cancel && Atomics.load(cancel, 0);
  const candidates = namedCandidates(query, cancel);
  if (cancelled()) return {matches: []};
  const position = cursor?.names;
  const parts = [...new Set(query.trim().split(/\s+/))].slice(0, 20);
  const words = parts.filter(part => /[\p{L}\p{N}]/u.test(part));
  if (words.length) {
    const exact = quote(query.trim());
    appendMessageHits('words', 'text : ' + exact, candidates, 0, cancel);
    if (cancelled()) return {matches: []};
    const prefix = words.map(part => quote(part) + '*').join(' AND ');
    appendMessageHits('words', 'text : ((' + prefix + ') NOT ' + exact + ')', candidates, 1, cancel);
    if (cancelled()) return {matches: []};
  }
  if (parts.every(part => [...part].length >= 3)) {
    appendMessageHits('fragments', 'text : (' + parts.map(quote).join(' AND ') + ')', candidates, 2, cancel);
    if (cancelled()) return {matches: []};
  }
  return resultPage(candidates, query, limit, position);
}
function semantic(vector, limit, cancel) {
  if (vectors === null) {
    vectors = new Map(); byMessage.clear();
    for (const row of db.prepare('SELECT id,messageId,vector FROM chunks WHERE vector IS NOT NULL').iterate()) remember(row);
  }
  const scored = [];
  let count = 0, sum = 0, squares = 0;
  for (const [id, row] of vectors) {
    if (cancel && Atomics.load(cancel, 0)) return [];
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
  const candidates = new Map();
  const lookup = db.prepare('SELECT d.threadId FROM chunks c JOIN documents d ON d.messageId=c.messageId WHERE c.id=?');
  for (const {id,score} of scored) {
    if (cancel && Atomics.load(cancel, 0)) return [];
    // The three closest chats always show, so a flat spread still answers something.
    if (score < standsOut && candidates.size >= 3) break;
    const row = lookup.get(id);
    if (!row || candidates.has(row.threadId)) continue;
    candidates.set(row.threadId, {
      id, threadId: row.threadId, score: 0, updatedAt: threadMetadata.get(row.threadId)?.activityAt ?? '',
    });
  }
  const get = db.prepare('SELECT d.messageId,d.threadId,d.title,d.source,d.createdAt,c.text AS chunkText,t.projectId,t.archived' +
    ' FROM chunks c JOIN documents d ON d.messageId=c.messageId JOIN threads t ON t.threadId=d.threadId WHERE c.id=?');
  return [...candidates.values()].sort(compareCandidates).slice(0, limit).flatMap(({id,updatedAt}) => {
    const row = get.get(id);
    if (!row) return [];
    return [{
      ...(updatedAt ? {activityAt: updatedAt} : {}),
      threadId:row.threadId,projectId:row.projectId,title:row.title,archived:!!row.archived,
      source:row.source,snippet:snippet(row.chunkText,''),messageId:row.messageId,messageCreatedAt:row.createdAt,
    }];
  });
}
function run(op, input, cancel) {
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
      threadMetadata.clear();
      for (const [i, t] of input.entries()) {
        threadMetadata.set(t.threadId, {
          activityAt: t.activityAt,
          context: t.context?.slice(0, 24).map(term => term.slice(0, 200)),
          firstUserMessageId: t.firstUserMessageId,
          ...(i < maxThreadMetadata ? {model: t.model?.slice(0, 128), harness: t.harness?.slice(0, 128)} : {}),
        });
      }
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
    case 'activity': {
      const metadata = threadMetadata.get(input.threadId);
      if (metadata) Object.assign(metadata, {activityAt: input.activityAt, firstUserMessageId: input.firstUserMessageId});
      return;
    }
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
    case 'semantic': return { matches:semantic(input.vector,input.limit ?? 50,cancel) };
    case 'stats': return db.prepare('SELECT count(*) AS totalChunks,count(vector) AS embeddedChunks FROM chunks').get();
    case 'names': {
      const candidates = namedCandidates(input.query, cancel);
      if (cancel && Atomics.load(cancel, 0)) return {matches: []};
      const names = [...candidates.values()].filter(candidate => !candidate.name.titleCorrection);
      return {matches: resultPage(names, input.query, input.limit).matches};
    }
    case 'keyword': return keyword(input, cancel);
    case 'count': return db.prepare("SELECT count(*) AS count FROM documents WHERE messageId NOT LIKE 'title:%'").get().count;
    case 'rebuild': db.exec('DELETE FROM chunks; DELETE FROM documents; DELETE FROM threads;'); vectors = null; byMessage.clear(); threadMetadata.clear(); return;
    default: throw new Error('Unknown search operation');
  }
}
parentPort.on('message', ({id,op,input,cancel}) => {
  if (cancel && Atomics.load(cancel, 0)) return;
  try { parentPort.postMessage({id,value:run(op,input,cancel)}); }
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
      const cancel =
        op === "keyword" || op === "names" || op === "semantic"
          ? new Int32Array(new SharedArrayBuffer(4))
          : undefined;
      pending.set(id, (result) =>
        resume(
          result.error
            ? Effect.fail(new SearchIndexError({ cause: result.error }))
            : Effect.succeed(result.value),
        ),
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
      worker.postMessage({ id, op, input, cancel });
      return Effect.sync(() => {
        if (cancel) Atomics.store(cancel, 0, 1);
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
    names: (query: string, limit = 50) =>
      request("names", { query, limit }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OrchestrationSearchThreadsResult)),
        Effect.mapError((cause) => new SearchIndexError({ cause })),
      ),
    updateActivity: (input: Pick<SearchThread, "threadId" | "activityAt" | "firstUserMessageId">) =>
      request("activity", input).pipe(Effect.asVoid),
    keyword: (query: string, limit = 50, cursor?: OrchestrationSearchThreadsInput["cursor"]) =>
      request("keyword", { query, limit, cursor }).pipe(
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

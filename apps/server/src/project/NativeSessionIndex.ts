// @effect-diagnostics nodeBuiltinImport:off -- Node opendir supports bounded entry iteration; Effect readDirectory materializes the entire directory.
// @effect-diagnostics globalDate:off -- Expiration and page CPU budgets use wall time inside the native async iterator, independent of Effect TestClock.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  AgentSessionSource,
  NativeSessionDiscoverInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { NativeSessionError } from "@t3tools/contracts";

export interface NativeSessionRoot {
  readonly directory: string;
  readonly provider: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
}
export interface NativeSessionFile extends NativeSessionRoot {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly device?: number;
  readonly inode?: number;
}
export interface NativeSessionHead {
  readonly nativeId: string;
  readonly cwd: string;
  readonly title: string;
  readonly firstPrompt: string;
}

/** Walk entries lazily, including empty directories, so each request can yield. Never follow symlinks. */
async function* walk(
  root: NativeSessionRoot,
  directory = root.directory,
  depth = 0,
): AsyncGenerator<NativeSessionFile | null> {
  const dir = await NodeFSP.opendir(directory).catch(() => null);
  if (!dir) return;
  try {
    for await (const entry of dir) {
      yield null;
      const filePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory() && depth < 6 && entry.name !== "subagents") {
        yield* walk(root, filePath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await NodeFSP.stat(filePath).catch(() => null);
        if (info?.isFile())
          yield {
            ...root,
            filePath,
            mtimeMs: info.mtime.getTime(),
            size: info.size,
            device: info.dev,
            inode: info.ino,
          };
      }
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
}

function compareFiles(a: NativeSessionFile, b: NativeSessionFile) {
  return b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath);
}

/** Maintain newest-first ordering incrementally instead of sorting an unbounded inventory in one page. */
function pushFile(heap: NativeSessionFile[], file: NativeSessionFile) {
  heap.push(file);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareFiles(heap[parent]!, file) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = file;
}
function popFile(heap: NativeSessionFile[]): NativeSessionFile | null {
  const first = heap[0] ?? null;
  const last = heap.pop();
  if (heap.length === 0 || !last) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compareFiles(heap[child + 1]!, heap[child]!) < 0) child++;
    if (compareFiles(last, heap[child]!) <= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

interface Snapshot {
  readonly walker: AsyncGenerator<NativeSessionFile | null>;
  readonly files: NativeSessionFile[];
  readonly seen: Set<string>;
  query: string;
  inventoryDone: boolean;
  currentFile: NativeSessionFile | null;
  reader: AsyncGenerator<NativeSessionHead | null> | null;
  expiresAt: number;
}

interface IndexedSessionPage {
  readonly sessions: ReadonlyArray<{
    readonly sessionKey: string;
    readonly file: NativeSessionFile;
    readonly head: NativeSessionHead;
  }>;
  readonly nextCursor: string | null;
  readonly scanning: boolean;
}

/** The index owns only read handles and expiring snapshots; native homes are never written. */
export class NativeSessionIndex {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cursors = new Map<
    string,
    { readonly snapshotId: string; page?: IndexedSessionPage }
  >();
  private readonly selections = new Map<
    string,
    { file: NativeSessionFile; head: NativeSessionHead; expiresAt: number }
  >();
  private readonly readHead: (file: NativeSessionFile) => AsyncGenerator<NativeSessionHead | null>;
  constructor(readHead: (file: NativeSessionFile) => AsyncGenerator<NativeSessionHead | null>) {
    this.readHead = readHead;
  }

  async close() {
    for (const snapshot of this.snapshots.values()) {
      await snapshot.walker.return(undefined);
      await snapshot.reader?.return(undefined);
    }
    this.snapshots.clear();
    this.cursors.clear();
    this.selections.clear();
  }

  async discover(
    input: NativeSessionDiscoverInput,
    roots: readonly NativeSessionRoot[],
  ): Promise<IndexedSessionPage> {
    const now = Date.now();
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.expiresAt < now || (!input.cursor && this.snapshots.size >= 8)) {
        await snapshot.walker.return(undefined);
        await snapshot.reader?.return(undefined);
        this.snapshots.delete(key);
      }
    }
    for (const [key, selected] of this.selections)
      if (selected.expiresAt < now) this.selections.delete(key);
    for (const [key, cursor] of this.cursors)
      if (!this.snapshots.has(cursor.snapshotId)) this.cursors.delete(key);
    const cursor = input.cursor ? this.cursors.get(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new NativeSessionError({ reason: "expired" });
    const snapshotId = cursor?.snapshotId ?? NodeCrypto.randomUUID();
    let snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      if (input.cursor) throw new NativeSessionError({ reason: "expired" });
      async function* walkRoots() {
        for (const root of roots) yield* walk(root);
      }
      snapshot = {
        walker: walkRoots(),
        files: [],
        seen: new Set(),
        query: input.query?.trim().toLowerCase() ?? "",
        inventoryDone: false,
        currentFile: null,
        reader: null,
        expiresAt: now + 300_000,
      };
      this.snapshots.set(snapshotId, snapshot);
    }
    if (input.query !== undefined && snapshot.query !== input.query.trim().toLowerCase())
      throw new NativeSessionError({ reason: "expired" });
    snapshot.expiresAt = now + 300_000;
    if (cursor?.page) return cursor.page;
    const sessions: Array<{
      sessionKey: string;
      file: NativeSessionFile;
      head: NativeSessionHead;
    }> = [];
    // A head reader yields after each 32 KiB chunk. Inventory yields after each directory entry.
    // This bounds I/O, parsing and response size independently of the home directory's age/size.
    for (let operations = 0; operations < 256 && Date.now() - now < 150; operations++) {
      if (!snapshot.inventoryDone) {
        const next = await snapshot.walker.next();
        if (next.done) {
          snapshot.inventoryDone = true;
        } else if (next.value) pushFile(snapshot.files, next.value);
        continue;
      }
      const file = snapshot.currentFile ?? popFile(snapshot.files);
      snapshot.currentFile = file;
      if (!file) break;
      snapshot.reader ??= this.readHead(file);
      const next = await snapshot.reader.next();
      if (!next.done && next.value === null) continue;
      await snapshot.reader.return(undefined);
      snapshot.reader = null;
      snapshot.currentFile = null;
      if (next.done || !next.value) continue;
      const head = next.value;
      const identity = `${file.providerInstanceId}\0${head.nativeId}`;
      if (snapshot.seen.has(identity)) continue;
      snapshot.seen.add(identity);
      if (
        snapshot.query &&
        ![head.title, head.firstPrompt, head.cwd].some((s) =>
          s.toLowerCase().includes(snapshot.query),
        )
      )
        continue;
      const sessionKey = NodeCrypto.randomUUID();
      this.selections.set(sessionKey, { file, head, expiresAt: now + 300_000 });
      while (this.selections.size > 512)
        this.selections.delete(this.selections.keys().next().value!);
      sessions.push({ sessionKey, file, head });
      if (sessions.length >= Math.max(1, Math.min(50, input.limit ?? 30))) break;
    }
    const more =
      !snapshot.inventoryDone || snapshot.currentFile !== null || snapshot.files.length > 0;
    const nextCursor = more ? NodeCrypto.randomUUID() : null;
    const page = {
      sessions,
      nextCursor,
      scanning: !snapshot.inventoryDone || (more && sessions.length === 0),
    };
    if (cursor) cursor.page = page;
    if (nextCursor) this.cursors.set(nextCursor, { snapshotId });
    while (this.cursors.size > 32) this.cursors.delete(this.cursors.keys().next().value!);
    return page;
  }

  async selection(sessionKey: string) {
    const selected = this.selections.get(sessionKey);
    if (!selected || selected.expiresAt < Date.now())
      throw new NativeSessionError({ reason: "expired" });
    const info = await NodeFSP.stat(selected.file.filePath).catch(() => null);
    if (!info?.isFile()) throw new NativeSessionError({ reason: "unreadable" });
    return { ...selected, currentMtimeMs: info.mtime.getTime() };
  }
}

/** Read only complete tail records. The head supplies identity even when the tail starts mid-turn. */
export async function readNativeSessionTail(file: NativeSessionFile) {
  const handle = await NodeFSP.open(file.filePath, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - 512 * 1024);
    const buffer = Buffer.alloc(Math.min(info.size, 512 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      contents: start > 0 ? text.slice(text.indexOf("\n") + 1) : text,
      truncated: start > 0,
    };
  } finally {
    await handle.close();
  }
}

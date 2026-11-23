// @effect-diagnostics nodeBuiltinImport:off -- VACUUM runs off the server event loop.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { StorageMaintenanceError, type StorageDatabaseReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

const isStorageMaintenanceError = Schema.is(StorageMaintenanceError);
const margin = (bytes: number) => Math.max(256 * 1024 ** 2, Math.ceil(bytes * 0.1));

export const databaseStoragePreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const filename = databases.find((row) => row.name === "main")?.file;
  if (!filename)
    return yield* new StorageMaintenanceError({
      message: "Space reclamation requires a file-backed database.",
    });
  const pages = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
  const sizes = yield* sql<{ page_size: number }>`PRAGMA page_size`;
  const counts = yield* sql<{ page_count: number }>`PRAGMA page_count`;
  const modes = yield* sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`;
  return yield* Effect.tryPromise(async () => {
    const [database, disk, walBytes] = await Promise.all([
      NodeFSP.stat(filename),
      NodeFSP.statfs(NodePath.dirname(filename)),
      NodeFSP.stat(`${filename}-wal`).then(
        (stat) => stat.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      ),
    ]);
    const freelistBytes = (pages[0]?.freelist_count ?? 0) * (sizes[0]?.page_size ?? 0);
    // The WAL may contain most of a newly-grown database; the main file alone
    // understates the temporary database and journal space VACUUM can need.
    const logicalBytes = (counts[0]?.page_count ?? 0) * (sizes[0]?.page_size ?? 0);
    const workingBytes = Math.max(database.size, logicalBytes);
    const mode = modes[0]?.auto_vacuum === 2 ? ("incremental" as const) : ("vacuum" as const);
    const requiredFreeBytes =
      mode === "vacuum" ? 2 * workingBytes + margin(workingBytes) : margin(0);
    const freeDiskBytes = disk.bavail * disk.bsize;
    return {
      filename,
      report: {
        databaseBytes: database.size,
        freelistBytes,
        walBytes,
        estimatedGainBytes: Math.max(0, database.size + walBytes - logicalBytes + freelistBytes),
        freeDiskBytes,
        requiredFreeBytes,
        mode,
        canReclaim: freeDiskBytes >= requiredFreeBytes,
      } satisfies StorageDatabaseReport,
    };
  });
});

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const db = new DatabaseSync(workerData.filename);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  const before = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (before.busy) throw new Error('Database readers are keeping the WAL open. Retry reclamation after their reads finish.');
  const mode = db.prepare('PRAGMA auto_vacuum').get().auto_vacuum;
  const bytes = fs.statSync(workerData.filename).size;
  const logicalBytes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
  const workingBytes = Math.max(bytes, logicalBytes);
  const disk = fs.statfsSync(path.dirname(workerData.filename));
  const required = mode === 2 ? 256 * 1024 ** 2 : 2 * workingBytes + Math.max(256 * 1024 ** 2, Math.ceil(workingBytes * 0.1));
  if (disk.bavail * disk.bsize < required) throw new Error('Not enough free disk space to reclaim safely. Free at least the database size plus its safety margin first.');
  // VACUUM owns SQLite's write lock for its transaction. Other processes wait or get SQLITE_BUSY.
  db.exec(mode === 2 ? 'PRAGMA incremental_vacuum' : 'VACUUM');
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  parentPort.postMessage({ busy: checkpoint.busy });
} finally { db.close(); }
`;

/** Reserve the writer without opening a transaction: VACUUM cannot run inside one. */
export const reclaimDatabaseSpace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Read the preview before reservation, then recheck disk space inside the worker.
  const before = yield* databaseStoragePreview;
  if (!before.report.canReclaim)
    return yield* new StorageMaintenanceError({
      message:
        "Not enough free disk space. Free the database size plus its safety margin before reclaiming space.",
    });
  const checkpointBusy = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* sql.reserve;
      // Hold reservation through interruption too, until SQLite has closed the worker connection.
      return yield* Effect.tryPromise(
        () =>
          new Promise<boolean>((resolve, reject) => {
            const worker = new NodeWorkerThreads.Worker(workerSource, {
              eval: true,
              workerData: { filename: before.filename },
            });
            let busy = false;
            worker.once("message", (message: { busy: number }) => {
              busy = message.busy !== 0;
            });
            worker.once("error", reject);
            worker.once("exit", (code) =>
              code === 0
                ? resolve(busy)
                : reject(new Error(`Database maintenance exited with code ${code}.`)),
            );
          }),
      ).pipe(Effect.uninterruptible);
    }),
  );
  const after = yield* databaseStoragePreview;
  return {
    ...after.report,
    checkpointBusy,
    reclaimedBytes: Math.max(
      0,
      before.report.databaseBytes +
        before.report.walBytes -
        after.report.databaseBytes -
        after.report.walBytes,
    ),
  } satisfies StorageDatabaseReport;
}).pipe(
  Effect.mapError((cause) =>
    isStorageMaintenanceError(cause)
      ? cause
      : new StorageMaintenanceError({
          message: `Could not reclaim database space: ${String(cause)}`,
        }),
  ),
);

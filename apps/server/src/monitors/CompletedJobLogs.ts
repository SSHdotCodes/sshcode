// @effect-diagnostics nodeBuiltinImport:off -- completed-job retention verifies filesystem identities.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COMPLETED_BYTES = 512 * 1024 * 1024;
const DELIVERED_FILE = ".delivered.json";
const Delivered = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), deliveredAt: Schema.Number }),
);
const encodeDelivered = Schema.encodeSync(Delivered);
const decodeDelivered = Schema.decodeUnknownOption(Delivered);
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Written before removing the durable completion from the monitor journal. */
export async function markJobLogDelivered(logPath: string, now: number): Promise<void> {
  if (NodePath.basename(logPath) !== "output.log") return;
  await NodeFSP.writeFile(
    NodePath.join(NodePath.dirname(logPath), DELIVERED_FILE),
    encodeDelivered({ version: 1, deliveredAt: now }),
    { mode: 0o600, flag: "wx" },
  ).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
}

/** Whole completed logs expire; live/recoverable logs and their byte offsets never change. */
export async function sweepCompletedJobLogs(input: {
  readonly root: string;
  readonly now: number;
  readonly isProtected: (directory: string) => boolean;
  readonly includeLegacy?: boolean;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
}): Promise<{ readonly removed: number; readonly bytes: number }> {
  const root = await NodeFSP.lstat(input.root).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (root === null || !root.isDirectory() || root.isSymbolicLink())
    return { removed: 0, bytes: 0 };
  const candidates: Array<{
    directory: string;
    ino: number;
    dev: number;
    mtimeMs: number;
    completedAt: number;
    bytes: number;
  }> = [];
  for (const entry of await NodeFSP.readdir(input.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^monitor-[a-f0-9-]{36}$/u.test(entry.name)) continue;
    const directory = NodePath.join(input.root, entry.name);
    if (input.isProtected(directory)) continue;
    const stat = await NodeFSP.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let bytes = 0;
    let safe = true;
    for (const file of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (
        !file.isFile() ||
        !["output.log", "exit", "exit.partial", "start", DELIVERED_FILE].includes(file.name)
      ) {
        safe = false;
        break;
      }
      bytes += (await NodeFSP.lstat(NodePath.join(directory, file.name))).size;
    }
    if (!safe) continue;
    const delivered = await NodeFSP.readFile(NodePath.join(directory, DELIVERED_FILE), "utf8")
      .then(decodeDelivered)
      .catch((error: unknown) => {
        if (missing(error)) return Option.none();
        throw error;
      });
    let completedAt: number;
    if (Option.isSome(delivered)) completedAt = delivered.value.deliveredAt;
    else {
      if (!input.includeLegacy) continue;
      // Older releases removed journal entries on delivery without a marker.
      // A valid exit receipt plus no journal owner proves this is completed work.
      const receipt = NodePath.join(directory, "exit");
      const text = await NodeFSP.readFile(receipt, "utf8").catch((error: unknown) => {
        if (missing(error)) return "";
        throw error;
      });
      if (!/^\d+\s*$/u.test(text)) continue;
      completedAt = (await NodeFSP.lstat(receipt)).mtimeMs;
    }
    if (!Number.isFinite(completedAt) || completedAt > input.now) continue;
    candidates.push({
      directory,
      ino: stat.ino,
      dev: stat.dev,
      mtimeMs: stat.mtimeMs,
      completedAt,
      bytes,
    });
  }
  candidates.sort((left, right) => left.completedAt - right.completedAt);
  let total = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  let removed = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    if (
      input.now - candidate.completedAt < (input.maxAgeMs ?? RETENTION_MS) &&
      total <= (input.maxBytes ?? MAX_COMPLETED_BYTES)
    )
      continue;
    const currentRoot = await NodeFSP.lstat(input.root);
    const current = await NodeFSP.lstat(candidate.directory).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (
      currentRoot.ino !== root.ino ||
      currentRoot.dev !== root.dev ||
      currentRoot.isSymbolicLink() ||
      current === null ||
      current.ino !== candidate.ino ||
      current.dev !== candidate.dev ||
      current.isSymbolicLink() ||
      current.mtimeMs !== candidate.mtimeMs ||
      input.isProtected(candidate.directory)
    )
      continue;
    await NodeFSP.rm(candidate.directory, { recursive: true, force: true });
    total -= candidate.bytes;
    bytes += candidate.bytes;
    removed++;
  }
  return { removed, bytes };
}

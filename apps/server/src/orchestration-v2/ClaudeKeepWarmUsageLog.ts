import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * The log is read whole by the usage reader and only its recent rows count, so it stays
 * small: past this size the older half is dropped.
 */
export const KEEP_WARM_USAGE_LOG_MAX_BYTES = 256 * 1024;

/** Appends rows to `<dir>/usage.jsonl`, owner-only, trimming the oldest rows past the cap. */
export const appendKeepWarmUsageRows = (
  fileSystem: FileSystem.FileSystem,
  dir: string,
  rows: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (rows.length === 0) return;
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    const file = `${dir}/usage.jsonl`;
    const size = yield* fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (size > KEEP_WARM_USAGE_LOG_MAX_BYTES) {
      const text = yield* fileSystem.readFileString(file);
      const tail = text.slice(-KEEP_WARM_USAGE_LOG_MAX_BYTES / 2);
      // Start at a whole row. A shrunken file makes the usage reader read it afresh.
      const kept = tail.slice(tail.indexOf("\n") + 1);
      yield* fileSystem.writeFileString(`${file}.partial`, kept, { mode: 0o600 });
      yield* fileSystem.rename(`${file}.partial`, file);
    }
    yield* fileSystem.writeFileString(file, rows.map((row) => `${row}\n`).join(""), {
      flag: "a",
      mode: 0o600,
    });
  });

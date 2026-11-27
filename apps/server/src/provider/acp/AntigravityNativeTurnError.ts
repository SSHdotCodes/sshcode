import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

const USER_INPUT_STEP = 14;
const ERROR_STEP = 17;
const MAX_ERROR_BYTES = 16 * 1024;

const query = <A extends object>(
  filename: string,
  statement: string,
  args: ReadonlyArray<number> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(statement, args);
  }).pipe(
    Effect.provide(Sqlite.layer({ filename, readonly: true })),
    Effect.orElseSucceed((): ReadonlyArray<A> => []),
  );

/** Remembers each native log's position before the prompt and reads only the new terminal error. */
export const watchAntigravityNativeTurnError = Effect.fnUntraced(function* (input: {
  readonly sessionId: string;
  readonly dataDirectories: ReadonlyArray<string>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { sessionId, fileSystem: fs, path } = input;
  if (!/^[a-z0-9_-]{1,128}$/iu.test(sessionId)) return Effect.undefined;

  const identity = Effect.fnUntraced(function* (file: string) {
    if ((yield* fs.realPath(file)) !== file) return undefined;
    const entry = yield* fs.stat(file);
    if (entry.type !== "File" || Option.isNone(entry.ino)) return undefined;
    return `${entry.dev}:${entry.ino.value}`;
  });

  const cursors = yield* Effect.forEach(input.dataDirectories, (directory) =>
    Effect.gen(function* () {
      const file = path.join(yield* fs.realPath(directory), "conversations", `${sessionId}.db`);
      if (!(yield* fs.exists(file))) return { file, start: -1, identity: undefined };
      const before = yield* identity(file);
      if (before === undefined) return undefined;
      const [row] = yield* query<{ idx: number | null }>(file, "SELECT max(idx) AS idx FROM steps");
      return row === undefined ? undefined : { file, start: row.idx ?? -1, identity: before };
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  return Effect.gen(function* () {
    for (const cursor of cursors) {
      if (cursor === undefined) continue;
      const after = yield* identity(cursor.file).pipe(Effect.orElseSucceed(() => undefined));
      if (after === undefined || (cursor.identity !== undefined && cursor.identity !== after))
        continue;
      const [row] = yield* query<{ payload: unknown }>(
        cursor.file,
        `SELECT substr(last.step_payload, 1, ?) AS payload
           FROM (SELECT * FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1) AS last
           WHERE last.step_type = ? AND EXISTS (
             SELECT 1 FROM steps WHERE idx > ? AND idx < last.idx AND step_type = ?
           )`,
        [MAX_ERROR_BYTES, cursor.start, ERROR_STEP, cursor.start, USER_INPUT_STEP],
      );
      if (row?.payload instanceof Uint8Array) return new TextDecoder().decode(row.payload);
    }
    return undefined;
  });
});

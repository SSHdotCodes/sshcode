import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as SqlError from "effect/sql/SqlError";

type ProviderStorageRetryMode = "bounded" | "until_available";

export const ProviderStorageRetry = Context.Reference<ProviderStorageRetryMode | null>(
  "t3/persistence/ProviderStorageRetry",
  { defaultValue: () => null },
);

function isStorageError(error: unknown, fullOnly: boolean): boolean {
  // SQL and persistence wrappers retain the driver's error. Inspect only fixed
  // codes, never messages (which can contain SQL or user data).
  let cause = error;
  for (let depth = 0; depth < 8 && Predicate.isObject(cause); depth++) {
    const result =
      "errcode" in cause && typeof cause.errcode === "number" ? cause.errcode & 0xff : undefined;
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    if (result === 13 || code === "SQLITE_FULL") return true;
    // WAL creation and I/O can report CANTOPEN or IOERR when the volume fills.
    if (
      !fullOnly &&
      (result === 10 ||
        result === 14 ||
        code === "ENOSPC" ||
        code === "EDQUOT" ||
        code === "SQLITE_CANTOPEN" ||
        code?.startsWith("SQLITE_CANTOPEN_") ||
        code === "SQLITE_IOERR" ||
        code?.startsWith("SQLITE_IOERR_"))
    )
      return true;
    cause = SqlError.isSqlError(cause)
      ? cause.reason.cause
      : "cause" in cause
        ? cause.cause
        : undefined;
  }
  return false;
}

const isStorageCause = <E>(cause: Cause.Cause<E>, fullOnly: boolean) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) =>
    reason._tag === "Fail"
      ? isStorageError(reason.error, fullOnly)
      : reason._tag === "Die" && isStorageError(reason.defect, fullOnly),
  );

export const isProviderStorageFailure = <E>(cause: Cause.Cause<E>) => isStorageCause(cause, false);

const retryStorageCause = <A, E, R>(
  effect: Effect.Effect<A, Cause.Cause<E>, R>,
  mode: ProviderStorageRetryMode | null,
) => {
  const retryable = (cause: Cause.Cause<E>) => isStorageCause(cause, mode === null);
  return effect.pipe(
    Effect.tapError((cause) =>
      retryable(cause)
        ? Effect.logWarning("SQLite storage is unavailable. Retaining the operation for retry.")
        : Effect.void,
    ),
    Effect.retry({
      while: retryable,
      ...(mode === "bounded" ? { times: 7 } : {}),
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
      ),
    }),
    Effect.catch((cause) => Effect.failCause(cause)),
  );
};

/** Retry a rolled-back transaction, with no SQL lock held between attempts. */
export const retrySqliteFull = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  retryStorageCause(write.pipe(Effect.sandbox), null);

/** Wrap the transaction's cause only. A post-commit failure must never repeat the write. */
export const retrySqliteTransaction = <A, E, R>(transaction: Effect.Effect<A, Cause.Cause<E>, R>) =>
  Effect.flatMap(ProviderStorageRetry, (mode) => retryStorageCause(transaction, mode));

/** Retry the projection reads that precede a provider event's transaction. */
export const retryProviderStorageRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  retryStorageCause(read.pipe(Effect.sandbox), "bounded");

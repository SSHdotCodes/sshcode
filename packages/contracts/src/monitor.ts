import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MonitorStartInput = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  /** Shown in the monitor list and its notifications, shortened to 200 characters. */
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(86_400_000)),
  ),
  persistent: Schema.optional(Schema.Boolean),
  durable: Schema.optional(Schema.Boolean).annotate({
    description:
      "Keep running across server restarts; never relaunched. Returns logPath. No default timeout.",
  }),
  wakeOn: Schema.optional(
    Schema.Union([Schema.String.check(Schema.isMaxLength(2_000)), Schema.Literal(false)]),
  ).annotate({
    description:
      "Regex: matching lines plus exit; false: exit only; omitted: output (durable: exit only).",
  }),
  restartable: Schema.optional(Schema.Boolean).annotate({
    description:
      "Relaunch after a server restart, skipping lines already reported. Read-only waits only.",
  }),
  silenceMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000), Schema.isLessThanOrEqualTo(86_400_000)),
  ).annotate({
    description:
      "Also wake once if stdout and stderr stay quiet this long (a hung job); re-arms on output.",
  }),
  expectMinutes: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10_080)),
  ).annotate({ description: "Wakes once if still running well past this." }),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type MonitorStartInput = typeof MonitorStartInput.Type;

export const MonitorStopInput = Schema.Struct({ monitorId: TrimmedNonEmptyString });
export const MonitorInfo = Schema.Struct({
  monitorId: TrimmedNonEmptyString,
  state: Schema.optional(Schema.Literals(["recovering", "stopping"])),
  threadId: ThreadId,
  description: Schema.String,
  startedAt: Schema.Number,
  timeoutMs: Schema.NullOr(Schema.Number),
  persistent: Schema.Boolean,
  durable: Schema.optional(Schema.Boolean),
  logPath: Schema.optional(Schema.String),
  restartable: Schema.optional(Schema.Boolean),
  silenceMs: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Bounded recent stdout/stderr, available without waking the agent. */
  output: Schema.optional(Schema.String),
});
export type MonitorInfo = typeof MonitorInfo.Type;

export const MonitorStartResult = Schema.Struct({
  monitorId: TrimmedNonEmptyString,
  logPath: Schema.optional(Schema.String),
  wakePolicy: Schema.String,
  /** The command looks like it would never deliver a line, and why. */
  warning: Schema.optionalKey(Schema.String),
});
export const MonitorStopResult = Schema.Struct({ stopped: Schema.Boolean });
export const MonitorListResult = Schema.Struct({
  monitors: Schema.Array(MonitorInfo),
  /** Set when the list is unchanged since the caller's last check. */
  notice: Schema.optional(Schema.String),
});

export class MonitorError extends Schema.TaggedError<MonitorError>()("MonitorError", {
  reason: Schema.Literals([
    "limit",
    "not-found",
    "spawn",
    "read",
    "stop",
    "adopt",
    "storage",
    "match",
    "invalid-request",
    "invalid-options",
    "unsupported",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "limit":
        return "A thread can run at most 8 monitors at once.";
      case "not-found":
        return "This monitor does not belong to the calling thread.";
      case "spawn":
        return "Could not start the monitor command.";
      case "read":
        return "Could not read the monitor output or process state.";
      case "stop":
        return "Could not stop the monitor command.";
      case "adopt":
        return "Could not adopt the durable monitor command.";
      case "storage":
        return "Could not save the monitor state.";
      case "match":
        return "Could not match the monitor output within the time limit.";
      case "unsupported":
        return "Durable monitors require macOS or Linux.";
      case "invalid-options":
        return "Use a valid wakeOn regex or false; durable jobs cannot use restartable or silenceMs.";
      case "invalid-request":
        return "Use the same monitor command and options when retrying a clientRequestId.";
    }
  }
}

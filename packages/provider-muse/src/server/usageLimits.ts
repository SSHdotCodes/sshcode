/** Subscription allowance from `muse usage --json`: the five-hour window and the weekly one. */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import type { MuseSettings } from "../settings.ts";

const Window = Schema.Struct({
  usedPercent: Schema.Finite,
  resetsAtMs: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const UsageJson = Schema.Struct({
  allowance: Schema.NullOr(
    Schema.Struct({
      tier: Schema.optional(Schema.NullOr(Schema.String)),
      window: Schema.optional(Schema.NullOr(Window)),
      weekly: Schema.optional(Schema.NullOr(Window)),
    }),
  ),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeUsageJson = Schema.decodeUnknownOption(UsageJson);

export interface MuseAccountUsage {
  /** The plan as Muse names it, e.g. "Muse Code Power Usage". */
  readonly tier?: string;
  readonly usageLimits: ServerProviderUsageLimits;
  /** Muse put no numbers on this reading: the window has not been used yet. Not one to keep. */
  readonly unused?: true;
}

/**
 * Muse sends no numbers before the first request of a five-hour window ("this can happen
 * before your first use in a new window"). That window stands at nothing used and has no end
 * yet; the week keeps its last reading until it resets, and the plan name stays.
 */
function unusedWindow(checkedAt: string, last: MuseAccountUsage | undefined): MuseAccountUsage {
  const weekly = last?.usageLimits.windows.find((candidate) => candidate.id === "weekly");
  const weekRunning =
    weekly?.resetsAt !== undefined && Date.parse(weekly.resetsAt) > Date.parse(checkedAt);
  return {
    ...(last?.tier ? { tier: last.tier } : {}),
    unused: true,
    usageLimits: makeUsageLimits({
      checkedAt,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 0,
        },
        ...(weekly && weekRunning ? [weekly] : []),
      ],
    }),
  };
}

const RememberedWeek = Schema.Struct({
  tier: Schema.optional(Schema.String),
  weekly: Schema.Struct({
    usedPercent: Schema.Finite,
    resetsAt: Schema.String,
    checkedAt: Schema.String,
  }),
});
const decodeRememberedWeek = Schema.decodeUnknownOption(RememberedWeek);

/**
 * The part of a numbered reading that a restart must not lose: the plan name and the
 * week. Muse reports nothing for an unused five-hour window, so a freshly started server
 * would otherwise show no week until Muse is used again. `key` changes only when the
 * saved part does.
 */
export function rememberMuseWeek(
  usage: MuseAccountUsage,
): { readonly key: string; readonly contents: string } | undefined {
  if (usage.unused || usage.usageLimits.unavailable) return undefined;
  const weekly = usage.usageLimits.windows.find((candidate) => candidate.id === "weekly");
  if (weekly?.resetsAt === undefined) return undefined;
  return {
    key: `${usage.tier ?? ""}|${weekly.usedPercent}|${weekly.resetsAt}`,
    contents: JSON.stringify({
      ...(usage.tier ? { tier: usage.tier } : {}),
      weekly: {
        usedPercent: weekly.usedPercent,
        resetsAt: weekly.resetsAt,
        checkedAt: usage.usageLimits.checkedAt,
      },
    }),
  };
}

/** Reads what `rememberMuseWeek` saved, as the last reading an unused window carries from. */
export function recallMuseWeek(contents: string): MuseAccountUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const decoded = decodeRememberedWeek(parsed);
  if (Option.isNone(decoded)) return undefined;
  const { tier, weekly } = decoded.value;
  return {
    ...(tier ? { tier } : {}),
    usageLimits: makeUsageLimits({
      checkedAt: weekly.checkedAt,
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
          usedPercent: clampPercent(weekly.usedPercent),
          resetsAt: weekly.resetsAt,
        },
      ],
    }),
  };
}

function window(
  input: Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">,
  reading: typeof Window.Type,
): ServerProviderUsageWindow {
  const resetsAtMs = reading.resetsAtMs;
  const reset =
    typeof resetsAtMs === "number" && resetsAtMs > 0 ? DateTime.make(resetsAtMs) : Option.none();
  return {
    ...input,
    usedPercent: clampPercent(reading.usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
}

/**
 * Reads one `muse usage --json` object. An API key has no allowance at all; a
 * subscription that has not been used in the current window reports no numbers,
 * which reads as an unused window beside the last reading's week.
 */
export function museUsageJsonToAccount(
  stdout: string,
  checkedAt: string,
  lastReading?: MuseAccountUsage,
): MuseAccountUsage {
  const probeFailed = {
    usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return probeFailed;
  }
  const decoded = decodeUsageJson(parsed);
  if (Option.isNone(decoded)) return probeFailed;
  const { allowance, reason } = decoded.value;
  if (allowance === null) {
    if (reason === "api_key") {
      return { usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) };
    }
    return reason === "server_sent_no_usage" ? unusedWindow(checkedAt, lastReading) : probeFailed;
  }
  const windows: ServerProviderUsageWindow[] = [];
  if (allowance.window) {
    windows.push(
      window(
        { id: "session", kind: "session", label: "Session", windowDurationMins: 300 },
        allowance.window,
      ),
    );
  }
  if (allowance.weekly) {
    windows.push(
      window(
        { id: "weekly", kind: "weekly", label: "Weekly", windowDurationMins: 10_080 },
        allowance.weekly,
      ),
    );
  }
  const tier = allowance.tier?.trim();
  return {
    ...(tier ? { tier } : {}),
    usageLimits:
      windows.length > 0 ? makeUsageLimits({ checkedAt, windows }) : probeFailed.usageLimits,
  };
}

/** Asks the Muse CLI for the signed-in account's allowance; no model turn is spent. */
export const readMuseAccountUsage = Effect.fn("readMuseAccountUsage")(function* (
  settings: Pick<MuseSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  lastReading?: MuseAccountUsage,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["usage", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption("8 seconds"), Effect.result);
  if (
    Result.isFailure(result) ||
    Option.isNone(result.success) ||
    result.success.value.code !== 0
  ) {
    return {
      usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
    } satisfies MuseAccountUsage;
  }
  return museUsageJsonToAccount(result.success.value.stdout, checkedAt, lastReading);
});

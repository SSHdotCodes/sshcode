import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as WakeMatcher from "./WakeMatcher.ts";

it.live("matches JavaScript regexes off the event loop", () =>
  Effect.gen(function* () {
    const match = yield* WakeMatcher.make("^ready|done$");
    expect(yield* match(["not yet", "ready now", "all done"])).toEqual(["ready now", "all done"]);
    expect(yield* match(["still waiting"])).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("terminates catastrophic backtracking within the match deadline", () =>
  Effect.gen(function* () {
    const match = yield* WakeMatcher.make("(a+)+$");
    const failure = yield* match([`${"a".repeat(8_000)}!`]).pipe(Effect.flip);
    expect(failure.reason).toBe("match");
    // A new matcher still works after the stuck worker is terminated.
    const next = yield* WakeMatcher.make("ready");
    expect(yield* next(["ready"])).toEqual(["ready"]);
  }).pipe(Effect.scoped),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  KEEP_WARM_USAGE_LOG_MAX_BYTES,
  appendKeepWarmUsageRows,
} from "./ClaudeKeepWarmUsageLog.ts";

it.layer(NodeServices.layer)("keep-warm usage log", (it) => {
  it.effect("appends owner-only rows and drops the oldest past its size cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3-keep-warm-log-" })}/log`;
      const file = `${dir}/usage.jsonl`;
      const row = (index: number) => `{"row":${index},"pad":"${"x".repeat(1_000)}"}`;

      yield* appendKeepWarmUsageRows(fs, dir, [row(0), row(1)]);
      assert.deepEqual((yield* fs.readFileString(file)).trimEnd().split("\n"), [row(0), row(1)]);
      assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);

      // Well past the cap, one row at a time as pings arrive.
      for (let index = 2; index < 600; index++)
        yield* appendKeepWarmUsageRows(fs, dir, [row(index)]);
      const rows = (yield* fs.readFileString(file)).trimEnd().split("\n");
      assert.isAtMost(Number((yield* fs.stat(file)).size), KEEP_WARM_USAGE_LOG_MAX_BYTES + 2_000);
      // Whole rows only, the newest kept and in order.
      assert.equal(rows.at(-1), row(599));
      assert.isTrue(
        rows.every((line, at) => at === 0 || line === row(599 - (rows.length - 1 - at))),
      );
      assert.isTrue(rows[0]!.startsWith('{"row":'));
      assert.isFalse(yield* fs.exists(`${file}.partial`));
    }),
  );
});

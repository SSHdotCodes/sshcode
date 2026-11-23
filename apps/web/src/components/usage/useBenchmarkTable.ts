import {
  benchmarkFeedIsFresh,
  loadBenchmarkFeed,
  newestBenchmarkFeed,
  rememberedBenchmarkFeed,
} from "@t3tools/client-runtime/state/benchmarkFeeds";
import type { EnvironmentId } from "@t3tools/contracts";
import { applyBenchmarkFeed } from "@t3tools/shared/modelBenchmarkFeed";
import { MODEL_BENCHMARKS, type ModelBenchmarkTable } from "@t3tools/shared/modelBenchmarks";
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The benchmark table the picks read: the built-in one, with current figures
 * laid over it once a connected server has them (it reads them once a day
 * when a key is saved). Until then, and without a key, the built-in table.
 */
export function useBenchmarkTable(
  environmentIds: ReadonlyArray<EnvironmentId>,
  now: number,
): ModelBenchmarkTable {
  const read = useAtomCommand(serverEnvironment.getBenchmarkFeed, { reportFailure: false });
  const [, redraw] = useState(0);
  const key = environmentIds.join("\n");

  useEffect(() => {
    let cancelled = false;
    // The ids travel as one string: the caller builds a new array on every draw.
    for (const environmentId of key === "" ? [] : (key.split("\n") as Array<EnvironmentId>)) {
      if (benchmarkFeedIsFresh(environmentId, now)) continue;
      void loadBenchmarkFeed(
        environmentId,
        () =>
          read({ environmentId, input: {} }).then((result) =>
            result._tag === "Success" ? result.value : undefined,
          ),
        now,
      ).then((feed) => {
        if (!cancelled && feed !== undefined) redraw((count) => count + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [key, now, read]);

  const feed = newestBenchmarkFeed(environmentIds.map((id) => rememberedBenchmarkFeed(id)));
  return useMemo(() => applyBenchmarkFeed(MODEL_BENCHMARKS, feed), [feed]);
}

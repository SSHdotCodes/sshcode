import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as XSearch from "./XSearch.ts";

// Spends X API credits (up to 10 posts). Run through `sshcode secret run` so the key stays out of sight:
//   T3_X_API_LIVE=1 pnpm exec vp test run src/xPost/XSearch.live.test.ts
describe.runIf(process.env.T3_X_API_LIVE === "1")("X API search (live)", () => {
  it.effect("searches the real API with the saved key", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const posts = yield* (yield* XSearch.XSearch).search(
        process.env.T3_X_API_LIVE_QUERY ?? "from:testingcatalog since:2026-11-09",
      );
      yield* Effect.logInfo(`${(yield* Clock.currentTimeMillis) - started} ms\n${posts}`);
      expect(posts).toMatch(/^@testingcatalog .* UTC · \d+ likes/u);
      expect(posts).toMatch(/https:\/\/x\.com\/testingcatalog\/status\/\d+/u);
    }).pipe(
      Effect.provide(
        XSearch.layer.pipe(
          Layer.provide(
            Layer.mock(ApiKeyStore.ApiKeyStore)({
              shared: () => Effect.succeed(Redacted.make(process.env.X_API_BEARER_TOKEN ?? "")),
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.succeed([]),
            }),
          ),
        ),
      ),
    ),
  );
});

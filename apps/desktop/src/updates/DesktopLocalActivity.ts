import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";

const LocalActivity = Schema.Struct({ working: Schema.Number });
const REQUEST_TIMEOUT = Duration.seconds(5);

/**
 * How many chats have an agent working on this app's backends, from each
 * server's direct-local `/api/local/activity`. An update install waits for it
 * to reach zero when the user picks "when idle".
 */
export class DesktopLocalActivity extends Context.Service<
  DesktopLocalActivity,
  {
    /** The sum over backends that answered; None when none did (all stopped or too old). */
    readonly workingChats: Effect.Effect<Option.Option<number>>;
  }
>()("@t3tools/desktop/updates/DesktopLocalActivity") {}

export const layer = Layer.effect(
  DesktopLocalActivity,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const client = yield* HttpClient.HttpClient;

    const ask = (httpBaseUrl: URL) =>
      client.get(new URL("/api/local/activity", httpBaseUrl)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(LocalActivity)),
        Effect.map((body) => Option.some(body.working)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<number>()),
      );

    return DesktopLocalActivity.of({
      workingChats: Effect.gen(function* () {
        const instances = yield* pool.list;
        const counts = yield* Effect.forEach(
          instances,
          (instance) =>
            instance.currentConfig.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none<number>()),
                  onSome: (config) => ask(config.httpBaseUrl),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const answered = counts.filter(Option.isSome).map((count) => count.value);
        return answered.length === 0
          ? Option.none()
          : Option.some(answered.reduce((sum, count) => sum + count, 0));
      }),
    });
  }),
);

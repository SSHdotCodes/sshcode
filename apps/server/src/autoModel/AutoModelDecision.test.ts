import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthSettingsWriteScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import { AUTO_MODEL_DECISION_KEY_NAMES, makeAutoModelDecider } from "./AutoModelDecision.ts";
import {
  AUTO_MODEL_DECISION_MODELS,
  AUTO_MODEL_DECISION_URL,
  autoModelDecisionQuick,
  autoModelDecisionRequest,
} from "./decision.logic.ts";

const owner: AuthenticatedSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "one-time-token",
  method: "browser-session-cookie",
  scopes: [AuthSettingsWriteScope],
};
const [first, second] = AUTO_MODEL_DECISION_MODELS;
const answer = (quick: number) =>
  `{"answers":{"need":{"type":"choice","choice":"${quick >= 0.5 ? "quick" : "power"}","probabilities":{"quick":${quick},"power":${1 - quick}}}}}`;

type Call = { url: string; authorization: string | null; body: any };
const harness = (
  reply: (model: string) => Response | Promise<Response>,
  savedKeys: ReadonlyArray<string> = AUTO_MODEL_DECISION_KEY_NAMES,
) => {
  const calls: Array<Call> = [];
  const fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    return reply(body.model);
  }) as typeof globalThis.fetch;
  const keys = Layer.mock(ApiKeyStore.ApiKeyStore)({
    shared: (name) =>
      Effect.succeed(savedKeys.includes(name) ? Redacted.make(` secret-${name} `) : undefined),
  });
  const decide = makeAutoModelDecider();
  const ask = (text: string, options: { session?: AuthenticatedSession; enabled?: boolean } = {}) =>
    decide(
      options.session ?? owner,
      { text, attachmentCount: 0 },
      Effect.succeed(options.enabled ?? true),
    ).pipe(Effect.provide(keys), Effect.provideService(FetchHttpClient.Fetch, fetch));
  return { calls, ask };
};

describe("Auto decision model", () => {
  it("asks only for zero data retention, in every request", () => {
    for (const model of AUTO_MODEL_DECISION_MODELS) {
      expect(autoModelDecisionRequest(model, "anything", 0).provider).toEqual({
        zdr: true,
        data_collection: "deny",
      });
    }
  });

  it("sends at most the start of a long message", () => {
    const request = autoModelDecisionRequest(first, "x".repeat(9000), 2);
    expect(request.state.startsWith("Attachments: 2\nMessage:\n")).toBe(true);
    expect(request.state.length).toBeLessThan(2600);
  });

  it("reads the probability and refuses anything else", () => {
    expect(autoModelDecisionQuick(answer(0.82))).toBeCloseTo(0.82);
    expect(autoModelDecisionQuick('{"answers":{"need":{"choice":"power"}}}')).toBe(0.1);
    expect(autoModelDecisionQuick('{"answers":{"need":{"choice":"other"}}}')).toBeUndefined();
    expect(autoModelDecisionQuick('{"error":{"message":"No endpoints found"}}')).toBeUndefined();
    expect(autoModelDecisionQuick("not json")).toBeUndefined();
  });

  it.effect("asks the first model with the saved key and remembers the answer", () =>
    Effect.gen(function* () {
      const { calls, ask } = harness(() => new Response(answer(0.03)));
      const decision = yield* ask("  build a black hole simulation  ");
      expect(decision).toEqual({ quick: 0.03, model: first });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(AUTO_MODEL_DECISION_URL);
      expect(calls[0]!.authorization).toBe("Bearer secret-OPENROUTER_API_KEY");
      expect(calls[0]!.body.provider).toEqual({ zdr: true, data_collection: "deny" });
      expect(calls[0]!.body.state).toBe("Attachments: 0\nMessage:\nbuild a black hole simulation");
      // The same draft is not sent twice.
      expect(yield* ask("build a black hole simulation")).toEqual(decision);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("moves to the next model when one fails, and lets the failed one rest", () =>
    Effect.gen(function* () {
      const { calls, ask } = harness((model) =>
        model === first
          ? new Response('{"error":{"message":"No endpoints found matching your data policy"}}', {
              status: 404,
            })
          : new Response(answer(0.95)),
      );
      expect(yield* ask("what time is it in tokyo")).toEqual({ quick: 0.95, model: second });
      expect(calls.map((call) => call.body.model)).toEqual([first, second]);
      // Still zero retention on the fallback: a refusal is never retried with less.
      expect(calls.every((call) => call.body.provider.zdr === true)).toBe(true);
      yield* ask("rename foo to itemCount in utils.ts");
      expect(calls.map((call) => call.body.model)).toEqual([first, second, second]);
    }),
  );

  it.effect("answers null when no model answers", () =>
    Effect.gen(function* () {
      const { calls, ask } = harness(() => new Response("busy", { status: 503 }));
      expect(yield* ask("what time is it in tokyo")).toBeNull();
      expect(calls).toHaveLength(2);
      // Both rest now, so the next draft costs no request at all.
      expect(yield* ask("rename foo to itemCount in utils.ts")).toBeNull();
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect("sends nothing when switched off, without a key, or for a few characters", () =>
    Effect.gen(function* () {
      const off = harness(() => new Response(answer(0.5)));
      expect(yield* off.ask("what time is it in tokyo", { enabled: false })).toBeNull();
      expect(yield* off.ask("hi there")).toBeNull();
      expect(off.calls).toHaveLength(0);
      const noKey = harness(() => new Response(answer(0.5)), []);
      expect(yield* noKey.ask("what time is it in tokyo")).toBeNull();
      expect(noKey.calls).toHaveLength(0);
    }),
  );

  it.effect("refuses guests and agents before reading anything", () =>
    Effect.gen(function* () {
      const { calls, ask } = harness(() => new Response(answer(0.5)));
      for (const session of [
        { ...owner, subject: "guest:share" },
        { ...owner, subject: "mcp-client" },
        { ...owner, scopes: [] },
      ]) {
        const denied = yield* ask("what time is it in tokyo", { session }).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }
      expect(calls).toHaveLength(0);
    }),
  );
});

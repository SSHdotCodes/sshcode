/**
 * AutoModelDecision — asks an outside decision model whether a new chat's first
 * message is a simple task, for the Auto model suggestion.
 *
 * The message goes to OpenRouter with zero data retention demanded on every request,
 * only for an owner session, only while the setting is on and an OpenRouter key is
 * saved for all sessions. Nothing is written to disk or logged; answers are kept in
 * memory so the same draft is asked once. Null means "no answer": the caller then
 * uses the model on the user's machine alone.
 *
 * @module autoModel/AutoModelDecision
 */
import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  type AutoModelDecision,
  type AutoModelDecisionInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import {
  AUTO_MODEL_DECISION_MODELS,
  AUTO_MODEL_DECISION_TEXT_LIMIT,
  AUTO_MODEL_DECISION_URL,
  autoModelDecisionBody,
  autoModelDecisionQuick,
} from "./decision.logic.ts";
import { canRecordAutoModelFeedback } from "./feedback.logic.ts";

/** Saved for all sessions; the first one present is used. */
export const AUTO_MODEL_DECISION_KEY_NAMES = ["OPENROUTER_API_KEY"];
/** The suggestion appears after a typing pause, so a slow answer is no answer. */
const MODEL_TIMEOUT = "1200 millis";
const REST_AFTER_FAILURE_MS = 120_000;
const REMEMBERED_ANSWERS = 200;

export function makeAutoModelDecider() {
  const answers = new Map<string, AutoModelDecision>();
  const restingUntil = new Map<string, number>();

  return (
    session: AuthenticatedSession,
    input: AutoModelDecisionInput,
    enabled: Effect.Effect<boolean>,
  ): Effect.Effect<
    AutoModelDecision | null,
    EnvironmentAuthorizationError,
    ApiKeyStore.ApiKeyStore
  > =>
    Effect.gen(function* () {
      // The same owners whose choices train Auto: a guest link never spends the key.
      if (!canRecordAutoModelFeedback(session)) {
        return yield* new EnvironmentAuthorizationError({
          message: "Only an owner session may ask the Auto decision model.",
          ...authScopeRequiredResponse(AuthSettingsWriteScope),
        });
      }
      const text = input.text.trim().slice(0, AUTO_MODEL_DECISION_TEXT_LIMIT);
      if (text.length < 12 && input.attachmentCount === 0) return null;
      if (!(yield* enabled)) return null;
      const answerKey = `${input.attachmentCount}\0${text}`;
      const known = answers.get(answerKey);
      if (known !== undefined) return known;

      const keys = yield* ApiKeyStore.ApiKeyStore;
      let key: Redacted.Redacted<string> | undefined;
      for (const name of AUTO_MODEL_DECISION_KEY_NAMES) {
        key = yield* keys.shared(name).pipe(Effect.orElseSucceed(() => undefined));
        if (key !== undefined) break;
      }
      if (key === undefined) return null;
      const token = Redacted.value(key).trim();
      const fetch = yield* FetchHttpClient.Fetch;

      for (const model of AUTO_MODEL_DECISION_MODELS) {
        const now = yield* Clock.currentTimeMillis;
        if ((restingUntil.get(model) ?? 0) > now) continue;
        const quick = yield* Effect.tryPromise(async (signal) => {
          const response = await fetch(AUTO_MODEL_DECISION_URL, {
            method: "POST",
            signal,
            redirect: "error",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: autoModelDecisionBody(model, text, input.attachmentCount),
          });
          return response.status === 200
            ? autoModelDecisionQuick(await response.text())
            : undefined;
        }).pipe(
          Effect.timeoutOption(MODEL_TIMEOUT),
          Effect.option,
          Effect.map((reply) => Option.getOrUndefined(Option.flatten(reply))),
        );
        if (quick === undefined) {
          restingUntil.set(model, now + REST_AFTER_FAILURE_MS);
          continue;
        }
        const decision: AutoModelDecision = { quick, model };
        if (answers.size >= REMEMBERED_ANSWERS) {
          const oldest = answers.keys().next();
          if (!oldest.done) answers.delete(oldest.value);
        }
        answers.set(answerKey, decision);
        return decision;
      }
      return null;
    });
}

export const decideAutoModelTask = makeAutoModelDecider();

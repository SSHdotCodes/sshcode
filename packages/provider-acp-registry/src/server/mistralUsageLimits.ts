import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { MISTRAL_USAGE_URL } from "@t3tools/shared/usageLimits";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const number = Schema.Union([Schema.Number, Schema.NumberFromString]).check(Schema.isFinite());
const Budget = Schema.Struct({
  usage_percentage: number,
  reset_at: Schema.DateTimeUtcFromString,
  initial_budget: number.check(Schema.isGreaterThanOrEqualTo(0)),
  currency: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u))),
});
const decodeBudgets = Schema.decodeUnknownEffect(
  Schema.Struct({ vibe_budget: Budget, api_budget: Budget }),
);
const decodeSubscription = Schema.decodeUnknownEffect(
  Schema.Struct({ payg_enabled: Schema.Boolean, vibe_payg_enabled: Schema.Boolean }),
);

const externalUsage = { label: "Mistral Subscription", url: MISTRAL_USAGE_URL };

export const makeMistralUsageLimitsProbe = Effect.fnUntraced(function* (
  apiKey: string | undefined,
) {
  const token = apiKey?.trim();
  if (!token) {
    return DateTime.now.pipe(
      Effect.map((now): ServerProviderUsageLimits => ({
        ...makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(now),
          reason: "unsupported",
          message: "A Mistral API key is needed to report limits.",
        }),
        requiredApiKey: "MISTRAL_API_KEY",
        externalUsage,
      })),
    );
  }

  const crypto = yield* Crypto.Crypto;
  const credentialFingerprint = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`mistral-billing:${token}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const key = Redacted.make(token);
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const read = (endpoint: "budget" | "subscription") =>
    client
      .execute(
        HttpClientRequest.get(`https://api.mistral.ai/v1/billing/${endpoint}`).pipe(
          HttpClientRequest.bearerToken(key),
        ),
      )
      .pipe(Effect.flatMap((response) => response.json));

  return Effect.all(
    {
      budgets: read("budget").pipe(Effect.flatMap(decodeBudgets)),
      subscription: read("subscription").pipe(Effect.flatMap(decodeSubscription)),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.result,
    Effect.flatMap((result) =>
      DateTime.now.pipe(
        Effect.map((now): ServerProviderUsageLimits => {
          const checkedAt = DateTime.formatIso(now);
          const metadata = { credentialFingerprint, externalUsage };
          if (result._tag === "Failure") {
            return {
              ...metadata,
              ...makeUnavailableUsageLimits({
                checkedAt,
                reason: "probeFailed",
                message: "Mistral could not report usage limits.",
              }),
            };
          }
          const { budgets, subscription } = result.success;
          return {
            ...metadata,
            checkedAt,
            windows: [
              window("vibe", "Vibe & Studio", budgets.vibe_budget, subscription.vibe_payg_enabled),
              {
                ...window("api", "API", budgets.api_budget, subscription.payg_enabled),
                // Normal Vibe chats spend the Vibe & Studio allowance.
                informational: true,
              },
            ],
          };
        }),
      ),
    ),
  );
});

function window(
  id: string,
  label: string,
  budget: typeof Budget.Type,
  payAsYouGo: boolean,
): ServerProviderUsageWindow {
  return {
    id,
    kind: "monthly",
    label,
    usedPercent: clampPercent(budget.usage_percentage),
    limited: budget.usage_percentage >= 100,
    resetsAt: DateTime.formatIso(budget.reset_at),
    ...(budget.currency === null
      ? {}
      : { includedBudget: { amount: budget.initial_budget, currency: budget.currency } }),
    payAsYouGo,
    ...(payAsYouGo ? { informational: true } : {}),
  };
}

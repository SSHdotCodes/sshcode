import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as AcpErrors from "effect-acp/errors";
import { makeGrokAcpAdapterFlavor } from "./adapter.ts";
import { XAiPromptFailureText, xAiRateLimitedErrorCode } from "./xaiAcpExtension.ts";

const flavor = makeGrokAcpAdapterFlavor(
  {
    makeRuntime: () => Effect.never,
  } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
  "/fixture",
);

it.each([
  ["429 Resource exhausted. Please try again later.", "usage_limit"],
  ["You have exhausted your credits", "billing_error"],
  ["Your spending limit has been reached", "billing_error"],
  ["You have exceeded your budget", "billing_error"],
  ["This model is not included in your plan", "subscription_error"],
  ["Authentication required. Please sign in again.", "authentication_error"],
  ["Permission denied", "permission_error"],
  ["Selected model is at capacity. Please try a different model.", "provider_error"],
] as const)("classifies Grok agentResult: %s", (message, kind) => {
  const failure = flavor.promptFailure?.(
    new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Grok ended the turn with an error.",
      cause: new XAiPromptFailureText(message),
    }),
  );
  expect(failure?.class).toBe(kind);
  expect(failure?.message).toBe(message);
});

it("keeps Grok's native rate limit distinct from budget exhaustion", () => {
  expect(
    flavor.promptFailure?.(
      new AcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Resource exhausted. Please try again later.",
      }),
    ).class,
  ).toBe("usage_limit");
});

it("treats an overloaded numeric 429 as a usage limit", () => {
  expect(
    flavor.promptFailure?.(
      new AcpErrors.AcpRequestError({
        code: 429,
        errorMessage: "The model is overloaded. Please try again later.",
      }),
    ).class,
  ).toBe("usage_limit");
});

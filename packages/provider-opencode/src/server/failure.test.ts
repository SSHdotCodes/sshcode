import { expect, it } from "vite-plus/test";
import { classifyProviderFailure } from "@t3tools/provider-core/server/failure";
import { openCodeProviderFailure } from "./failure.ts";

it.each([
  ["APIError", "Insufficient credits", "billing_error"],
  ["APIError", "Your credit balance is too low to access the Anthropic API.", "billing_error"],
  ["APIError", "Your subscription does not include this model", "subscription_error"],
  ["ProviderAuthError", "Missing provider credentials", "authentication_error"],
  ["APIError", "Permission denied", "permission_error"],
  ["rate_limit_error", "Too many requests", "usage_limit"],
  ["provider.rate-limit", "Resource exhausted. Please try again later.", "usage_limit"],
  ["provider.go-limit", "OpenCode Go 5 hour usage limit reached", "usage_limit"],
  ["provider.go-limit", "OpenCode Go weekly usage limit reached", "usage_limit"],
  ["provider.quota", "This request requires more credits, or fewer max_tokens", "usage_limit"],
  ["APIError", "This request requires more credits, or fewer max_tokens", "usage_limit"],
  ["provider", "Service overloaded", "provider_error"],
] as const)("classifies OpenCode %s / %s", (code, message, kind) => {
  expect(openCodeProviderFailure({ code, message }).class).toBe(kind);
});

it("preserves nested API details and redaction on a 429", () => {
  const failure = openCodeProviderFailure({
    code: "APIError",
    message: "Request failed",
    statusCode: 429,
    retryable: true,
    responseBody: JSON.stringify({
      error: { code: "insufficient_quota", message: "Credits exhausted. api_key=secret" },
    }),
  });
  expect(failure.class).toBe("usage_limit");
  expect(failure.retryable).toBe(false);
  expect(failure.message).not.toContain("secret");
});

const vertex429Documentation =
  "https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429";
const vertexCapacityMessage = `Resource exhausted. Please try again later. Please refer to ${vertex429Documentation} for more details.`;

it.each([
  {
    code: "APIError",
    message: "Provider request failed",
    statusCode: 429,
    retryable: true,
    responseBody: JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: vertexCapacityMessage },
    }),
  },
  {
    code: "provider.rate-limit",
    message: `Provider request failed with HTTP 429: ${JSON.stringify([
      { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: vertexCapacityMessage } },
    ])}`,
  },
  { code: "provider.rate-limit", message: vertexCapacityMessage },
])("reports a Vertex shared-capacity 429 as transient provider congestion", (input) => {
  const failure = openCodeProviderFailure(input);
  expect(failure).toMatchObject({
    class: "provider_error",
    message: "Vertex AI is temporarily out of capacity. Try again later.",
    retryable: false,
  });
  // Provider health reclassifies the failure before recording an account limit.
  expect(classifyProviderFailure(failure.message, failure.code)).toBe("provider_error");
});

it("keeps a Vertex quota refusal classified as a usage limit", () => {
  const failure = openCodeProviderFailure({
    code: "provider.rate-limit",
    message: `Quota exceeded for this model. Details: ${vertex429Documentation}`,
  });
  expect(failure.class).toBe("usage_limit");
});

it.each([401, 402, 403, 429] as const)(
  "classifies OpenCode HTTP %s without usable text",
  (statusCode) => {
    const expected = {
      401: "authentication_error",
      402: "billing_error",
      403: "permission_error",
      429: "usage_limit",
    };
    expect(
      openCodeProviderFailure({ message: "Request failed", statusCode, responseBody: "not json" })
        .class,
    ).toBe(expected[statusCode]);
  },
);

import { expect, it } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";
import { acpPromptFailure, acpRequestErrorMessage } from "./failure.ts";

it.each([
  ["Authentication required", "authentication_error"],
  [
    "Authentication required: 403 Your current subscription does not have access to Kimi Code right now.",
    "subscription_error",
  ],
  ["Insufficient credits", "billing_error"],
  ["Permission denied", "permission_error"],
] as const)("classifies a structured ACP refusal: %s", (message, kind) => {
  expect(
    acpPromptFailure(new AcpErrors.AcpRequestError({ code: -32000, errorMessage: message })).class,
  ).toBe(kind);
});

it("does not expose ordinary process defects", () => {
  expect(acpPromptFailure(new Error("secret")).message).toBe("Provider turn failed.");
});

const requestError = (errorMessage: string, data?: unknown, code = -32603) =>
  new AcpErrors.AcpRequestError({ code, errorMessage, ...(data === undefined ? {} : { data }) });

it("shows what the agent said behind a bare Internal error", () => {
  // Qwen Code lets the API error escape; the ACP SDK wraps it like this.
  const failure = acpPromptFailure(
    requestError("Internal error", { details: "409 Token quota is exhausted" }),
  );
  expect(failure.message).toBe("409 Token quota is exhausted");
  expect(failure.class).toBe("usage_limit");
  expect(failure.code).toBe("-32603");
});

it("keeps the HTTP 429 in a parsed API body when ACP reports Internal error", () => {
  const failure = acpPromptFailure(
    requestError("Internal error", {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource exhausted. Please try again later.",
      },
    }),
  );
  expect(failure).toMatchObject({ class: "usage_limit", code: "-32603", retryable: false });
});

it("reads an API error body the SDK parsed into the error data", () => {
  const failure = acpPromptFailure(
    requestError("Internal error", { error: { message: "Insufficient credits", type: "billing" } }),
  );
  expect(failure.message).toBe("Insufficient credits");
  expect(failure.class).toBe("billing_error");
});

it.each([
  ["Invalid params", { details: "model is required" }, "Invalid params: model is required"],
  ["Rate limit exceeded", "Try again in 20s", "Rate limit exceeded: Try again in 20s"],
  ["Internal error", { message: " upstream\n  timed out " }, "upstream timed out"],
  ["Internal error", { error: "socket hang up" }, "socket hang up"],
  [
    "409 Token quota is exhausted",
    { details: "409 Token quota is exhausted" },
    "409 Token quota is exhausted",
  ],
  ["Internal error", { details: "" }, "Internal error"],
  ["Internal error", { details: { nested: true } }, "Internal error"],
  // Errors this app raises itself carry structured data, not an explanation.
  [
    "Invalid value",
    { configId: "model", allowedValues: ["a"], receivedValue: "b" },
    "Invalid value",
  ],
  ["Internal error", undefined, "Internal error"],
] as const)("describes %s with data %j", (errorMessage, data, expected) => {
  expect(acpRequestErrorMessage(requestError(errorMessage, data))).toBe(expected);
});

it("redacts and bounds the agent's explanation", () => {
  const leaked = acpPromptFailure(
    requestError("Internal error", {
      details: "401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz012345",
    }),
  );
  expect(leaked.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  expect(leaked.class).toBe("authentication_error");
  expect(
    acpRequestErrorMessage(requestError("Internal error", { details: "x".repeat(5_000) })),
  ).toHaveLength(600);
});

it("classifies transport loss as retryable instead of a terminal provider error", () => {
  expect(
    acpPromptFailure(
      new AcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/prompt",
        cause: new Error("process exited"),
      }),
    ),
  ).toMatchObject({ class: "transport_error", retryable: true });
});

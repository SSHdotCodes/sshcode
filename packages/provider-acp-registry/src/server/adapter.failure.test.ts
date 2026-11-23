import { describe, expect, it } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";
import { acpRegistryPromptFailure } from "./adapter.ts";

describe("ACP account failures", () => {
  it.each([
    ["mistral-vibe", -32603, "HTTP 402: Vibe budget exhausted", "usage_limit"],
    ["mistral-vibe", -32603, "Error response 402: Payment Required", "billing_error"],
    [
      "mistral-vibe",
      -31001,
      "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
      "usage_limit",
    ],
    ["mistral-vibe", -32603, "Your monthly spending limit has been reached", "billing_error"],
    ["kimi", -32603, "Insufficient balance. Please recharge your account.", "billing_error"],
    [
      "kimi",
      -32603,
      "The model is not available for your current subscription",
      "subscription_error",
    ],
    ["kimi", -32603, "Your subscription does not include this model", "subscription_error"],
    ["kimi", -32000, "Login needed", "authentication_error"],
    [
      "kimi",
      -32000,
      "Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code/",
      "subscription_error",
    ],
    ["kimi", -32603, "Not logged in. Please login first.", "authentication_error"],
    ["any-agent", -32603, "Permission denied", "permission_error"],
    ["any-agent", -32603, "Internal error", "provider_error"],
  ] as const)("%s maps %s / %s", (agent, code, errorMessage, kind) => {
    const failure = acpRegistryPromptFailure(
      agent,
      new AcpErrors.AcpRequestError({ code, errorMessage }),
    );
    expect(failure.class).toBe(kind);
    expect(failure.message).toBe(errorMessage);
    expect(failure.code).toBe(String(code));
    if (kind !== "usage_limit" && kind !== "provider_error") expect(failure.retryable).toBe(false);
  });

  it("keeps the plan reset time Qwen Code reports for account balancing", () => {
    const failure = acpRegistryPromptFailure(
      "qwen-code",
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: {
          details:
            "Quota exhausted: Your token-plan 1-month quota has been exhausted. The quota will reset at 2026-12-01T08:00:00+08:00.",
        },
      }),
    );
    expect(failure.class).toBe("usage_limit");
    expect(failure.resetAt).toBe("2026-12-01T00:00:00.000Z");
    expect(failure.retryable).toBe(false);
  });

  it("shows Qwen Code's API error instead of the bare Internal error", () => {
    const failure = acpRegistryPromptFailure(
      "qwen-code",
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "409 Token quota is exhausted" },
      }),
    );
    expect(failure.message).toBe("409 Token quota is exhausted");
    expect(failure.class).toBe("usage_limit");
  });
});

import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderFailure,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  affectedCredentialInstances,
  isRejectedApiCredential,
  openCodeCredentialStore,
  resolveCredentialTarget,
} from "./credentialResolution.ts";

const instanceId = ProviderInstanceId.make("opencode");
const run = {
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "opencode/inkling-2-small-free" },
};
const instance: ProviderInstanceConfig = { driver: ProviderDriverKind.make("opencode") };
const settings = (entry: ProviderInstanceConfig = instance): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [instanceId]: entry },
});
const failure = (message: string, code: string | null = null): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message,
  code,
  retryable: false,
});

describe("rejected API credentials", () => {
  it.each([
    "Provider error: This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.",
    "Invalid API key",
    "API key revoked",
    "Incorrect API key provided",
    "authentication failed",
    "HTTP 401: Unauthorized",
    "403 Forbidden",
    "Your API key is invalid",
  ])("recognizes %s", (message) => expect(isRejectedApiCredential(failure(message))).toBe(true));
  it("recognizes a structured auth status", () =>
    expect(isRejectedApiCredential(failure("Request failed", "api_error_401"))).toBe(true));
  it.each([
    "Quota exceeded",
    "API key rate limit exceeded",
    "401: insufficient credits",
    "403: credit balance too low",
    "401 Insufficient balance",
    "403 Spending limit reached",
    "403: rate_limit",
    "Too many requests (429)",
    "API key has no remaining quota",
    "Billing account expired",
    "Payment required",
    "Model not found",
    "Tool permission denied",
    "Forbidden: this model is unavailable",
  ])("does not prompt for %s", (message) =>
    expect(isRejectedApiCredential(failure(message))).toBe(false),
  );
  it("ignores tool and usage categories even with auth-like text", () => {
    expect(isRejectedApiCredential({ ...failure("401 Unauthorized"), class: "usage_limit" })).toBe(
      false,
    );
    expect(
      isRejectedApiCredential({ ...failure("Invalid API key"), class: "validation_error" }),
    ).toBe(false);
  });
});

describe("credential resolution", () => {
  it("links to the shared key instead of a variable value", () => {
    const current = {
      ...settings({
        ...instance,
        environment: [{ name: "OPENCODE_API_KEY", value: "", sensitive: true, sharedKey: "zen" }],
      }),
      sharedKeys: { zen: { label: "Zen key", value: "test-only" } },
    };
    expect(resolveCredentialTarget(current, run)).toMatchObject({
      target: { kind: "shared", sharedKeyId: "zen" },
      label: "Zen key",
    });
  });
  it("resolves a shared key linked through a custom variable name", () => {
    const current = {
      ...settings({
        ...instance,
        environment: [{ name: "SSHCODE_ZEN_KEY", value: "", sensitive: true, sharedKey: "zen" }],
      }),
      sharedKeys: { zen: { label: "Zen key", value: "test-only" } },
    };
    expect(resolveCredentialTarget(current, run)).toMatchObject({
      target: { kind: "shared", sharedKeyId: "zen" },
    });
  });
  it("recognizes Anthropic's API-key token alias", () => {
    const current = settings({
      driver: ProviderDriverKind.make("claudeAgent"),
      environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "synthetic-key", sensitive: true }],
    });
    expect(resolveCredentialTarget(current, run)).toMatchObject({
      target: { kind: "variable", variableName: "ANTHROPIC_AUTH_TOKEN" },
    });
  });
  it("selects the model's key when several providers are configured", () => {
    const current = settings({
      ...instance,
      environment: [
        { name: "OPENROUTER_API_KEY", value: "router-test", sensitive: true },
        { name: "OPENCODE_API_KEY", value: "zen-test", sensitive: true },
      ],
    });
    expect(resolveCredentialTarget(current, run)).toMatchObject({
      target: { kind: "variable", variableName: "OPENCODE_API_KEY", previousValue: "zen-test" },
    });
  });
  it("uses OpenCode's own provider id and store with no key variable", () => {
    expect(resolveCredentialTarget(settings(), run)).toMatchObject({
      target: { kind: "opencode", providerId: "opencode" },
      label: "OpenCode Zen API key",
    });
    expect(
      resolveCredentialTarget(settings(), {
        ...run,
        modelSelection: { instanceId, model: "openrouter/openai/gpt-test" },
      }),
    ).toMatchObject({
      target: { providerId: "openrouter" },
      consoleUrl: "https://openrouter.ai/keys",
    });
  });
  it("does not guess a login credential or ambiguous variables", () => {
    expect(
      resolveCredentialTarget(settings({ driver: ProviderDriverKind.make("codex") }), run),
    ).toBeUndefined();
    expect(
      resolveCredentialTarget(settings({ driver: ProviderDriverKind.make("claudeAgent") }), run),
    ).toBeUndefined();
    expect(
      resolveCredentialTarget(settings(), {
        ...run,
        modelSelection: { instanceId, model: "no-prefix" },
      }),
    ).toBeUndefined();
    expect(
      resolveCredentialTarget(
        settings({
          driver: ProviderDriverKind.make("acpRegistry"),
          environment: [
            { name: "OPENAI_API_KEY", value: "test", sensitive: true },
            { name: "OTHER_API_KEY", value: "other-test", sensitive: true },
          ],
        }),
        run,
      ),
    ).toBeUndefined();
  });
  it("finds matching sensitive key aliases across drivers but ignores unrelated values", () => {
    const current = {
      ...settings({
        ...instance,
        environment: [{ name: "OPENCODE_API_KEY", value: "same-test", sensitive: true }],
      }),
      providerInstances: {
        first: {
          ...instance,
          environment: [{ name: "OPENCODE_API_KEY", value: "same-test", sensitive: true }],
        },
        second: {
          driver: ProviderDriverKind.make("acpRegistry"),
          environment: [{ name: "OPENAI_API_KEY", value: "same-test", sensitive: true }],
        },
        unrelated: {
          ...instance,
          environment: [{ name: "DISPLAY_NAME", value: "same-test", sensitive: true }],
        },
      },
    } as ServerSettings;
    expect(
      affectedCredentialInstances(current, {
        kind: "variable",
        instanceId,
        variableName: "OPENCODE_API_KEY",
        previousValue: "same-test",
      }),
    ).toEqual(["first", "second"]);
  });
  it("separates remote servers and alternate homes", () => {
    expect(openCodeCredentialStore(instance)).not.toBe(
      openCodeCredentialStore({
        ...instance,
        environment: [{ name: "HOME", value: "/tmp/isolated", sensitive: false }],
      }),
    );
    expect(openCodeCredentialStore(instance)).not.toBe(
      openCodeCredentialStore({ ...instance, config: { serverUrl: "http://127.0.0.1:4096" } }),
    );
  });
});

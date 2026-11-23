import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderFailureClass,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  knownProviderFailureMessage,
  isModelGoneFailure,
  isProviderBusyMessage,
  makeProviderFailure,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  ContextHandoffBudgetError,
  providerFailureRootCause,
} from "./failure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

it.each([
  ["insufficient_quota", "Quota exhausted", "usage_limit"],
  ["InternalError", "Insufficient token quota", "usage_limit"],
  ["InternalError", "Your account has exhausted its monthly token quota", "usage_limit"],
  ["sessionBudgetExceeded", "Resource exhausted. Please try again later.", "usage_limit"],
  ["400", "Your credit balance is too low to access the Anthropic API.", "billing_error"],
  ["402", "Payment Required", "billing_error"],
  ["403", "This model is not supported with your current subscription.", "subscription_error"],
  ["401", "Unauthorized", "authentication_error"],
  ["invalid_api_key", "Invalid API key", "authentication_error"],
  ["auth_required", "Not authenticated. Please login.", "authentication_error"],
  ["provider", "You are logged out", "authentication_error"],
  // Claude Code's text when its login is gone; its result carries no status code.
  [
    "api_error",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "authentication_error",
  ],
  ["api_error", "Claude could not authenticate. Run `claude auth login`.", "authentication_error"],
  ["provider", "The OAuth token has been revoked", "authentication_error"],
  ["provider", "The model list could not be refreshed", "provider_error"],
  ["403", "Permission denied", "permission_error"],
  ["429", "Too many requests", "usage_limit"],
  ["serverOverloaded", "Selected model is at capacity.", "provider_error"],
  ["provider", "This model is not available due to rate limit on your account", "usage_limit"],
  ["APIError", "Request failed with status code 401", "authentication_error"],
  ["insufficient_user_balance", "Balance unavailable", "billing_error"],
  ["credit_balance_too_low", "Request rejected", "billing_error"],
  ["provider", "You exceeded your current quota", "usage_limit"],
  // A numeric 429 takes precedence over capacity wording.
  [
    "provider.rate-limit",
    'Provider request failed with HTTP 429: [{ "error": { "code": 429, "message": "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.", "status": "RESOURCE_EXHAUSTED" } }]',
    "usage_limit",
  ],
  ["429", "The model is overloaded. Please try again later.", "usage_limit"],
  // HTTP 429 always blocks automatic retry.
  ["api_error_429", "Authentication required", "usage_limit"],
  ["api_error_429", "Insufficient credits", "usage_limit"],
  ["429", "Rate limit reached for requests per minute. Please try again later.", "usage_limit"],
  ["429", "You've hit your usage limit. Try again later.", "usage_limit"],
  ["429", "Quota exceeded for quota metric 'Requests' per day. Try again later.", "usage_limit"],
] as const)("classifies API %s: %s", (code, message, expected) => {
  const failure = makeProviderFailure({ class: "provider_error", code, message, retryable: true });
  assert.equal(failure.class, expected);
  assert.equal(failure.retryable, expected === "provider_error");
});

it.each([
  ["reset at 2026-11-19 15:00 UTC", "2026-11-19T15:00:00.000Z"],
  ["resets at 2026-11-19 15:00:00 UTC", "2026-11-19T15:00:00.000Z"],
  ["resets at 2026-11-19T15:00:00.12345 UTC", "2026-11-19T15:00:00.123Z"],
  ["resets at 2026-11-19T15:00Z", "2026-11-19T15:00:00.000Z"],
  ["resets at 2026-11-19 15:00:30+0530", "2026-11-19T09:30:30.000Z"],
  ["resets at 2026-11-19T15:00:30.5-05:30", "2026-11-19T20:30:30.500Z"],
  ["resets at 2026-19-19T15:00Z", undefined],
  ["resets at 2026-11-19 15:00", undefined],
] as const)("settles a quota refusal that %s", (description, expected) => {
  const failure = makeProviderFailure({ class: "usage_limit", message: description });
  assert.equal(failure.resetAt, expected);
});

it("retains a Codex RPC 429 inside a turn-start error", () => {
  const cause = {
    _tag: "ProviderAdapterTurnStartError",
    cause: {
      _tag: "CodexAppServerRequestError",
      operation: "receive-response",
      code: 429,
      message: "Resource exhausted. Please try again later.",
    },
  };
  assert.equal(makeProviderFailure({ cause, class: "provider_error" }).class, "usage_limit");
});

it("keeps local failures out of account classification", () => {
  for (const message of [
    "Tool permission denied by user",
    "EACCES: permission denied, open /workspace/file",
    "Sandbox access denied",
    "Disk quota exceeded",
  ]) {
    assert.equal(makeProviderFailure({ class: "provider_error", message }).class, "provider_error");
  }
  for (const kind of ["validation_error", "transport_error"] as const) {
    assert.equal(makeProviderFailure({ class: kind, message: "Permission denied" }).class, kind);
  }
  assert.equal(
    makeProviderFailure({ class: "provider_error", message: "Context window exceeded" }).class,
    "provider_error",
  );
  assert.equal(
    makeProviderFailure({ class: "provider_error", message: "Invalid JSON at position 403" }).class,
    "provider_error",
  );
  assert.equal(
    makeProviderFailure({
      class: "provider_error",
      message: "Claude stopped: the turn's token budget was exhausted.",
    }).class,
    "provider_error",
  );
});

it("redacts credentials and URL secrets from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      'request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop',
    code: "provider_rejected",
    class: "provider_error",
  });

  assert.equal(failure.class, "provider_error");
  assert.equal(failure.code, "provider_rejected");
  assert.include(failure.message, "[REDACTED]");
  assert.include(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "bearer-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "url-secret");
  assert.notInclude(failure.message, "json-secret");
  assert.notInclude(failure.message, "key-secret");
  assert.notInclude(failure.message, "sk-abcdefghijklmnop");
});

it("replaces unsafe control characters without stripping whitespace", () => {
  const failure = makeProviderFailure({ message: "before\u0000\u0007\t\nafter\u007f" });

  assert.equal(failure.message, "before  \t\nafter");
});

it("bounds provider-controlled failure strings", () => {
  const failure = makeProviderFailure({
    message: "m".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH + 500),
    code: "c".repeat(MAX_PROVIDER_FAILURE_CODE_LENGTH + 50),
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  assert.equal(failure.code?.length, MAX_PROVIDER_FAILURE_CODE_LENGTH);
  assert.match(failure.message, /…$/u);
  assert.match(failure.code ?? "", /…$/u);
});

it("redacts credentials whose key names end in a credential word", () => {
  const failure = makeProviderFailure({
    code: '{"refresh_token":"code value"}',
    message:
      'oauth refresh failed: client_secret=client-value refresh_token=refresh-value {"client_secret":"json-value"} clientSecret: camel-value X-Auth-Token: header-value max_tokens=4096',
  });

  assert.equal(failure.code, '{"refresh_token":"[REDACTED]"}');
  assert.equal(
    failure.message,
    'oauth refresh failed: client_secret=[REDACTED] refresh_token=[REDACTED] {"client_secret":"[REDACTED]"} clientSecret: [REDACTED] X-Auth-Token: [REDACTED] max_tokens=4096',
  );
});

it("does not split a surrogate pair at the truncation boundary", () => {
  const failure = makeProviderFailure({
    message: `${"a".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 2)}🚀tail`,
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 1);
  assert.equal(failure.message.at(-1), "…");
  assert.notMatch(failure.message.slice(0, -1), /[\uD800-\uDBFF]$/u);
});

it("does not expose arbitrary cause messages and preserves explicit messages", () => {
  const cause = new Error("Adapter failed", {
    cause: new Error("Session expired. Sign in again."),
  });
  for (const value of [
    cause,
    Cause.fail(cause),
    "Session expired. Sign in again.",
    { message: "Session expired. Sign in again." },
  ]) {
    assert.equal(makeProviderFailure({ cause: value }).message, "Provider turn failed.");
    assert.equal(
      makeProviderFailure({ cause: value, message: "Provider connection closed." }).message,
      "Provider connection closed.",
    );
  }
});

it("preserves actionable handoff errors wrapped by turn startup", () => {
  const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:handoff-error"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
    runId: RunId.make("run:handoff-error"),
    cause: new ContextHandoffBudgetError(),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    new ContextHandoffBudgetError().message,
  );
});

it("keeps a start failure's root kind and message, redacted and bounded", () => {
  const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:root-cause"),
    providerThreadId: ProviderThreadId.make("provider-thread:root-cause"),
    runId: RunId.make("run:root-cause"),
    cause: {
      _tag: "SqliteReadError",
      message: `database is locked: Authorization: Bearer abc.def api_key=sk-live-123 https://user:pass@example.test/x?token=secret ${"x".repeat(5000)}`,
    },
  });
  const rootCause = providerFailureRootCause(Cause.fail(cause));
  assert.equal(rootCause.kind, "SqliteReadError");
  const failure = makeProviderFailure({
    cause,
    message: rootCause.message,
    code: rootCause.kind,
    class: "unknown",
  });
  assert.equal(failure.code, "SqliteReadError");
  assert.match(failure.message, /^database is locked: /u);
  assert.notInclude(failure.message, "abc.def");
  assert.notInclude(failure.message, "sk-live-123");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("names a plain error by its wrapper's tag and reads string causes", () => {
  assert.deepEqual(
    providerFailureRootCause({ _tag: "StoreError", cause: new Error("disk full") }),
    { kind: "StoreError", message: "disk full" },
  );
  assert.deepEqual(providerFailureRootCause(new TypeError("x is undefined")), {
    kind: "TypeError",
    message: "x is undefined",
  });
  assert.deepEqual(
    providerFailureRootCause({ _tag: "RunMissing", cause: "Run r was not found." }),
    {
      kind: "RunMissing",
      message: "Run r was not found.",
    },
  );
});

it("does not expose defect text nested inside a known error category", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterEventStreamError",
      cause: new Error(
        `Session rejected: Bearer nested-secret https://user:pass@example.test/path?token=secret ${"x".repeat(5000)}`,
      ),
    },
  });
  assert.include(failure.message, "provider event stream closed unexpectedly");
  assert.notInclude(failure.message, "Session rejected:");
  assert.notInclude(failure.message, "nested-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.isBelow(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(makeProviderFailure({ cause: cyclic }).message, "Provider turn failed.");
  assert.equal(
    makeProviderFailure({
      cause: {
        get message() {
          throw new Error("unreadable");
        },
        get cause() {
          throw new Error("unreadable");
        },
      },
    }).message,
    "Provider turn failed.",
  );
});

it("falls back when inspecting a provider cause throws", () => {
  const cause = new Proxy(
    {},
    {
      has() {
        throw new Error("unreadable provider cause");
      },
    },
  );
  assert.equal(makeProviderFailure({ cause }).message, "Provider turn failed.");
});

it("does not serialize arbitrary provider causes", () => {
  const failure = makeProviderFailure({
    cause: {
      payload: { authorization: "Bearer nested-secret" },
      stack: "private provider stack",
    },
    class: "transport_error",
  });

  assert.deepEqual(failure, {
    class: "transport_error",
    message: "Provider turn failed.",
    code: null,
    retryable: null,
  });
});

it.effect("keys terminal failure items by provider turn across retries and fallback paths", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const driver = ProviderDriverKind.make("codex");
    const runId = RunId.make("run:provider-failure-id");
    const base = {
      idAllocator,
      driver,
      threadId: ThreadId.make("thread:provider-failure-id"),
      runId,
      nodeId: NodeId.make("node:provider-failure-id"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-failure-id"),
      itemOrdinal: 101,
      failure: makeProviderFailure({ message: "Provider failed" }),
      occurredAt: DateTime.makeUnsafe("2026-06-22T12:00:00.000Z"),
    } as const;
    const firstTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:first");
    const secondTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:second");

    const firstAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: firstTurnId,
    });
    const retriedAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: secondTurnId,
    });
    const ingestorFallback = makeProviderFailureTurnItem({
      ...base,
      runId: null,
      nodeId: null,
      providerTurnId: firstTurnId,
    });

    assert.notEqual(firstAttempt.id, retriedAttempt.id);
    assert.equal(firstAttempt.id, ingestorFallback.id);
    assert.equal(firstAttempt.ordinal, 101);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it("titles a busy provider apart from a usage limit", () => {
  const item = (message: string, code: string) =>
    makeProviderFailureTurnItem({
      driver: ProviderDriverKind.make("opencode"),
      threadId: ThreadId.make("thread:provider-busy"),
      runId: RunId.make("run:provider-busy"),
      nodeId: NodeId.make("node:provider-busy"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-busy"),
      providerTurnId: ProviderTurnId.make(`provider-turn:provider-busy:${code}`),
      itemOrdinal: 1,
      failure: makeProviderFailure({ class: "provider_error", code, message }),
      occurredAt: DateTime.makeUnsafe("2026-11-11T02:31:24.000Z"),
    });
  assert.equal(
    item("The server is busy. Please try again later.", "serverOverloaded").title,
    "Provider busy. Try again in a moment.",
  );
  assert.equal(item("Too many requests", "429").title, "Usage limit reached");
  assert.isTrue(isProviderBusyMessage("status: RESOURCE_EXHAUSTED"));
  assert.isFalse(isProviderBusyMessage("Weekly limit reached, try again later"));
});

it("names the ACP process exit and failure stage without exposing its output", () => {
  for (const [exit, status] of [
    [{ signal: "SIGILL" }, " after signal SIGILL"],
    [{ code: 134 }, " with code 134"],
    [{}, ""],
    [{ signal: "SIGILL Bearer signal-secret" }, ""],
  ] as const) {
    const failure = {
      _tag: "ProviderSessionOpenError",
      cause: {
        _tag: "ProviderAdapterOpenSessionError",
        cause: {
          _tag: "AcpProcessExitedError",
          ...exit,
          pid: 4242,
          stderr: "*** SIGILL *** token=stderr-secret",
          cause: new Error("private-detail"),
        },
      },
    };
    assert.equal(
      makeProviderFailure({ cause: Cause.fail(failure) }).message,
      `The provider session could not be opened: the provider process exited${status}. Check the server logs for the provider's output, then retry the turn.`,
    );
  }
  assert.equal(
    makeProviderFailure({ cause: { _tag: "AcpProcessExitedError", code: 1 } }).message,
    "The provider process exited with code 1. Check the server logs for the provider's output, then retry the turn.",
  );
});

it("preserves an unsupported compaction explanation through turn-start wrappers", () => {
  const cause = new ProviderAdapter.ProviderCompactionUnsupportedError({
    driver: ProviderDriverKind.make("acp-test"),
    providerThreadId: ProviderThreadId.make("compact-unsupported"),
  });
  assert.equal(
    makeProviderFailure({ cause: { _tag: "ProviderAdapterTurnStartError", cause } }).message,
    cause.message,
  );
});

it("reads a provider saying the model itself is gone, and nothing else, as a gone model", () => {
  const gone = (
    message: string,
    failureClass: OrchestrationV2ProviderFailureClass = "provider_error",
    code: string | null = null,
  ) => isModelGoneFailure({ class: failureClass, message, code });
  for (const message of [
    "Model gemini-3.1-pro has been deprecated.",
    "The model `gpt-5-codex` has been retired.",
    "model 'claude-3-opus' is no longer available",
    "The requested model kimi-k2 does not exist.",
    "Model not found: deepseek-v3.2",
    "Unknown model: glm-4.5",
    "This model has been decommissioned",
  ])
    assert.isTrue(gone(message), message);
  assert.isTrue(gone("Bad request", "validation_error", "model_not_found"));
  for (const message of [
    "Rate limit reached for model gemini-4-argon",
    "429 Too Many Requests",
    "The model is overloaded. Please try again later.",
    "Model gemini-4-argon is currently overloaded",
    "Insufficient credits to use model deepseek-v4.1-flash",
    "Invalid API key for model gpt-6.1-sol",
    "Model gpt-6.1-sol is not available on your plan",
    "The model gpt-4 does not exist or you do not have access to it.",
    "Model provider not found",
    "Model gemini-4-argon will be deprecated on 2027-01-01; it is temporarily unavailable",
  ])
    assert.isFalse(gone(message), message);
  assert.isFalse(gone("Model gemini-3.1-pro has been deprecated.", "usage_limit"));
  assert.isFalse(gone("Unknown model: glm-4.5", "authentication_error"));
});

it("tells the user to sign in only when an ACP agent answers auth_required", () => {
  const providerSessionId = ProviderSessionId.make("provider-session:private-id");
  const sessionOpenFailure = (code: number) => ({
    _tag: "ProviderSessionOpenError",
    cause: new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver: ProviderDriverKind.make("acpRegistry"),
      providerSessionId,
      cause: Cause.fail({ _tag: "AcpRequestError", code, errorMessage: "Private agent text" }),
    }),
  });

  assert.equal(
    makeProviderFailure({ cause: Cause.fail(sessionOpenFailure(-32000)) }).message,
    "The provider needs you to sign in. Sign in from its provider settings or with its own CLI or app, then retry the turn.",
  );
  assert.isUndefined(knownProviderFailureMessage(sessionOpenFailure(-32603)));
});

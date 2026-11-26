import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailureClass,
  type ServerProvider,
  type ServerProviderRecentFailure,
  activeProviderFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import {
  layer as healthLayer,
  makeModelAvailabilityTracker,
  providerHealthUpdate,
} from "./ProviderHealthReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { makeModelFailureTracker } from "../provider/modelFailures.ts";
import { modelRankingSelectionKey } from "@t3tools/shared/modelRankings";

const at = DateTime.makeUnsafe("2026-11-03T20:00:00.000Z");
const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread-health");
const runId = RunId.make("run-health");

describe("model failure streaks", () => {
  const now = DateTime.toEpochMillis(at);
  const key = modelRankingSelectionKey({ instanceId, model: "gemini-3.1-pro" });
  const busy = {
    class: "provider_error",
    message: "Resource exhausted. Please try again later.",
  } as const;
  const run = (id: string, model = "gemini-3.1-pro", instance = instanceId) => {
    const base = runUpdated("running", model);
    return {
      ...base,
      payload: {
        ...base.payload,
        id: RunId.make(id),
        providerInstanceId: instance,
        modelSelection: { instanceId: instance, model },
      },
    } as OrchestrationV2DomainEvent;
  };
  const fail = (id: string, failure: Parameters<typeof errorItem>[0] = busy) => {
    const base = errorItem(failure);
    return {
      ...base,
      runId: RunId.make(id),
      payload: { ...base.payload, runId: RunId.make(id) },
    } as OrchestrationV2DomainEvent;
  };

  it("counts failed runs once, including usage limits, only on their exact instance and model", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(run("a"));
    tracker.record(fail("a"));
    tracker.record(fail("a"));
    tracker.record(run("b"));
    tracker.record(fail("b", { class: "usage_limit", message: "Too many requests" }));
    tracker.record(run("other-model", "other"));
    tracker.record(fail("other-model"));
    tracker.record(run("other-instance", "gemini-3.1-pro", ProviderInstanceId.make("other")));
    tracker.record(fail("other-instance"));
    expect(tracker.snapshot(now).get(key)).toEqual({
      count: 2,
      at: now,
      message: "Too many requests",
    });
    expect(tracker.snapshot(now).size).toBe(3);
  });

  it("only completion on the same instance and model clears the streak", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(runUpdated("running"));
    tracker.record(errorItem(busy));
    tracker.record(runUpdated("completed", "other"));
    const peerCompletion = runUpdated("completed");
    tracker.record({
      ...peerCompletion,
      payload: { ...peerCompletion.payload, providerInstanceId: ProviderInstanceId.make("peer") },
    } as OrchestrationV2DomainEvent);
    tracker.record(runUpdated("interrupted"));
    tracker.record({
      ...errorItem(busy),
      payload: {
        ...errorItem(busy).payload,
        type: "assistant_message",
        text: "output",
        status: "completed",
      },
    } as OrchestrationV2DomainEvent);
    expect(tracker.snapshot(now).get(key)?.count).toBe(1);
    tracker.record(runUpdated("completed"));
    expect(tracker.snapshot(now).has(key)).toBe(false);
    tracker.record(run("next"));
    tracker.record(fail("next"));
    expect(tracker.snapshot(now).get(key)?.count).toBe(1);
  });

  it.each([
    ["transport_error", "Connection lost"],
    ["validation_error", "Bad request"],
    ["unknown", "Unknown"],
    ["billing_error", "Budget exhausted"],
    ["permission_error", "Forbidden"],
    ["authentication_error", "Signed out"],
    ["subscription_error", "Model not in plan"],
    ["provider_error", "Model gemini-3.1-pro has been deprecated."],
    ["provider_error", "Insufficient credits"],
    ["usage_limit", "Quota exhausted"],
  ] as const)("ignores %s: %s", (kind, message) => {
    const tracker = makeModelFailureTracker();
    tracker.record(runUpdated("running"));
    tracker.record(errorItem({ class: kind, message }));
    expect(tracker.snapshot(now).size).toBe(0);
  });

  it("ignores retrying errors and failures without a known run", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(errorItem(busy));
    tracker.record(runUpdated("running"));
    tracker.record(errorItem(busy, "running"));
    expect(tracker.snapshot(now).size).toBe(0);
  });

  it("expires 60 minutes after the last failure, also before counting another run", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(runUpdated("running"));
    tracker.record(errorItem(busy));
    expect(tracker.snapshot(now + 60 * 60_000 - 1).get(key)?.count).toBe(1);
    tracker.record(run("b"));
    tracker.record({ ...fail("b"), occurredAt: DateTime.add(at, { minutes: 59 }) });
    expect(tracker.snapshot(now + 60 * 60_000).get(key)?.count).toBe(2);
    expect(tracker.snapshot(now + 119 * 60_000).size).toBe(0);
    tracker.record(run("c"));
    tracker.record({ ...fail("c"), occurredAt: DateTime.add(at, { minutes: 120 }) });
    expect(tracker.snapshot(now + 120 * 60_000).get(key)?.count).toBe(1);
    const fresh = makeModelFailureTracker();
    fresh.record(run("a"));
    fresh.record(fail("a"));
    fresh.record(run("b"));
    fresh.record({ ...fail("b"), occurredAt: DateTime.add(at, { minutes: 60 }) });
    expect(fresh.snapshot(now + 60 * 60_000).get(key)?.count).toBe(1);
  });

  it("bounds both remembered models and runs, evicting the oldest", () => {
    const tracker = makeModelFailureTracker();
    for (let i = 0; i < 600; i++) {
      tracker.record(run(`run-${i}`, `model-${i}`));
      tracker.record(fail(`run-${i}`));
    }
    expect(tracker.snapshot(now).size).toBe(300);
    expect(
      tracker.snapshot(now).has(modelRankingSelectionKey({ instanceId, model: "model-0" })),
    ).toBe(false);
    expect(
      tracker.snapshot(now).get(modelRankingSelectionKey({ instanceId, model: "model-599" }))
        ?.count,
    ).toBe(1);
    const fresh = makeModelFailureTracker();
    for (let i = 0; i < 600; i++) fresh.record(run(`run-${i}`));
    fresh.record(fail("run-0"));
    expect(fresh.snapshot(now).size).toBe(0);
  });

  it("keeps the provider's short message and HTTP status, without JSON, URLs, credentials or request ids", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(runUpdated("running"));
    tracker.record(
      errorItem({
        class: "provider_error",
        message:
          'Provider request failed with HTTP 429: [{ "error": { "code": 429, "message": "Resource exhausted. Please try again later. Please refer to https://example.com/?key=private for more details. request_id=req-private", "details": [{"api_key":"private"}] } }]',
      }),
    );
    expect(tracker.snapshot(now).get(key)?.message).toBe(
      "HTTP 429 Resource exhausted. Please try again later.",
    );
    tracker.record(run("b"));
    tracker.record(
      fail("b", {
        ...busy,
        message:
          "Failed\nAuthorization: Bearer private-token; password=private-password request-id: private-id " +
          "x".repeat(150),
      }),
    );
    const message = tracker.snapshot(now).get(key)!.message;
    expect(message.length).toBeLessThanOrEqual(120);
    expect(message).not.toMatch(/private|\n/);
  });

  it("keeps a plain HTTP failure on one line without repeating the status", () => {
    const tracker = makeModelFailureTracker();
    tracker.record(runUpdated("running"));
    tracker.record(
      errorItem({ class: "provider_error", message: "HTTP 500 Internal\nserver error" }),
    );
    expect(tracker.snapshot(now).get(key)?.message).toBe("HTTP 500 Internal server error");
  });
});

function errorItem(
  failure: {
    class: OrchestrationV2ProviderFailureClass;
    resetAt?: string;
    message?: string;
    code?: string;
    usageLimitWindowIds?: ReadonlyArray<string>;
  },
  status: "running" | "failed" = "failed",
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${failure.class}-${status}`),
    type: "turn-item.updated",
    threadId,
    runId,
    providerInstanceId: instanceId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make("item-error"),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status,
      title: "Usage limit reached",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "error",
      failure: {
        class: failure.class,
        message: failure.message ?? "  You've hit your limit\n  · resets 5:40pm ",
        code: failure.code ?? null,
        retryable: null,
        ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
        ...(failure.usageLimitWindowIds === undefined
          ? {}
          : { usageLimitWindowIds: failure.usageLimitWindowIds }),
      },
    },
  } as unknown as OrchestrationV2DomainEvent;
}

function runUpdated(
  status: "running" | "completed" | "failed" | "interrupted",
  model = "gemini-3.1-pro",
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-run-${status}`),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model },
      status,
    },
  } as unknown as OrchestrationV2DomainEvent;
}

it.effect("keeps processing provider health after one failed run lookup", () =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const limit = errorItem({
      class: "usage_limit",
      message: "Rate limit reached",
      usageLimitWindowIds: ["model-window"],
    });
    const next = errorItem({ class: "authentication_error", message: "Please sign in" });
    const outputRunId = RunId.make("run-streaming");
    const output = {
      ...limit,
      runId: outputRunId,
      payload: {
        ...limit.payload,
        runId: outputRunId,
        type: "assistant_message",
        status: "running",
        text: "Output",
      },
    } as OrchestrationV2DomainEvent;
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: DateTime.formatIso(at),
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: DateTime.formatIso(at),
        windows: [
          {
            id: "model-window",
            kind: "session",
            label: "Model window",
            modelIds: ["model-a"],
            usedPercent: 100,
          },
        ],
      },
    };
    const failures: ServerProviderRecentFailure[] = [];
    const reads: ThreadId[] = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromIterable([output, limit, limit, next]).pipe(
          Stream.ensuring(Deferred.succeed(done, undefined)),
        ),
        getThreadRecords: (id) =>
          Effect.sync(() => reads.push(id)).pipe(
            Effect.andThen(
              Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id })),
            ),
          ),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        recordModelHealthEvent: () => Effect.void,
        setProviderRecentFailure: ({ failure }) =>
          Effect.sync(() => {
            if (failure) failures.push(failure);
          }),
      }),
    );
    yield* Layer.build(healthLayer.pipe(Layer.provide(dependencies)));
    yield* Deferred.await(done);
    expect(reads).toEqual([threadId]);
    expect(failures.map(({ kind }) => kind)).toEqual([
      "usage_limit",
      "usage_limit",
      "authentication_error",
    ]);
    expect(failures.map(({ modelIds }) => modelIds)).toEqual([["model-a"], ["model-a"], undefined]);
  }),
);

describe("providerHealthUpdate", () => {
  it.each([
    ["billing_error", "Budget exhausted.", "2026-11-04T02:00:00.000Z"],
    ["subscription_error", "Model not in plan.", "2026-11-04T02:00:00.000Z"],
    ["authentication_error", "Signed out.", "2026-11-03T21:00:00.000Z"],
    ["permission_error", "Permission denied.", "2026-11-03T21:00:00.000Z"],
  ] as const)("quarantines %s only until recheck or a completed run", (kind, reason, resetAt) => {
    const update = providerHealthUpdate(
      errorItem({ class: kind, ...(kind === "billing_error" ? { resetAt } : {}) }),
    );
    expect(update?.instanceId).toBe(instanceId);
    expect(update?.failure?.kind).toBe(kind);
    expect(update?.failure?.message).toContain(reason);
    expect(update?.failure?.resetAt).toBe(resetAt);
    const snapshot = { recentFailure: update!.failure! };
    expect(activeProviderFailure(snapshot, Date.parse(resetAt) - 1)).not.toBeNull();
    expect(activeProviderFailure(snapshot, Date.parse(resetAt))).toBeNull();
    expect(providerHealthUpdate(errorItem({ class: kind }, "running"))).toBeNull();
    expect(providerHealthUpdate(runUpdated("completed"))?.failure).toBeNull();
  });

  it("uses a reported billing reset and bounds failures with no reset", () => {
    const resetAt = "2026-12-01T00:00:00.000Z";
    expect(
      providerHealthUpdate(errorItem({ class: "billing_error", resetAt }))?.failure?.resetAt,
    ).toBe(resetAt);
    expect(providerHealthUpdate(errorItem({ class: "usage_limit" }))?.failure?.resetAt).toBe(
      "2026-11-03T20:05:00.000Z",
    );
    expect(providerHealthUpdate(errorItem({ class: "provider_error" }))?.failure?.resetAt).toBe(
      "2026-11-03T20:05:00.000Z",
    );
  });
  it("marks a provider whose run hit a usage limit, with its reset", () => {
    expect(
      providerHealthUpdate(
        errorItem({ class: "usage_limit", resetAt: "2026-11-03T22:40:00.000Z" }),
      ),
    ).toEqual({
      instanceId,
      failure: {
        kind: "usage_limit",
        message: "You've hit your limit · resets 5:40pm",
        occurredAt: "2026-11-03T20:00:00.000Z",
        resetAt: "2026-11-03T22:40:00.000Z",
      },
    });
  });

  it.each([
    ["2026-11-03T20:00:00Z", "11-04 02:30:00 UTC", "2026-11-04T02:30:00.000Z"],
    ["2026-12-31T23:00:00Z", "01-01 01:30:00 UTC", "2027-01-01T01:30:00.000Z"],
    ["2027-01-01T01:00:00Z", "12-31 23:30:00 UTC", "2027-01-01T01:05:00.000Z"],
    ["2026-02-28T20:00:00Z", "02-30 22:00:00 UTC", "2026-02-28T20:05:00.000Z"],
    ["2026-11-03T20:00:00Z", "11-04 02:30:00", "2026-11-03T20:05:00.000Z"],
  ])("reads the provider's yearless UTC quota reset %s / %s", (occurredAt, reset, expected) => {
    const update = providerHealthUpdate({
      ...errorItem({
        class: "provider_error",
        code: "-32603",
        message: `Quota exhausted: Your token quota is exhausted. The quota will reset at ${reset}. Please retry after the reset.`,
      }),
      providerInstanceId: ProviderInstanceId.make("acpRegistry_qwen_code"),
      occurredAt: DateTime.makeUnsafe(occurredAt),
    });
    expect(update?.failure).toMatchObject({ kind: "usage_limit", resetAt: expected });
  });

  it("marks a provider error and clears on the next completed run", () => {
    expect(providerHealthUpdate(errorItem({ class: "provider_error" }))?.failure?.kind).toBe(
      "provider_error",
    );
    expect(providerHealthUpdate(runUpdated("completed"))).toEqual({
      instanceId,
      failure: null,
      preserveOutOfCredit: true,
    });
  });

  it("ignores retries in progress, other failure classes and runs that did not complete", () => {
    expect(providerHealthUpdate(errorItem({ class: "usage_limit" }, "running"))).toBeNull();
    expect(providerHealthUpdate(errorItem({ class: "transport_error" }))).toBeNull();
    expect(providerHealthUpdate(runUpdated("failed"))).toBeNull();
    expect(providerHealthUpdate(runUpdated("interrupted"))).toBeNull();
  });
});

// These are the API strings/codes in the adapter failure fixtures, plus Muse's observed refusal.
describe("out-of-credit classification", () => {
  it.each([
    ["Muse", "Budget exhausted. Add credits or raise the spending limit.", null],
    ["Claude", "Your credit balance is too low to access the Anthropic API.", "400"],
    ["API 402", "Payment Required", "402"],
    ["OpenCode", "Insufficient credits", "APIError"],
    ["Grok", "You have exhausted your credits", null],
    ["Grok", "Your spending limit has been reached", null],
    ["Grok", "You have exceeded your budget", null],
    ["ACP/Vibe", "Error response 402: Payment Required", "-32603"],
    ["ACP/Vibe", "Your monthly spending limit has been reached", "-32603"],
    ["ACP/Kimi", "Insufficient balance. Please recharge your account.", "-32603"],
  ])("remembers %s's refusal without inventing a reset", (_harness, message, code) => {
    const update = providerHealthUpdate(
      errorItem({ class: "provider_error", message: message!, ...(code ? { code } : {}) }),
    );
    expect(update?.failure).toMatchObject({ outOfCredit: true, message });
    expect(update?.failure?.resetAt).toBeUndefined();
    expect(
      activeProviderFailure({ recentFailure: update!.failure! }, Date.parse("2030-01-01")),
    ).not.toBeNull();
  });
  it.each([
    ["Insufficient credits", "usage_limit", undefined],
    ["Too many requests", "usage_limit", "2026-11-03T22:40:00.000Z"],
    ["Quota exhausted", "usage_limit", "2026-11-03T22:40:00.000Z"],
    ["Internal error", "provider_error", undefined],
    ["Claude stopped: the turn's token budget was exhausted.", "provider_error", undefined],
    ["disk quota exhausted", "provider_error", undefined],
    ["Grok usage limit reached. Try again later.", "usage_limit", undefined],
  ] as const)("does not remember %s as exhausted credit", (message, kind, resetAt) => {
    expect(
      providerHealthUpdate(errorItem({ class: kind, message, ...(resetAt ? { resetAt } : {}) }))
        ?.failure?.outOfCredit,
    ).not.toBe(true);
  });
  it("stores a single short line", () => {
    const message = `Budget exhausted.\n${"x".repeat(300)}`;
    const failure = providerHealthUpdate(errorItem({ class: "billing_error", message }))?.failure;
    expect(failure?.message).toHaveLength(160);
    expect(failure?.message).not.toContain("\n");
  });
  it.each(["assistant_message", "reasoning"] as const)(
    "clears on real %s output before completion",
    (type) => {
      const base = errorItem({ class: "provider_error" });
      const event = {
        ...base,
        payload: { ...base.payload, type, status: "running", text: "Model response" },
      } as unknown as OrchestrationV2DomainEvent;
      expect(providerHealthUpdate(event)).toEqual({ instanceId, failure: null });
      expect(
        providerHealthUpdate({
          ...event,
          payload: { ...event.payload, text: "" },
        } as unknown as OrchestrationV2DomainEvent),
      ).toBeNull();
    },
  );
});

it.each(["dynamic_tool", "command_execution", "file_search", "web_search"])(
  "clears when a model responds with %s",
  (type) => {
    const base = errorItem({ class: "provider_error" });
    expect(
      providerHealthUpdate({
        ...base,
        payload: { ...base.payload, type, status: "running" },
      } as unknown as OrchestrationV2DomainEvent),
    ).toEqual({ instanceId, failure: null });
  },
);

it.each([
  ["usage_limit", "409 Token quota is exhausted", "-32603"],
  ["provider_error", "Quota exhausted", "insufficient_quota"],
  ["provider_error", "Resource exhausted. Please try again later.", "provider.rate-limit"],
] as const)("keeps %s %s temporary for balancing", (kind, message, code) => {
  const failure = providerHealthUpdate(errorItem({ class: kind, message, code }))?.failure;
  expect(failure?.kind).toBe("usage_limit");
  expect(failure?.outOfCredit).not.toBe(true);
  expect(failure?.resetAt).toBeDefined();
});

describe("model availability", () => {
  const gone = "Model gemini-3.1-pro has been deprecated.";

  it("records the run's exact instance and model when the provider says it is gone", () => {
    const track = makeModelAvailabilityTracker();
    expect(track(runUpdated("running"))).toBeNull();
    expect(track(errorItem({ class: "provider_error", message: gone }, "running"))).toBeNull();
    expect(track(errorItem({ class: "provider_error", message: gone }))).toEqual({
      instanceId,
      model: "gemini-3.1-pro",
      reason: gone,
    });
    expect(track(runUpdated("completed"))).toEqual({
      instanceId,
      model: "gemini-3.1-pro",
      reason: null,
    });
  });

  it.each([
    ["usage_limit", "Rate limit reached for model gemini-3.1-pro"],
    ["provider_error", "The model is overloaded. Please try again later."],
    ["billing_error", "Insufficient credits for model gemini-3.1-pro"],
    ["authentication_error", "Invalid API key"],
  ] as const)("ignores %s: %s", (failureClass, message) => {
    const track = makeModelAvailabilityTracker();
    track(runUpdated("running"));
    expect(track(errorItem({ class: failureClass, message }))).toBeNull();
  });

  it("says nothing about a run it never saw", () => {
    expect(
      makeModelAvailabilityTracker()(errorItem({ class: "provider_error", message: gone })),
    ).toBeNull();
  });
});

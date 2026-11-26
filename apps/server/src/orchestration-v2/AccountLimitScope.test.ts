import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Health from "./ProviderHealthReactor.ts";
import { expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ServerProviderRecentFailure,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  pickAccountForNewSession,
  usageWindowsForModel,
  usageLimitModelIds,
} from "@t3tools/shared/accountBalance";
import { providerHealthUpdate } from "./ProviderHealthReactor.ts";
import { accountRoomLabel, routeStanding } from "@t3tools/client-runtime/account-routes";
import { accountUnavailable } from "../provider/accountAvailability.ts";

const at = "2026-11-17T16:00:00.000Z";
const reset = "2026-11-19T16:00:00.000Z";
const primary = ProviderInstanceId.make("claudeAgent");
const secondary = ProviderInstanceId.make("claudeAgent_work");
function account(instanceId: typeof primary, weekly: number): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    models: ["claude-opus-5-5", "claude-fable-5-2"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: at,
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: weekly,
          resetsAt: reset,
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          windowDurationMins: 10080,
          usedPercent: instanceId === primary ? 100 : 20,
          resetsAt: reset,
        },
      ],
    },
  };
}
it("a Fable-only weekly refusal does not mark Opus out or route it off its roomier account", () => {
  const first = account(primary, 10);
  const second = account(secondary, 60);
  const select = (providers: ReadonlyArray<ServerProvider>) =>
    pickAccountForNewSession(
      providers,
      { instanceId: primary, model: "claude-opus-5-5" },
      { now: Date.parse(at) },
    );
  expect(usageWindowsForModel(first, "claude-opus-5-5").map((w) => w.id)).toEqual(["seven_day"]);
  expect(select([first, second])?.instanceId).toBe(primary);
  const health = providerHealthUpdate(
    {
      id: EventId.make("synthetic-fable-limit"),
      type: "turn-item.updated",
      threadId: ThreadId.make("fable-chat"),
      runId: RunId.make("fable-run"),
      providerInstanceId: primary,
      occurredAt: DateTime.makeUnsafe(at),
      payload: {
        id: TurnItemId.make("fable-error"),
        type: "error",
        status: "failed",
        failure: {
          class: "usage_limit",
          code: "blocking_limit",
          message: "Claude usage limit reached.",
          resetAt: reset,
          retryable: true,
        },
      },
    } as unknown as OrchestrationV2DomainEvent,
    { provider: first, model: "claude-fable-5-2" },
  );
  expect(health?.instanceId).toBe(primary);
  expect(health?.failure?.modelIds).toEqual(["claude-fable-5-2"]);
  const after = { ...first, recentFailure: health!.failure! };
  const picked = select([after, second]);
  // The provider's own limits show Opus still has 90%; only Fable is exhausted.
  expect.soft(picked?.standings.find((entry) => entry.instanceId === primary)?.state).toBe("open");
  expect.soft(picked?.instanceId).toBe(primary);
  expect(accountUnavailable(after, Date.parse(at))).toBeUndefined();
  expect(accountUnavailable(after, Date.parse(at), "claude-opus-5-5")).toBeUndefined();
  expect(accountUnavailable(after, Date.parse(at), "claude-fable-5-2")?.recheckAt).toBe(reset);
});

it("keeps independent OpenCode routes usable after a free-tier refusal", () => {
  const provider = { ...account(primary, 0), driver: ProviderDriverKind.make("opencode") };
  const model = "opencode/deepseek-flash-free";
  const event = {
    type: "turn-item.updated",
    providerInstanceId: primary,
    occurredAt: DateTime.makeUnsafe(at),
    payload: {
      type: "error",
      status: "failed",
      failure: {
        class: "usage_limit",
        code: "provider.free-limit",
        message: "Free usage limit reached.",
      },
    },
  } as OrchestrationV2DomainEvent;
  const failure = providerHealthUpdate(event, { provider, model })?.failure;
  expect(failure?.modelIds).toEqual([model]);
  const limited = { ...provider, recentFailure: failure! };
  expect(accountUnavailable(limited, Date.parse(at), model)).toBeDefined();
  expect(
    accountUnavailable(limited, Date.parse(at), "openrouter/recursive/flint:free"),
  ).toBeUndefined();
  expect(accountUnavailable(limited, Date.parse(at))).toBeUndefined();
  expect(providerHealthUpdate(event, { provider })).toBeNull();
});

it("keeps an Antigravity family refusal scoped in health, routing and Runs in", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const now = Date.parse(at);
  const claude = "claude-opus-5-5";
  const gemini = "gemini-4-neon";
  const provider: ServerProvider = {
    ...account(instanceId, 0),
    driver: ProviderDriverKind.make("antigravity"),
    usageLimits: {
      checkedAt: at,
      windows: [
        {
          id: "3p-5h",
          kind: "session",
          label: "Claude & GPT (shared) · 5-hour",
          modelIds: [claude, "gpt-5"],
          usedPercent: 100,
          resetsAt: reset,
        },
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini · Weekly",
          modelIds: [gemini],
          usedPercent: 5,
          resetsAt: reset,
        },
      ],
    },
  };
  const event = {
    type: "turn-item.updated",
    providerInstanceId: instanceId,
    occurredAt: DateTime.makeUnsafe(at),
    payload: {
      type: "error",
      status: "failed",
      failure: { class: "usage_limit", message: "Limit reached." },
    },
  } as OrchestrationV2DomainEvent;
  const failure = providerHealthUpdate(event, { provider, model: claude })?.failure;
  expect(failure?.modelIds).toEqual([claude, "gpt-5"]);
  const limited = { ...provider, recentFailure: failure! };
  expect(accountUnavailable(limited, now, gemini)).toBeUndefined();
  expect(accountRoomLabel(routeStanding([limited], instanceId, claude, now))).toBe("At limit");
  expect(accountRoomLabel(routeStanding([limited], instanceId, gemini, now))).toBe("95% left");
  expect(usageLimitModelIds(provider, gemini, now)).toBeUndefined();
  expect(usageLimitModelIds(provider, claude, Date.parse(reset))).toBeUndefined();
});

// The same window rules apply to every adapter, including model and sub-provider metadata.
it.each(["claudeAgent", "codex", "grok"])(
  "infers scope from %s usage windows without widening it",
  (driver) => {
    const scoped = { ...account(primary, 10), driver: ProviderDriverKind.make(driver) };
    expect(usageLimitModelIds(scoped, "claude-fable-5-2", Date.parse(at))).toEqual([
      "claude-fable-5-2",
    ]);
    expect(usageLimitModelIds(scoped, "claude-opus-5-5", Date.parse(at))).toBeUndefined();
    expect(usageLimitModelIds(scoped, undefined, Date.parse(at), ["seven_day_fable"])).toEqual([
      "claude-fable-5-2",
    ]);
    expect(usageLimitModelIds(scoped, "claude-fable-5-2", Date.parse(reset))).toBeUndefined();
    expect(
      usageLimitModelIds(scoped, "claude-fable-5-2", Date.parse(at), ["unrecognized"]),
    ).toBeUndefined();
    expect(
      usageLimitModelIds(account(primary, 100), "claude-fable-5-2", Date.parse(at)),
    ).toBeUndefined();
    expect(
      usageLimitModelIds(scoped, undefined, Date.parse(at), ["seven_day", "seven_day_fable"]),
    ).toBeUndefined();
  },
);
it("uses explicit model and provider ids before the window's label", () => {
  const source = account(primary, 10);
  const provider = {
    ...source,
    models: ["vendor/a", "vendor/b", "other/c"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    usageLimits: {
      ...source.usageLimits!,
      windows: [
        source.usageLimits!.windows[0]!,
        {
          id: "scoped",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: 100,
          modelIds: ["vendor/a", "vendor/b"],
        },
      ],
    },
  };
  expect(usageLimitModelIds(provider, "vendor/a", Date.parse(at))).toEqual([
    "vendor/a",
    "vendor/b",
  ]);
  const byVendor = {
    ...provider,
    usageLimits: {
      ...provider.usageLimits,
      windows: [
        provider.usageLimits.windows[0]!,
        {
          id: "scoped",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: 100,
          providerIds: ["vendor"],
        },
      ],
    },
  };
  expect(usageLimitModelIds(byVendor, "vendor/a", Date.parse(at))).toEqual([
    "vendor/a",
    "vendor/b",
  ]);
});

effectIt.effect(
  "the health reactor scopes a failed run and keeps its limit through output on another model",
  () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      let provider = account(primary, 10);
      const failures: Array<ServerProviderRecentFailure | null> = [];
      let runReads = 0;
      const run = (id: string, model: string) =>
        ({
          id: RunId.make(id),
          providerInstanceId: primary,
          modelSelection: { instanceId: primary, model },
          status: "completed",
        }) as OrchestrationV2Run;
      const runs = [run("fable", "claude-fable-5-2"), run("opus", "claude-opus-5-5")];
      const events = [
        {
          id: EventId.make("fable-error"),
          type: "turn-item.updated",
          threadId: ThreadId.make("scoped-health"),
          providerInstanceId: primary,
          runId: runs[0]!.id,
          occurredAt: DateTime.makeUnsafe(at),
          payload: {
            type: "error",
            status: "failed",
            failure: {
              class: "usage_limit",
              message: "Limit reached.",
              code: null,
              retryable: false,
              resetAt: reset,
            },
          },
        },
        {
          id: EventId.make("opus-done"),
          type: "run.updated",
          threadId: ThreadId.make("scoped-health"),
          runId: runs[1]!.id,
          occurredAt: DateTime.makeUnsafe(at),
          payload: runs[1],
        },
        {
          id: EventId.make("fable-output"),
          type: "turn-item.updated",
          threadId: ThreadId.make("scoped-health"),
          providerInstanceId: primary,
          runId: runs[0]!.id,
          occurredAt: DateTime.makeUnsafe(at),
          payload: { type: "assistant_message", status: "running", text: "It works again." },
        },
      ] as OrchestrationV2DomainEvent[];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromIterable(events).pipe(
            Stream.ensuring(Deferred.succeed(done, undefined)),
          ),
          getThreadRecords: () =>
            Effect.sync(() => {
              runReads += 1;
              return { runs } as never;
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => [provider]),
          recordModelHealthEvent: () => Effect.void,
          setModelUnavailable: () => Effect.void,
          setProviderRecentFailure: (update) =>
            Effect.sync(() => {
              failures.push(update.failure);
              const { recentFailure: _old, ...rest } = provider;
              provider = { ...rest, ...(update.failure ? { recentFailure: update.failure } : {}) };
            }),
        }),
      );
      yield* Layer.build(Health.layer.pipe(Layer.provide(dependencies)));
      yield* Deferred.await(done);
      expect(failures).toHaveLength(2);
      expect(failures[0]?.modelIds).toEqual(["claude-fable-5-2"]);
      expect(failures[1]).toBeNull();
      // The chat's runs are read once, for the failed run; streamed output never reads them.
      expect(runReads).toBe(1);
    }).pipe(Effect.scoped),
);

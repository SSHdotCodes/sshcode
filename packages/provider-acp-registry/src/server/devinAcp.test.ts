import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  devinStepUsage,
  normalizeDevinToolCall,
  steerDevinTurn,
  withDevinLightningSpeed,
  withoutDevinEffortSuffix,
} from "./devinAcp.ts";

it("retains a failed terminal exit through Devin's final text-only update", () => {
  const terminal = normalizeDevinToolCall({
    toolCallId: "exec",
    status: "inProgress",
    data: { meta: { terminal_exit: { exit_code: 7 } } },
  });
  const completed = normalizeDevinToolCall({
    ...terminal,
    status: "completed",
    data: { ...terminal.data, meta: { "cognition.ai/inferenceToolName": "exec" }, content: [] },
  });
  assert.equal(completed.status, "failed");
  assert.equal(completed.data.exitCode, 7);
});

it("counts only the root copy of each Devin inference", () => {
  const update = { sessionUpdate: "usage_update" as const, used: 120, size: 2048 };
  const sample = {
    "cognition.ai/inputTokens": 99,
    "cognition.ai/outputTokens": 21,
    "cognition.ai/cachedReadTokens": 40,
  };
  const tagged = (parentAgentId: string) => ({
    ...update,
    _meta: { ...sample, "cognition.ai/subagent_context": { parentAgentId } },
  });
  assert.isUndefined(devinStepUsage({ ...update, _meta: sample }));
  assert.isUndefined(devinStepUsage(tagged("child")));
  assert.deepEqual(devinStepUsage(tagged("root")), {
    inputTokens: 99,
    outputTokens: 21,
    totalTokens: 120,
    cachedReadTokens: 40,
  });
});

// Devin answers a mid-turn prompt only when the turn it joined ends (or fails it at once).
const setup = (reply: "pending" | "refused" = "pending") =>
  Effect.gen(function* () {
    const answer = yield* Deferred.make<void, EffectAcpErrors.AcpRequestError>();
    const ended = yield* Deferred.make<void>();
    const sent: Array<{ method: string; payload: unknown }> = [];
    let cancels = 0;
    const runtime = {
      request: (method: string, payload: unknown) =>
        Effect.sync(() => sent.push({ method, payload })).pipe(
          Effect.andThen(
            reply === "refused"
              ? Effect.fail(EffectAcpErrors.AcpRequestError.invalidParams("busy"))
              : Deferred.await(answer).pipe(Effect.as({ stopReason: "end_turn" })),
          ),
        ),
      cancel: Effect.sync(() => {
        cancels++;
      }),
    };
    const steer = (text: string) =>
      steerDevinTurn({
        driver: ProviderDriverKind.make("acpRegistry"),
        runtime: runtime as never,
        sessionId: "session",
        text,
        messageId: MessageId.make("message"),
        providerTurnId: ProviderTurnId.make("turn"),
        providerThreadId: ProviderThreadId.make("thread"),
        turnOver: { await: Deferred.await(ended), isDone: Deferred.isDone(ended) },
      });
    return { steer, answer, ended, sent, cancels: () => cancels };
  });

describe("steerDevinTurn", () => {
  it.effect("sends the message as a prompt into the running turn", () =>
    Effect.gen(function* () {
      const { steer, sent, cancels } = yield* setup();
      const fiber = yield* steer("use tabs").pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
      assert.deepEqual(sent, [
        {
          method: "session/prompt",
          payload: { sessionId: "session", prompt: [{ type: "text", text: "use tabs" }] },
        },
      ]);
      assert.equal(cancels(), 0);
    }),
  );

  it.effect("counts a prompt that returns with the turn as delivered", () =>
    Effect.gen(function* () {
      const { steer, answer, ended, cancels } = yield* setup();
      const fiber = yield* steer("wrap up").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(ended, undefined);
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(fiber);
      assert.equal(cancels(), 0);
    }),
  );

  it.effect("cancels the turn Devin starts when the steer arrives after the end", () =>
    Effect.gen(function* () {
      const { steer, ended, cancels } = yield* setup();
      const fiber = yield* steer("too late").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(ended, undefined);
      yield* TestClock.adjust("2 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
      assert.equal(cancels(), 1);
    }),
  );

  it.effect("hands back a late refusal without cancelling the session's next prompt", () =>
    Effect.gen(function* () {
      const { steer, answer, ended, cancels } = yield* setup();
      const result = yield* steer("next").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.succeed(ended, undefined);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.fail(answer, EffectAcpErrors.AcpRequestError.invalidParams("turn ended"));
      assert.equal((yield* Fiber.join(result))._tag, "ProviderAdapterSteerRunUnsupportedError");
      assert.equal(cancels(), 0);
    }),
  );

  it.effect("hands the message back without sending when the turn is already over", () =>
    Effect.gen(function* () {
      const { steer, ended, sent } = yield* setup();
      yield* Deferred.succeed(ended, undefined);
      const error = yield* steer("next").pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
      assert.deepEqual(sent, []);
    }),
  );

  it.effect("hands the message back when Devin refuses the prompt", () =>
    Effect.gen(function* () {
      const { steer, cancels } = yield* setup("refused");
      const error = yield* steer("hello").pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
      assert.equal(cancels(), 0);
    }),
  );
});

describe("withDevinLightningSpeed", () => {
  const speedModel = (slug: string) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "speed",
          label: "Speed",
          type: "select" as const,
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
          currentValue: "standard",
        },
      ],
    },
  });
  const fastLabel = (model: ReturnType<typeof speedModel>) => {
    const descriptor = model.capabilities?.optionDescriptors?.[0];
    return descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === "fast")?.label
      : undefined;
  };

  it("names SWE models' fast speed Lightning and leaves other makers' Fast alone", () => {
    const [swe, claude] = withDevinLightningSpeed([
      speedModel("swe-2-1-medium"),
      speedModel("claude-opus-5-5-medium"),
    ]) as Array<ReturnType<typeof speedModel>>;
    assert.strictEqual(fastLabel(swe!), "Lightning");
    assert.strictEqual(fastLabel(claude!), "Fast");
  });
});

describe("withoutDevinEffortSuffix", () => {
  const model = (slug: string, name: string, shortName?: string): ServerProviderModel => ({
    slug,
    name,
    ...(shortName ? { shortName } : {}),
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "thought_level",
          label: "Reasoning",
          type: "select",
          role: "reasoning",
          options: [{ id: "medium", label: "Medium", isDefault: true }],
        },
      ],
    },
  });

  it("strips only the final effort word while retaining the slug and capabilities", () => {
    const medium = model("swe-2.1-medium", "SWE-2.1 Medium", "SWE Medium");
    const flash = model("swe-2-flash-medium", "SWE-2 Flash Medium");
    const fast = model("swe-2.1-ultrafast-low", "SWE-2.1 Ultrafast Low");
    const bare = model("claude-sonnet", "Claude Sonnet");
    const withoutReasoning = { ...model("provider-max", "Provider Max"), capabilities: {} };
    const [renamedMedium, renamedFlash, renamedFast, unchanged, nonReasoning] =
      withoutDevinEffortSuffix([medium, flash, fast, bare, withoutReasoning]);

    assert.deepStrictEqual(renamedMedium, { ...medium, name: "SWE-2.1", shortName: "SWE" });
    assert.strictEqual(renamedFlash?.name, "SWE-2 Flash");
    assert.strictEqual(renamedFast?.name, "SWE-2.1 Ultrafast");
    assert.strictEqual(unchanged, bare);
    assert.strictEqual(nonReasoning, withoutReasoning);
  });

  it("keeps names when either stripped spelling would overlap another model", () => {
    const variants = [
      model("a-low", "Model A Low"),
      model("a-high", "Model A High"),
      model("b-xhigh", "Model B XHigh"),
      model("b", "Model B"),
      model("c-max", "Model C Max", "Shared Max"),
      model("d", "Model D", "Shared"),
    ];
    assert.deepStrictEqual(withoutDevinEffortSuffix(variants), variants);
  });
});

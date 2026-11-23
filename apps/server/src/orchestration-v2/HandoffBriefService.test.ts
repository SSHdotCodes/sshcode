import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as HandoffBriefService from "./HandoffBriefService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

class Overloaded extends Data.TaggedError("Overloaded") {}

const threadId = ThreadId.make("thread:brief");
const claude = ProviderInstanceId.make("claudeAgent");
const gemini = ProviderInstanceId.make("antigravity");
const codex = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("provider-session:claude");
const briefText = [
  `## Goal and requirements\n"Keep the importer streaming."\n${"Specifics. ".repeat(10)}`,
  "## Where things stand\nThe parser streams; the writer still buffers.",
  "## Decisions and why\nNode streams, not a worker: fewer copies.",
  "## Done and verified\nParser tests pass.",
  "## Open problems\nnone",
  "## Next step\nStream the writer.",
].join("\n\n");
// What Claude Code answers in place of the model when the account is out of usage.
const limitNotice = `API Error: 429 ${JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "This request would exceed your usage limit." },
  request_id: "req_0".repeat(20),
})}`;

const records = {
  providerThreads: [
    {
      id: ProviderThreadId.make("provider-thread:claude"),
      providerInstanceId: claude,
      providerSessionId: sessionId,
      ownerNodeId: null,
      nativeThreadRef: { nativeId: "native:claude" },
    },
  ],
  runs: [
    {
      status: "completed",
      providerInstanceId: claude,
      modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
    },
  ],
  turnItems: [
    {
      id: "item:1",
      type: "user_message",
      text: "Make the importer stream, never buffer.",
      threadId,
      runId: "run:1",
      providerThreadId: null,
      status: "completed",
    },
    {
      id: "item:2",
      type: "assistant_message",
      text: "The parser streams now; the writer is next.",
      threadId,
      runId: "run:1",
      providerThreadId: null,
      status: "completed",
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;
const flash = { instanceId: gemini, model: "gemini-3.8-flash" };
type BriefSettings = {
  readonly handoffBriefEnabled: boolean;
  readonly handoffBriefModelSelection: {
    readonly instanceId: string;
    readonly model: string;
  } | null;
  readonly textGenerationModelSelection?: { readonly instanceId: string; readonly model: string };
};

const setup = (options: {
  readonly live?: boolean;
  readonly answer?: Effect.Effect<string, Overloaded>;
  readonly synthetic?: boolean;
  readonly accountFailure?: { readonly kind: "usage_limit"; readonly resetAt?: string };
  /** The brief settings; absent, the service runs with none (the model being left). */
  readonly settings?: Ref.Ref<BriefSettings>;
  readonly transcriptAnswer?: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const questions = yield* Ref.make<ReadonlyArray<string>>([]);
    const interrupted = yield* Ref.make(false);
    const detached = yield* Deferred.make<void>();
    const prompts = yield* Ref.make<ReadonlyArray<{ prompt: string; model: string }>>([]);
    const runtime = {
      askSideQuestion: (input: { readonly question: string }) =>
        Ref.update(questions, (all) => [...all, input.question]).pipe(
          Effect.andThen(options.answer ?? Effect.succeed(briefText)),
          Effect.map((response) =>
            Option.some(options.synthetic === true ? { response, synthetic: true } : { response }),
          ),
          Effect.onInterrupt(() => Ref.set(interrupted, true)),
          Effect.orDie,
        ),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const context = yield* Layer.build(
      HandoffBriefService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadRecords: () => Effect.succeed(records),
              getReportedContextWindow: () => Effect.succeed(1_000_000),
            }),
            // A detached session is gone, as in the real manager.
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Deferred.isDone(detached).pipe(
                  Effect.map((gone) =>
                    options.live === false || gone ? Option.none() : Option.some(runtime),
                  ),
                ),
            }),
            ...(options.settings === undefined
              ? []
              : [
                  Layer.mock(ServerSettings.ServerSettingsService)({
                    getSettings: Ref.get(options.settings).pipe(
                      Effect.map((settings) => ({
                        textGenerationModelSelection: null,
                        ...settings,
                      })),
                    ) as never,
                  }),
                  Layer.mock(TextGeneration.TextGeneration)({
                    rewriteProse: (input: { prompt: string; modelSelection: { model: string } }) =>
                      Ref.update(prompts, (all) => [
                        ...all,
                        { prompt: input.prompt, model: input.modelSelection.model },
                      ]).pipe(
                        Effect.andThen(options.transcriptAnswer ?? Effect.succeed(briefText)),
                        Effect.map((output) => ({ output })),
                      ),
                  } as never),
                  Layer.succeed(ServerConfig.ServerConfig, { stateDir: "/tmp/state" } as never),
                ]),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                {
                  instanceId: claude,
                  ...(options.accountFailure === undefined
                    ? {}
                    : {
                        recentFailure: {
                          ...options.accountFailure,
                          message: "You've hit your limit.",
                          occurredAt: "2026-11-21T07:00:00.000Z",
                        },
                      }),
                },
                { instanceId: gemini },
              ] as never),
            }),
          ),
        ),
      ),
    );
    const briefs = Context.get(context, HandoffBriefService.HandoffBriefService);
    yield* briefs.requestThenDetach({
      threadId,
      providerSessionId: sessionId,
      targetInstanceId: gemini,
      detach: Deferred.succeed(detached, undefined).pipe(Effect.asVoid),
    });
    const deadline = (yield* Clock.currentTimeMillis) + 20_000;
    return { briefs, questions, interrupted, detached, deadline, prompts };
  });

describe("handoff brief", () => {
  it.effect(
    "asks the outgoing session for a brief, gives it to the send, then releases the session",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const { briefs, questions, detached, deadline } = yield* setup({
          answer: Deferred.await(gate).pipe(Effect.as(briefText)),
        });
        // The session stays open while it writes.
        assert.isFalse(yield* Deferred.isDone(detached));
        const take = yield* briefs
          .take({ threadId, targetInstanceId: gemini, deadlineMs: deadline })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(gate, undefined);
        const brief = yield* Fiber.join(take);
        assert.deepEqual(Option.getOrUndefined(brief), {
          providerInstanceId: claude,
          model: "claude-opus-5-5",
          text: briefText.trim(),
        });
        assert.deepEqual(yield* Ref.get(questions), [HandoffBriefService.HANDOFF_BRIEF_PROMPT]);
        yield* Deferred.await(detached);
        // Consumed: a later send hands off without it.
        assert.isTrue(
          Option.isNone(
            yield* briefs.take({ threadId, targetInstanceId: gemini, deadlineMs: deadline }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("releases a session that has no live process at once and hands nothing over", () =>
    Effect.gen(function* () {
      const { briefs, questions, detached, deadline } = yield* setup({ live: false });
      assert.isTrue(yield* Deferred.isDone(detached));
      assert.lengthOf(yield* Ref.get(questions), 0);
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.isTrue(Option.isNone(brief));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "drops a brief for another target, releasing its session before the turn opens one",
    () =>
      Effect.gen(function* () {
        const { briefs, interrupted, detached, deadline } = yield* setup({ answer: Effect.never });
        yield* briefs.settle({ threadId, instanceId: gemini });
        assert.isFalse(yield* Deferred.isDone(detached));
        yield* briefs.settle({ threadId, instanceId: codex });
        assert.isTrue(yield* Deferred.isDone(detached));
        assert.isTrue(yield* Ref.get(interrupted));
        const brief = yield* briefs.take({
          threadId,
          targetInstanceId: gemini,
          deadlineMs: deadline,
        });
        assert.isTrue(Option.isNone(brief));
      }).pipe(Effect.scoped),
  );

  it.effect("sends without a brief that is not ready by the deadline", () =>
    Effect.gen(function* () {
      const { briefs, interrupted, detached, deadline } = yield* setup({ answer: Effect.never });
      const take = yield* briefs
        .take({ threadId, targetInstanceId: gemini, deadlineMs: deadline })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      assert.isTrue(Option.isNone(yield* Fiber.join(take)));
      yield* Deferred.await(detached);
      assert.isTrue(yield* Ref.get(interrupted));
    }).pipe(Effect.scoped),
  );

  it.effect("never asks an account that is out of usage, and releases its session at once", () =>
    Effect.gen(function* () {
      const { briefs, questions, detached, deadline } = yield* setup({
        accountFailure: { kind: "usage_limit", resetAt: "2999-01-01T00:00:00.000Z" },
      });
      assert.isTrue(yield* Deferred.isDone(detached));
      assert.lengthOf(yield* Ref.get(questions), 0);
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.isTrue(Option.isNone(brief));
    }).pipe(Effect.scoped),
  );

  it.effect("asks again once the account's limit has reset", () =>
    Effect.gen(function* () {
      const { questions } = yield* setup({
        accountFailure: { kind: "usage_limit", resetAt: "1970-01-01T00:00:00.000Z" },
      });
      assert.lengthOf(yield* Ref.get(questions), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("hands over no error message in place of a brief", () =>
    Effect.gen(function* () {
      for (const input of [
        // A limit notice the harness wrote, even one shaped like a brief.
        { answer: Effect.succeed(briefText), synthetic: true },
        // A long error that reached the answer without the flag.
        { answer: Effect.succeed(limitNotice) },
      ]) {
        const { briefs, detached, deadline } = yield* setup(input);
        const brief = yield* briefs.take({
          threadId,
          targetInstanceId: gemini,
          deadlineMs: deadline,
        });
        assert.isTrue(Option.isNone(brief));
        yield* Deferred.await(detached);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("never fails the send when the side question fails or says too little", () =>
    Effect.gen(function* () {
      for (const answer of [Effect.fail(new Overloaded()), Effect.succeed("ok")]) {
        const { briefs, detached, deadline } = yield* setup({ answer });
        const brief = yield* briefs.take({
          threadId,
          targetInstanceId: gemini,
          deadlineMs: deadline,
        });
        assert.isTrue(Option.isNone(brief));
        yield* Deferred.await(detached);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("writes no brief when turned off, and lets the session go at once", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<BriefSettings>({
        handoffBriefEnabled: false,
        handoffBriefModelSelection: null,
      });
      const { briefs, questions, detached, deadline, prompts } = yield* setup({ settings });
      assert.isTrue(yield* Deferred.isDone(detached));
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.isTrue(Option.isNone(brief));
      assert.lengthOf(yield* Ref.get(questions), 0);
      assert.lengthOf(yield* Ref.get(prompts), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("has a chosen model write it from the transcript, without the session being left", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<BriefSettings>({
        handoffBriefEnabled: true,
        handoffBriefModelSelection: flash,
      });
      const { briefs, questions, detached, deadline, prompts } = yield* setup({ settings });
      // The session being left is not needed for it.
      assert.isTrue(yield* Deferred.isDone(detached));
      assert.lengthOf(yield* Ref.get(questions), 0);
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.deepEqual(Option.getOrUndefined(brief), {
        providerInstanceId: gemini,
        model: "gemini-3.8-flash",
        text: briefText.trim(),
      });
      const [asked] = yield* Ref.get(prompts);
      assert.equal(asked?.model, "gemini-3.8-flash");
      assert.include(asked?.prompt, "Make the importer stream, never buffer.");
      assert.include(asked?.prompt, "The parser streams now; the writer is next.");
      assert.include(asked?.prompt, "## Goal and requirements");
    }).pipe(Effect.scoped),
  );

  it.effect("follows a writer chosen after the switch, and hands over no error as a brief", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<BriefSettings>({
        handoffBriefEnabled: true,
        handoffBriefModelSelection: null,
      });
      const { briefs, deadline, prompts } = yield* setup({
        settings,
        transcriptAnswer: Effect.succeed("I could not read the transcript. ".repeat(20)),
      });
      yield* Ref.set(settings, { handoffBriefEnabled: true, handoffBriefModelSelection: flash });
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.lengthOf(yield* Ref.get(prompts), 1);
      assert.isTrue(Option.isNone(brief));
    }).pipe(Effect.scoped),
  );

  it.effect("has the model being left write from the transcript when its session is gone", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<BriefSettings>({
        handoffBriefEnabled: true,
        handoffBriefModelSelection: null,
      });
      const { briefs, questions, deadline, prompts } = yield* setup({ live: false, settings });
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.lengthOf(yield* Ref.get(questions), 0);
      assert.deepEqual(
        (yield* Ref.get(prompts)).map((entry) => entry.model),
        ["claude-opus-5-5"],
      );
      assert.deepEqual(Option.getOrUndefined(brief), {
        providerInstanceId: claude,
        model: "claude-opus-5-5",
        text: briefText,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("has the text generation model write it when the account being left is out", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make<BriefSettings>({
        handoffBriefEnabled: true,
        handoffBriefModelSelection: null,
        textGenerationModelSelection: flash,
      });
      const { briefs, questions, detached, deadline, prompts } = yield* setup({
        accountFailure: { kind: "usage_limit" },
        settings,
      });
      // The account being left is never asked, and its session goes at once.
      assert.isTrue(yield* Deferred.isDone(detached));
      assert.lengthOf(yield* Ref.get(questions), 0);
      const brief = yield* briefs.take({
        threadId,
        targetInstanceId: gemini,
        deadlineMs: deadline,
      });
      assert.deepEqual(
        (yield* Ref.get(prompts)).map((entry) => entry.model),
        ["gemini-3.8-flash"],
      );
      assert.deepEqual(Option.getOrUndefined(brief), {
        providerInstanceId: gemini,
        model: "gemini-3.8-flash",
        text: briefText,
      });
    }).pipe(Effect.scoped),
  );
});

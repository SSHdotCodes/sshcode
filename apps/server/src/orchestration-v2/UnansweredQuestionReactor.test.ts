import {
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  questionWaitsForUser,
  recommendedOptions,
  unansweredQuestionAnswers,
  UnansweredQuestionReactor,
  layer as unansweredQuestionReactorLayer,
} from "./UnansweredQuestionReactor.ts";

const question = (
  overrides: Partial<OrchestrationV2UserInputQuestion> = {},
): OrchestrationV2UserInputQuestion => ({
  id: "q1",
  header: "Idle updates",
  question: "When a subagent sends an update while its parent is idle, what should happen?",
  options: [
    { label: "Keep holding", description: "No change." },
    { label: "Wake after 2 minutes (Recommended)", description: "Batch, then wake." },
    { label: "Wake right away", description: "Every update." },
  ],
  ...overrides,
});

describe("recommendedOptions", () => {
  it("takes the option marked recommended, else the first", () => {
    assert.deepEqual(
      recommendedOptions(question()).map((option) => option.label),
      ["Wake after 2 minutes (Recommended)"],
    );
    assert.deepEqual(
      recommendedOptions(
        question({
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        }),
      ).map((option) => option.label),
      ["A"],
    );
  });

  it("keeps every marked option of a multi-choice question", () => {
    const options = recommendedOptions(
      question({
        multiSelect: true,
        options: [
          { label: "Lint (Recommended)", description: "l" },
          { label: "Docs", description: "d" },
          { label: "Tests (recommended)", description: "t" },
        ],
      }),
    );
    assert.deepEqual(
      options.map((option) => option.label),
      ["Lint (Recommended)", "Tests (recommended)"],
    );
  });
});

describe("questionWaitsForUser", () => {
  it("waits only on questions the agent marked important", () => {
    assert.isTrue(questionWaitsForUser(question({ waitsForUser: true })));
    assert.isFalse(questionWaitsForUser(question()));
  });
});

describe("unansweredQuestionAnswers", () => {
  it("tells the agent no one answered when the answer can be text", () => {
    const expected = {
      q1: "No answer after 10 minutes, so going with the recommended option: Wake after 2 minutes (Recommended)",
    };
    assert.deepEqual(unansweredQuestionAnswers([question()], "message"), expected);
    assert.deepEqual(unansweredQuestionAnswers([question()], "live"), expected);
  });

  it("sends exact option values to a closed or multi-choice native question", () => {
    assert.deepEqual(
      unansweredQuestionAnswers(
        [
          question({
            allowCustomAnswer: false,
            options: [
              { label: "Yes (Recommended)", description: "y", value: "yes" },
              { label: "No", description: "n", value: "no" },
            ],
          }),
        ],
        "live",
      ),
      { q1: "yes" },
    );
    assert.deepEqual(
      unansweredQuestionAnswers(
        [
          question({
            multiSelect: true,
            options: [
              { label: "Lint (Recommended)", description: "l" },
              { label: "Tests (Recommended)", description: "t" },
            ],
          }),
        ],
        "live",
      ),
      { q1: ["Lint (Recommended)", "Tests (Recommended)"] },
    );
  });

  it("lets the agent judge a free-text question, and gives up on one it cannot answer", () => {
    assert.deepEqual(unansweredQuestionAnswers([question({ options: [] })], "message"), {
      q1: "No answer after 10 minutes. Use your best judgment and carry on.",
    });
    assert.isNull(
      unansweredQuestionAnswers([question({ options: [], allowCustomAnswer: false })], "live"),
    );
  });
});

describe("UnansweredQuestionReactor", () => {
  const threadId = ThreadId.make("thread:unanswered");

  const pendingRequest = (id: string, createdAtMs: number): OrchestrationV2RuntimeRequest =>
    ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(`node:${id}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: DateTime.makeUnsafe(createdAtMs),
      resolvedAt: null,
    }) as OrchestrationV2RuntimeRequest;

  const harness = (
    requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
    questionsByRequest: Readonly<
      Record<string, ReadonlyArray<OrchestrationV2UserInputQuestion>>
    > = {},
  ) =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [
              ...commands,
              command as OrchestrationV2Command,
            ]).pipe(Effect.as({ sequence: 1 } as never)),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.never,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: requests,
            } as unknown as OrchestrationV2ThreadProjection),
          getRuntimeResponseContext: (_threadId, requestId) =>
            Effect.succeed({
              request: requests.find((request) => request.id === requestId),
              node: undefined,
              session: undefined,
              item: {
                type: "user_input_request",
                requestId,
                questions: questionsByRequest[requestId] ?? [question()],
              } as never,
            }),
        }),
      );
      return {
        dispatched,
        layer: unansweredQuestionReactorLayer.pipe(Layer.provide(dependencies)),
      };
    });

  it.effect("answers a question still pending after ten minutes with the recommendation", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = yield* harness([
        pendingRequest("request:fresh", 0),
        // Pending since well before the server started: left for the user.
        pendingRequest("request:stale", -2 * 60 * 60 * 1000),
      ]);
      yield* Effect.gen(function* () {
        const reactor = yield* UnansweredQuestionReactor;
        yield* reactor.start();
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });

        yield* TestClock.adjust("9 minutes");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        assert.deepEqual(yield* Ref.get(dispatched), []);

        yield* TestClock.adjust("1 minute");
        yield* Effect.repeat(Ref.get(dispatched).pipe(Effect.map((commands) => commands.length)), {
          until: (count) => count === 1,
        });
        assert.deepEqual((yield* Ref.get(dispatched))[0], {
          type: "runtime-request.respond",
          commandId: "server:unanswered-question:request:fresh",
          threadId,
          requestId: "request:fresh",
          answers: {
            q1: "No answer after 10 minutes, so going with the recommended option: Wake after 2 minutes (Recommended)",
          },
        } as unknown as OrchestrationV2Command);

        yield* TestClock.adjust("2 hours");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        assert.equal((yield* Ref.get(dispatched)).length, 1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
  it.effect("leaves a question that waits for the user pending", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = yield* harness([pendingRequest("request:important", 0)], {
        "request:important": [question({ waitsForUser: true })],
      });
      yield* Effect.gen(function* () {
        const reactor = yield* UnansweredQuestionReactor;
        yield* reactor.start();
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        yield* TestClock.adjust("1 hour");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});

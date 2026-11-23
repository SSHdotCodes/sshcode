import {
  CommandId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const QUESTION_ANSWER_WAIT_MINUTES = 10;

/** How long an agent's question waits for the user before the agent goes with its recommendation. */
export const QUESTION_ANSWER_WAIT = Duration.minutes(QUESTION_ANSWER_WAIT_MINUTES);

const WAIT_LABEL = `${QUESTION_ANSWER_WAIT_MINUTES} minutes`;

/**
 * A question still pending this long past the wait when the server starts
 * (it was off or the Mac slept) stays for the user: deciding hours late on
 * their behalf would restart work they may have moved on from.
 */
const STALE_AFTER_WAIT = Duration.hours(1);

const RECOMMENDED_LABEL = /\(recommended\)\s*$/i;

/** Whether a question must wait for the user: the agent marked it important. */
export function questionWaitsForUser(question: OrchestrationV2UserInputQuestion): boolean {
  return question.waitsForUser === true;
}

type QuestionOption = OrchestrationV2UserInputQuestion["options"][number];

/** The options the agent marked "(Recommended)", or its first option when it marked none. */
export function recommendedOptions(
  question: OrchestrationV2UserInputQuestion,
): ReadonlyArray<QuestionOption> {
  const marked = question.options.filter((option) => RECOMMENDED_LABEL.test(option.label));
  if (marked.length === 0) return question.options.slice(0, 1);
  return question.multiSelect === true ? marked : marked.slice(0, 1);
}

/**
 * Answers each question as if the user picked the recommended option. Where an
 * answer can be free text it says no one answered, so the agent knows it chose
 * for itself; a native multi-choice or closed question gets exactly the option
 * values its provider expects. Null when a required question has neither an
 * option nor room for text.
 */
export function unansweredQuestionAnswers(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"],
  waitLabel: string = WAIT_LABEL,
): ProviderUserInputAnswers | null {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  for (const question of questions) {
    const options = recommendedOptions(question);
    const takesText = responseCapability === "message" || question.allowCustomAnswer !== false;
    if (options.length === 0) {
      if (takesText) {
        answers[question.id] = `No answer after ${waitLabel}. Use your best judgment and carry on.`;
      } else if (question.required !== false) {
        return null;
      }
      continue;
    }
    if (takesText && (responseCapability === "message" || question.multiSelect !== true)) {
      const labels = options.map((option) => option.label).join(", ");
      answers[question.id] =
        `No answer after ${waitLabel}, so going with the recommended option: ${labels}`;
      continue;
    }
    const values = options.map((option) => option.value ?? option.label);
    answers[question.id] = question.multiSelect === true ? values : values[0]!;
  }
  return answers;
}

/**
 * Answers an agent's question with its recommended option when the user lets
 * it wait {@link QUESTION_ANSWER_WAIT}, so the agent carries on instead of
 * sitting blocked, or idle until someone notices. Covers `ask_user` cards and
 * the providers' own blocking questions alike. Approvals, and questions the
 * agent marked important, are never answered.
 * The answer goes through the same response a client sends, so the card shows
 * it and a later reply from the user arrives as a normal message.
 */
export class UnansweredQuestionReactor extends Context.Service<
  UnansweredQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/UnansweredQuestionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduled = new Set<RuntimeRequestId>();

  const answer = Effect.fnUntraced(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
    const { request, item } = yield* projections.getRuntimeResponseContext(threadId, requestId);
    if (
      request?.status !== "pending" ||
      request.kind !== "user_input" ||
      request.responseCapability.type === "not_resumable" ||
      item?.type !== "user_input_request" ||
      item.questions.some(questionWaitsForUser)
    ) {
      return;
    }
    const answers = unansweredQuestionAnswers(item.questions, request.responseCapability.type);
    if (answers === null) return;
    yield* engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`server:unanswered-question:${requestId}`),
      threadId,
      requestId,
      answers,
    });
  });

  const schedule = Effect.fnUntraced(function* (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (request.kind !== "user_input" || request.status !== "pending") return;
    if (scheduled.has(request.id)) return;
    const waited = Duration.millis(
      DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(request.createdAt),
    );
    if (Duration.isGreaterThan(waited, Duration.sum(QUESTION_ANSWER_WAIT, STALE_AFTER_WAIT))) {
      return;
    }
    scheduled.add(request.id);
    const remaining = Duration.max(Duration.subtract(QUESTION_ANSWER_WAIT, waited), Duration.zero);
    yield* Effect.sleep(remaining).pipe(
      Effect.andThen(answer(threadId, request.id)),
      Effect.catchCause((cause) =>
        Effect.logWarning("answering an unanswered question failed", {
          threadId,
          requestId: request.id,
          cause,
        }),
      ),
      Effect.ensuring(Effect.sync(() => scheduled.delete(request.id))),
      Effect.forkScoped,
    );
  });

  const start: UnansweredQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Questions up to this cursor come from the projection, later ones from the tail.
        // Runtime recovery already lists every thread with a pending request.
        const afterSequence = yield* eventSink.latestSequence();
        const threadIds = yield* projections.getRecoveryThreadIds("runtime");
        yield* Effect.forEach(
          threadIds,
          (threadId) =>
            projections.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
              Effect.flatMap(({ runtimeRequests }) =>
                Effect.forEach(runtimeRequests, (request) => schedule(threadId, request), {
                  discard: true,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("reading a thread's pending questions failed", {
                  threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
        yield* Stream.runForEach(
          eventSink.stream({ afterSequence, eventType: "runtime-request.updated" }),
          (stored) =>
            stored.event.type === "runtime-request.updated"
              ? schedule(stored.event.threadId, stored.event.payload)
              : Effect.void,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("unanswered question event stream failed", { cause }),
        ),
      ),
    );

  return { start } satisfies UnansweredQuestionReactor["Service"];
});

export const layer = Layer.effect(UnansweredQuestionReactor, make);

import {
  activeProviderFailure,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  rememberedAccountFailure,
  type ModelSelection,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  handoffMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { isHandoffSourceRun } from "./ContextHandoffService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export type HandoffBrief = NonNullable<OrchestrationV2ContextHandoff["brief"]>;

/** Agent-facing: what the outgoing model is asked when the user switches models. */
export const HANDOFF_BRIEF_PROMPT = `The user is switching this chat to another model. That model will not see this conversation: it gets the recent messages and a brief from you. Write the brief now, at most about 1,500 words of Markdown, under these headings.

## Goal and requirements
What the user asked for, quoting their own words for requirements, constraints and preferences.
## Where things stand
## Decisions and why
## Done and verified
What is finished, and how it was checked.
## Open problems
## Next step
The one thing to do next, concretely.
## Pitfalls
What failed or misled you, and what to avoid.
## Key files
Paths, with a few words on each.

Be specific: names, paths, commands, numbers. Write "none" under a heading with nothing to report. Write only the brief.`;

/** Agent-facing: what a chosen model is asked, with the chat's transcript, to write the brief. */
export const handoffBriefFromTranscriptPrompt = (transcript: string) =>
  `${HANDOFF_BRIEF_PROMPT.replace(
    "That model will not see this conversation: it gets the recent messages and a brief from you. Write the brief now,",
    "That model gets the recent messages and the brief you write from the transcript below. Write the brief,",
  )}

<transcript>
${transcript}
</transcript>`;

// The old session is kept open this long for its answer; a longer one is abandoned.
const BRIEF_TIMEOUT = Duration.minutes(2);
// A chosen model reading a long transcript takes longer than the model being left.
const TRANSCRIPT_BRIEF_TIMEOUT = Duration.minutes(3);
// How long a send waits for a chosen model's brief: it started at the switch, so mostly done.
const TRANSCRIPT_BRIEF_WAIT_MS = 90_000;
// A chosen model reads about half its window of transcript (4 bytes a token), within these.
const MIN_TRANSCRIPT_BYTES = 64_000;
const MAX_TRANSCRIPT_BYTES = 1_000_000;
const DEFAULT_WRITER_WINDOW = 200_000;
// An answer shorter than this is not a brief (a refusal, an error line).
const MIN_BRIEF_LENGTH = 200;
// The prompt's headings; an answer with fewer of them is not a brief (an API error, a limit
// notice, a refusal), however long.
const BRIEF_HEADINGS = [
  "goal and requirements",
  "where things stand",
  "decisions and why",
  "done and verified",
  "open problems",
  "next step",
  "pitfalls",
  "key files",
];
const MIN_BRIEF_HEADINGS = 4;

/** Whether a side answer is the brief the prompt asked for. */
export function isHandoffBrief(answer: {
  readonly response: string;
  readonly synthetic?: boolean;
}) {
  if (answer.synthetic === true) return false;
  const text = answer.response.trim();
  if (text.length < MIN_BRIEF_LENGTH) return false;
  const headings = new Set(
    [...text.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((match) => match[1]!.toLowerCase()),
  );
  const found = BRIEF_HEADINGS.filter((heading) =>
    [...headings].some((line) => line.startsWith(heading)),
  );
  return found.length >= MIN_BRIEF_HEADINGS;
}
// A brief nobody sent a message for is dropped after this long.
const BRIEF_RETENTION_MS = 60 * 60 * 1_000;

interface Entry {
  readonly targetInstanceId: ProviderInstanceId;
  /** Who writes it (`writerKey`); a later change of setting asks again. */
  readonly writer: string;
  readonly result: Deferred.Deferred<Option.Option<HandoffBrief>>;
  readonly fiber: Fiber.Fiber<void>;
  /** Runs the deferred detach once, whether the brief finished, failed or never started. */
  readonly release: Effect.Effect<void>;
  readonly requestedAtMs: number;
  /** Written from the transcript by a one-shot run, which takes longer than a live session. */
  readonly transcript: boolean;
}

/** A brief being written: through the live session being left, or from the transcript. */
interface BriefWrite {
  readonly write: Effect.Effect<Option.Option<HandoffBrief>>;
  readonly transcript: boolean;
}

export interface HandoffBriefServiceShape {
  /**
   * Asks the outgoing session for a brief in the background, then runs `detach`. Runs `detach`
   * now when the session is gone or cannot answer a side question. Replaces the thread's
   * earlier brief.
   */
  readonly requestThenDetach: <E>(input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly targetInstanceId: ProviderInstanceId;
    readonly detach: Effect.Effect<void, E>;
  }) => Effect.Effect<void, E>;
  /**
   * Drops a brief written for another target, after its session is detached. Runs before a
   * turn opens a session, so a selection that went back to the outgoing provider cannot be
   * detached under its new turn.
   */
  readonly settle: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void>;
  /**
   * The brief for this target, waiting for it until `deadlineMs` (longer for a chosen model,
   * which reads the whole transcript). Follows the settings as they are now: off hands over
   * nothing, a writer changed since the switch is asked here, and with nothing asked at the
   * switch (it came during a turn) the model being left is asked if its session is still up.
   * Consumed either way.
   */
  readonly take: (input: {
    readonly threadId: ThreadId;
    readonly targetInstanceId: ProviderInstanceId;
    readonly deadlineMs: number;
  }) => Effect.Effect<Option.Option<HandoffBrief>>;
}

export class HandoffBriefService extends Context.Service<
  HandoffBriefService,
  HandoffBriefServiceShape
>()("t3/orchestration-v2/HandoffBriefService") {}

export const layer: Layer.Layer<
  HandoffBriefService,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  HandoffBriefService,
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    // Knows when the outgoing account is out of usage; absent in tests.
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    // Who writes the brief, and a chosen writer's runner; absent in tests (the model being left).
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const textGeneration = yield* Effect.serviceOption(TextGeneration.TextGeneration);
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const scope = yield* Effect.scope;
    const entries = yield* Ref.make(new Map<ThreadId, Entry>());

    const writerSetting = Effect.gen(function* () {
      const fallback = { enabled: true, model: null, textGeneration: null };
      if (Option.isNone(serverSettings)) return fallback;
      const settings = yield* serverSettings.value.getSettings.pipe(Effect.option);
      if (Option.isNone(settings)) return fallback;
      return {
        enabled: settings.value.handoffBriefEnabled,
        model: settings.value.handoffBriefModelSelection,
        textGeneration: settings.value.textGenerationModelSelection,
      };
    });
    const writerKey = (model: ModelSelection | null) =>
      model === null ? "outgoing" : `${model.instanceId}\u0000${model.model}`;

    const end = (entry: Entry) => Fiber.interrupt(entry.fiber).pipe(Effect.andThen(entry.release));
    // Awaiting the detach keeps it ahead of the session a turn opens next.
    const remove = (threadId: ThreadId, keep?: (entry: Entry) => boolean) =>
      Ref.modify(entries, (current) => {
        const entry = current.get(threadId);
        if (entry === undefined || keep?.(entry) === true) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(threadId);
        return [entry, next] as const;
      }).pipe(Effect.flatMap((entry) => (entry === undefined ? Effect.void : end(entry))));

    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const stale = [...(yield* Ref.get(entries)).entries()].filter(
        ([, entry]) => now - entry.requestedAtMs > BRIEF_RETENTION_MS,
      );
      yield* Effect.forEach(stale, ([threadId]) => remove(threadId), { discard: true });
    });

    /** Starts writing a brief in the background and records it for the thread's next send. */
    const start = (input: {
      readonly threadId: ThreadId;
      readonly targetInstanceId: ProviderInstanceId;
      readonly writer: string;
      readonly write: BriefWrite;
      readonly release: Effect.Effect<void>;
    }) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<Option.Option<HandoffBrief>>();
        const fiber = yield* input.write.write.pipe(
          Effect.tap((value) =>
            Effect.logInfo("orchestration-v2.handoff-brief.finished", {
              threadId: input.threadId,
              writer: input.writer === "outgoing" ? "outgoing" : "chosen",
              written: Option.isSome(value),
              characters: Option.match(value, { onNone: () => 0, onSome: (b) => b.text.length }),
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.handoff-brief.failed", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.as(Option.none<HandoffBrief>())),
          ),
          Effect.flatMap((value) => Deferred.succeed(result, value)),
          Effect.ensuring(Deferred.succeed(result, Option.none())),
          Effect.ensuring(input.release),
          Effect.asVoid,
          Effect.forkIn(scope, { startImmediately: true }),
        );
        const entry: Entry = {
          targetInstanceId: input.targetInstanceId,
          writer: input.writer,
          result,
          fiber,
          release: input.release,
          requestedAtMs: yield* Clock.currentTimeMillis,
          transcript: input.write.transcript,
        };
        yield* Ref.update(entries, (current) => new Map(current).set(input.threadId, entry));
        yield* Effect.logInfo("orchestration-v2.handoff-brief.requested", {
          threadId: input.threadId,
          targetInstanceId: input.targetInstanceId,
          writer: input.writer === "outgoing" ? "outgoing" : "chosen",
        });
        return entry;
      });

    /** An account out of usage or signed out: it cannot write one. */
    const accountFailure = (providerInstanceId: ProviderInstanceId, model: string) =>
      Option.isNone(providerRegistry)
        ? Effect.succeed(null)
        : Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return yield* providerRegistry.value.getProviders.pipe(
              Effect.map((providers) => {
                const provider = providers.find(
                  (candidate) => candidate.instanceId === providerInstanceId,
                );
                return provider === undefined
                  ? null
                  : (activeProviderFailure(provider, now, model) ??
                      rememberedAccountFailure(provider));
              }),
              Effect.orElseSucceed(() => null),
            );
          });
    /** A model that can write a brief from the transcript right now. */
    const canWriteFromTranscript = (selection: ModelSelection) =>
      Effect.gen(function* () {
        if ((yield* accountFailure(selection.instanceId, selection.model)) !== null) return false;
        if (Option.isNone(providerRegistry)) return true;
        const providers = yield* providerRegistry.value.getProviders.pipe(
          Effect.orElseSucceed(() => []),
        );
        const provider = providers.find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );
        return (
          provider !== undefined &&
          provider.enabled &&
          isProviderAvailable(provider) &&
          isProviderTextGenerationCapable(provider)
        );
      });

    /**
     * The model being left writes the brief: through its live session (the root provider thread
     * on another instance than the target, and the run it last answered in), or from the
     * transcript when no session is live. When its account is out of usage (often why the user
     * is switching) the text generation model writes it from the transcript instead.
     * `providerSessionId` pins the session a switch is detaching.
     */
    const outgoing = (input: {
      readonly threadId: ThreadId;
      readonly targetInstanceId: ProviderInstanceId;
      readonly providerSessionId?: ProviderSessionId;
      readonly textGeneration: ModelSelection | null;
    }) =>
      Effect.gen(function* () {
        const records = yield* projectionStore
          .getThreadRecords(input.threadId, ["providerThreads", "runs"])
          .pipe(Effect.option);
        if (Option.isNone(records)) return undefined;
        const sourceRun: OrchestrationV2Run | undefined = records.value.runs.findLast(
          (run) =>
            isHandoffSourceRun(run) &&
            run.providerInstanceId !== input.targetInstanceId &&
            (input.providerSessionId === undefined ||
              records.value.providerThreads.some(
                (thread) =>
                  thread.providerSessionId === input.providerSessionId &&
                  thread.providerInstanceId === run.providerInstanceId,
              )),
        );
        if (sourceRun === undefined) return undefined;
        const leaving = sourceRun.modelSelection;
        const failure = yield* accountFailure(sourceRun.providerInstanceId, leaving.model);
        if (failure !== null) {
          yield* Effect.logInfo("orchestration-v2.handoff-brief.leaving-unavailable", {
            threadId: input.threadId,
            reason: failure.kind,
          });
        }
        const providerThread: OrchestrationV2ProviderThread | undefined =
          failure !== null
            ? undefined
            : records.value.providerThreads.find(
                (thread) =>
                  thread.providerInstanceId === sourceRun.providerInstanceId &&
                  thread.ownerNodeId === null &&
                  thread.nativeThreadRef !== null &&
                  thread.providerSessionId !== null &&
                  (input.providerSessionId === undefined ||
                    thread.providerSessionId === input.providerSessionId),
              );
        const runtime =
          providerThread?.providerSessionId == null
            ? Option.none()
            : yield* providerSessions
                .get(providerThread.providerSessionId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
        const ask = Option.isSome(runtime) ? runtime.value.askSideQuestion : undefined;
        if (providerThread !== undefined && ask !== undefined) {
          const write = ask({ providerThread, question: HANDOFF_BRIEF_PROMPT, history: [] }).pipe(
            Effect.timeoutOption(BRIEF_TIMEOUT),
            Effect.map((answer) =>
              Option.flatten(answer).pipe(
                Option.filter(isHandoffBrief),
                Option.map((value): HandoffBrief => ({
                  providerInstanceId: providerThread.providerInstanceId,
                  model: leaving.model,
                  text: value.response.trim(),
                })),
              ),
            ),
            Effect.orElseSucceed(() => Option.none<HandoffBrief>()),
          );
          return { write, transcript: false } satisfies BriefWrite;
        }
        const writer =
          failure === null && (yield* canWriteFromTranscript(leaving))
            ? leaving
            : input.textGeneration !== null && (yield* canWriteFromTranscript(input.textGeneration))
              ? input.textGeneration
              : undefined;
        if (writer === undefined) {
          yield* Effect.logInfo("orchestration-v2.handoff-brief.skipped", {
            threadId: input.threadId,
            reason: failure?.kind ?? "no-writer",
          });
          return undefined;
        }
        return {
          write: fromTranscript(input.threadId, writer),
          transcript: true,
        } satisfies BriefWrite;
      });

    /** A chosen model writing the brief from the chat's transcript, read on the reader. */
    const fromTranscript = (threadId: ThreadId, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        const rewrite = Option.isNone(textGeneration)
          ? undefined
          : textGeneration.value.rewriteProse;
        if (rewrite === undefined || Option.isNone(config)) return Option.none();
        const records = yield* projectionStore
          .getThreadRecords(threadId, ["turnItems"])
          .pipe(NodeSqliteClient.readOnly);
        const messages = records.turnItems.flatMap((item) => {
          const message = handoffMessage(item);
          return message === null ? [] : [message];
        });
        if (messages.length === 0) return Option.none();
        const window =
          (yield* (
            projectionStore.getReportedContextWindow?.(modelSelection.instanceId) ??
            Effect.succeed(undefined)
          ).pipe(Effect.orElseSucceed(() => undefined))) ?? DEFAULT_WRITER_WINDOW;
        const selected = selectHistory({
          messages,
          coverage: "The chat so far, oldest first.",
          budget: Math.max(MIN_TRANSCRIPT_BYTES, Math.min(MAX_TRANSCRIPT_BYTES, window * 2)),
        });
        const { output } = yield* rewrite({
          cwd: config.value.stateDir,
          prompt: handoffBriefFromTranscriptPrompt(
            renderHistory(selected.messages, selected.context),
          ),
          modelSelection,
        });
        return isHandoffBrief({ response: output })
          ? Option.some<HandoffBrief>({
              providerInstanceId: modelSelection.instanceId,
              model: modelSelection.model,
              text: output.trim(),
            })
          : Option.none<HandoffBrief>();
      }).pipe(
        Effect.timeoutOption(TRANSCRIPT_BRIEF_TIMEOUT),
        Effect.map(Option.flatten),
        Effect.orElseSucceed(() => Option.none<HandoffBrief>()),
      );

    const chosenWrite = (threadId: ThreadId, selection: ModelSelection) =>
      Effect.gen(function* () {
        if (!(yield* canWriteFromTranscript(selection))) {
          yield* Effect.logInfo("orchestration-v2.handoff-brief.skipped", {
            threadId,
            reason: "chosen-unavailable",
          });
          return undefined;
        }
        return {
          write: fromTranscript(threadId, selection),
          transcript: true,
        } satisfies BriefWrite;
      });

    const requestThenDetach: HandoffBriefServiceShape["requestThenDetach"] = (input) =>
      Effect.gen(function* () {
        yield* prune;
        yield* remove(input.threadId);
        const setting = yield* writerSetting;
        if (!setting.enabled) return yield* input.detach;
        if (setting.model !== null) {
          // A chosen model reads the transcript; the session being left is not needed.
          yield* input.detach;
          const write = yield* chosenWrite(input.threadId, setting.model);
          if (write === undefined) return;
          yield* start({
            threadId: input.threadId,
            targetInstanceId: input.targetInstanceId,
            writer: writerKey(setting.model),
            write,
            release: Effect.void,
          });
          return;
        }
        const write = yield* outgoing({ ...input, textGeneration: setting.textGeneration });
        if (write === undefined) return yield* input.detach;
        if (write.transcript) {
          // Transcript-based fallback does not need the session being left.
          yield* input.detach;
          yield* start({
            threadId: input.threadId,
            targetInstanceId: input.targetInstanceId,
            writer: "outgoing",
            write,
            release: Effect.void,
          });
          return;
        }
        const release = yield* Effect.cached(
          input.detach.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.handoff-brief.detach-failed", {
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          ),
        );
        yield* start({
          threadId: input.threadId,
          targetInstanceId: input.targetInstanceId,
          writer: "outgoing",
          write,
          release,
        });
      });

    const settle: HandoffBriefServiceShape["settle"] = (input) =>
      remove(input.threadId, (entry) => entry.targetInstanceId === input.instanceId);

    const take: HandoffBriefServiceShape["take"] = (input) =>
      Effect.gen(function* () {
        const setting = yield* writerSetting;
        const writer = writerKey(setting.model);
        let entry = (yield* Ref.get(entries)).get(input.threadId);
        if (
          entry !== undefined &&
          (!setting.enabled ||
            entry.targetInstanceId !== input.targetInstanceId ||
            entry.writer !== writer)
        ) {
          yield* remove(input.threadId);
          entry = undefined;
        }
        if (!setting.enabled) return Option.none();
        if (entry === undefined) {
          // Nothing asked at the switch, or a writer chosen since: ask now.
          const write: BriefWrite | undefined =
            setting.model !== null
              ? yield* chosenWrite(input.threadId, setting.model)
              : yield* outgoing({ ...input, textGeneration: setting.textGeneration });
          if (write === undefined) return Option.none();
          entry = yield* start({
            threadId: input.threadId,
            targetInstanceId: input.targetInstanceId,
            writer,
            write,
            release: Effect.void,
          });
        }
        const now = yield* Clock.currentTimeMillis;
        const deadlineMs = entry.transcript
          ? Math.max(input.deadlineMs, entry.requestedAtMs + TRANSCRIPT_BRIEF_WAIT_MS)
          : input.deadlineMs;
        const current = entry;
        const brief = Option.flatten(
          yield* Deferred.await(current.result).pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, deadlineMs - now))),
          ),
        );
        yield* Ref.update(entries, (all) => {
          if (all.get(input.threadId) !== current) return all;
          const next = new Map(all);
          next.delete(input.threadId);
          return next;
        });
        // A brief that missed this delivery has no later one; end it and its session now.
        if (Option.isNone(brief)) yield* end(current).pipe(Effect.forkIn(scope));
        return brief;
      });

    return HandoffBriefService.of({ requestThenDetach, settle, take });
  }),
);

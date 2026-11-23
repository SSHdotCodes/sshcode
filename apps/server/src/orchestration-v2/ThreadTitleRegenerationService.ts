import * as BoxFaces from "../sessionBoxes/boxFaces.ts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  ThreadId,
  isHelperThreadId,
  type ChatAttachment,
  type MessageId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  AUTO_TITLE_COMMAND_PREFIX,
  AUTO_TITLE_WORK_MS,
  autoTitleFor,
  boxTitles,
  subscribeRetitle,
  type RetitleCandidate,
} from "../sessionBoxes/boxNamerCache.ts";
import { faceFromPick, titlePictures } from "../sessionBoxes/boxFaces.ts";
import * as ChatTabs from "../sessionBoxes/chatTabs.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

/**
 * The messages a regenerated title is judged on. Wake-ups from monitors, subagents and
 * restarts are stored as user messages, but they say nothing about what the owner asked
 * for, and in a long chat they outnumber the owner's own messages. A chat whose every
 * user message came from an agent (a subagent's brief) keeps them all.
 */
export function titleContextMessages<
  M extends { readonly role: string; readonly createdBy: string; readonly streaming: boolean },
>(messages: ReadonlyArray<M>): M[] {
  const settled = messages.filter((message) => !message.streaming);
  const written = settled.filter(
    (message) => message.role !== "user" || message.createdBy !== "agent",
  );
  return written.some((message) => message.role === "user") ? written : settled;
}

/**
 * A title is a few words. Each provider allows its text generation three minutes, which
 * with retries left a chat dimmed as "Regenerating title" for nine when a provider hung.
 */
export const TITLE_GENERATION_LIMIT = Duration.minutes(2);

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      // `complete` dispatches thread.title.regeneration.complete, a command
      // the enablement chokepoint never gates; the type stays accurate anyway.
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const chatTabs = Option.getOrElse(
    yield* Effect.serviceOption(ChatTabs.ChatTabs),
    () => ChatTabs.make().store,
  );
  const boxFaces = Option.getOrElse(
    yield* Effect.serviceOption(BoxFaces.BoxFaces),
    () => BoxFaces.make().store,
  );

  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | { readonly type: "complete"; readonly title?: string } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        // Chips are written as their labels, so a chat started from another chat's chip is
        // titled after that chat rather than its link.
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : {
                message: replaceComposerContextReferences(message.text, (chip) => chip.label),
                attachments: message.attachments,
              };
      } else {
        context = formatThreadTitleContext(titleContextMessages(projection.messages));
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      // A chat not yet in a tab (or deliberately in none) is filed in the same reply.
      const offerTabs = !chatTabs.isFiled(input.threadId);
      const result = yield* textGeneration.generateThreadTitle({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        modelSelection: settings.textGenerationModelSelection,
        // The same reply picks the chat's icon from the box pictures.
        pictures: titlePictures(),
        ...(offerTabs ? { tabs: chatTabs.promptTabs() } : {}),
      });
      const face = result.icon === undefined ? null : faceFromPick(result.icon);
      if (face !== null) boxFaces.set(input.threadId, face);
      const generatedTitle = result.title.trim();
      // "No tab" for a vague first message waits for the refined title to decide.
      if (offerTabs && result.tab !== undefined && (result.tab !== "" || !result.needsRefinement)) {
        chatTabs.fileByModel({
          threadId: input.threadId,
          tab: result.tab,
          title: generatedTitle === "New thread" ? projection.thread.title : generatedTitle,
          now: yield* Clock.currentTimeMillis,
        });
      }
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.timeoutOrElse({
        duration: TITLE_GENERATION_LIMIT,
        orElse: () =>
          Effect.logWarning("Thread title generation took too long", {
            threadId: input.threadId,
            requestId: input.requestId,
          }).pipe(Effect.as({ type: "complete" as const })),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
  });

  // Titles follow the work: when the local box namer reads that a chat has moved on from
  // its title and stayed there, the chat takes what it is on now as its title.
  const retitle = (candidate: RetitleCandidate) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(ThreadId.make(candidate.threadId), [
        "runs",
      ]);
      const latest = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const title = autoTitleFor({
        candidate,
        thread: projection.thread,
        latestRun:
          latest === undefined
            ? null
            : {
                startedAtMs:
                  latest.startedAt === null ? null : DateTime.toEpochMillis(latest.startedAt),
                endedAtMs:
                  latest.completedAt === null ? null : DateTime.toEpochMillis(latest.completedAt),
              },
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (title === null) return false;
      boxTitles.retitled(candidate.requestId);
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${AUTO_TITLE_COMMAND_PREFIX}${candidate.requestId}`),
        threadId: projection.thread.id,
        title,
      });
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Could not retitle a chat.", {
              threadId: candidate.threadId,
              cause,
            }).pipe(Effect.as(false)),
      ),
    );
  // A request the next one agrees with retitles at once; a single one once the agent has
  // worked on it a while, checked a few times as the work goes on.
  const followUp = (candidate: RetitleCandidate) =>
    candidate.settled
      ? retitle(candidate)
      : retitle(candidate).pipe(
          Effect.delay(Duration.millis(AUTO_TITLE_WORK_MS)),
          Effect.repeat({
            times: 3,
            until: (done) => done,
            schedule: Schedule.spaced("3 minutes"),
          }),
        );
  // Subscribed while the service is built, so no candidate is missed before the loop runs.
  const candidates = yield* Queue.unbounded<RetitleCandidate>();
  yield* Effect.acquireRelease(
    Effect.sync(() => subscribeRetitle((candidate) => Queue.offerUnsafe(candidates, candidate))),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Queue.take(candidates).pipe(
    Effect.flatMap((candidate) => followUp(candidate).pipe(Effect.forkScoped)),
    Effect.forever,
    Effect.forkScoped,
  );

  // Once: file the chats there were before tabs, from their titles, a batch per reply.
  const sortExistingChats = Effect.gen(function* () {
    if (chatTabs.existingSorted()) return;
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    const unfiled = snapshot.threads
      .filter(
        (thread) =>
          thread.lineage.parentThreadId === null &&
          !isHelperThreadId(thread.id) &&
          thread.title.trim().length > 0 &&
          thread.title !== "New thread" &&
          !chatTabs.isFiled(thread.id),
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )
      .slice(0, EXISTING_SORT_LIMIT);
    if (unfiled.length === 0) return chatTabs.markExistingSorted();
    // Titles run in a project's folder; any will do for a list of titles.
    const project = yield* projects.get(unfiled[0]!.projectId);
    if (Option.isNone(project)) return;
    const modelSelection = (yield* serverSettings.getSettings).textGenerationModelSelection;
    for (let start = 0; start < unfiled.length; start += EXISTING_SORT_BATCH) {
      const batch = unfiled.slice(start, start + EXISTING_SORT_BATCH);
      const result = yield* textGeneration.generateChatTabs({
        cwd: project.value.workspaceRoot,
        modelSelection,
        tabs: chatTabs.promptTabs(),
        chats: batch.map((thread, index) => ({ id: `c${index + 1}`, title: thread.title })),
      });
      const tabById = new Map(result.assignments.map((entry) => [entry.id, entry.tab]));
      const now = yield* Clock.currentTimeMillis;
      batch.forEach((thread, index) => {
        const tab = tabById.get(`c${index + 1}`);
        if (tab !== undefined)
          chatTabs.fileByModel({ threadId: thread.id, tab, title: thread.title, now });
      });
    }
    chatTabs.markExistingSorted();
    yield* Effect.logInfo("Sorted existing chats into tabs.", { chats: unfiled.length });
  }).pipe(
    Effect.delay(EXISTING_SORT_DELAY),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Could not sort existing chats into tabs; trying at next start.", {
            cause,
          }),
    ),
  );
  yield* Effect.forkScoped(sortExistingChats);

  return ThreadTitleRegenerationService.of({ execute });
});

/** The one-off sort waits out startup, then files this many chats, newest first. */
const EXISTING_SORT_DELAY = Duration.seconds(45);
const EXISTING_SORT_LIMIT = 400;
const EXISTING_SORT_BATCH = 50;

export const layer = Layer.effect(ThreadTitleRegenerationService, make);

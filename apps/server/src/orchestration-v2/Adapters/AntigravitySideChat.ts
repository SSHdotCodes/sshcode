/**
 * Antigravity's `/btw` side question.
 *
 * agy's `/btw` lives in its terminal UI only. The TUI branches the parent
 * conversation into a side conversation through its backend
 * (`ServerBackend.StartSideQuestion`); `agy acp` offers no method for that
 * (every candidate extension name answers -32601, and the ACP server handles
 * only initialize, authenticate, session new/load/list/close/cancel/prompt and
 * the set_* calls). A `/btw …` prompt is an ordinary prompt there: idle, it is
 * a turn written into the main history; mid-turn, `agy acp` 1.5 takes it as a
 * steer that ends the running prompt. Print mode refuses `/btw` outright.
 *
 * So each question runs in its own short-lived `agy acp` process: a fresh
 * session in an empty temporary folder, on the thread's model, handed the
 * thread's transcript as SSHCode recorded it (the turn in flight included),
 * the earlier questions of this side chat, and agy's own side-question
 * framing. It never touches the main process, so the running turn is not
 * stopped or steered, and nothing reaches the main transcript. Every
 * permission, question, file, terminal and extension request is refused. The
 * side session's files are deleted once its process exits.
 *
 * @module AntigravitySideChat
 */
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ModelSelection,
  ProviderDriverKind,
  ProviderSetupError,
  type SideChatActivity,
} from "@t3tools/contracts";
import { acpUnfinishedStopMessage } from "@t3tools/provider-acp/server/adapter";
import { renderHistory, selectHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { applyAntigravityAcpModelSelection } from "../../provider/acp/AntigravityAcpSupport.ts";
import { antigravityPromptStopFailure } from "../../provider/acp/AntigravityProtocol.ts";
import {
  removeAntigravityCliSessionFiles,
  removeAntigravitySessionFiles,
} from "../../provider/acp/AntigravitySessionFiles.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../../provider/antigravityAuthSupport.ts";
import type { AntigravityAdapterV2Options } from "./AntigravityAdapterV2.ts";

const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
/** About 24k tokens of transcript per question; selection keeps the newest and the asks. */
const SIDE_QUESTION_HISTORY_BYTES = 96_000;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

/** Agent-facing: agy's own side-question framing, minus the tools a seeded session must not use. */
export const ANTIGRAVITY_SIDE_QUESTION_GUARDRAIL =
  "Above is the conversation history from the parent conversation; what follows is a side question (/btw) branched from that conversation (including any follow-up messages in this side thread). Answer it concisely from that history. Do not use tools: do not read or edit files, run commands, search, spawn subagents or schedule tasks. If the history does not hold the answer, say so.";

/** The one prompt a side session gets: the thread so far, earlier side questions, the question. */
export function antigravitySideQuestionPrompt(input: {
  readonly transcript: Parameters<typeof selectHistory>[0]["messages"];
  readonly exchanges: ReadonlyArray<ProviderAdapter.ProviderAdapterV2SideQuestionExchange>;
  readonly question: string;
}): string {
  const selected = selectHistory({
    messages: input.transcript,
    coverage: "The main conversation so far, oldest first.",
    budget: SIDE_QUESTION_HISTORY_BYTES,
  });
  return [
    renderHistory(selected.messages, selected.context),
    ANTIGRAVITY_SIDE_QUESTION_GUARDRAIL,
    ...input.exchanges.flatMap((exchange) => [
      `Earlier side question: ${exchange.question}`,
      `Your answer: ${exchange.response}`,
    ]),
    `Side question: ${input.question}`,
  ].join("\n\n");
}

export interface AntigravitySideChatOptions {
  readonly makeRuntime: AntigravityAdapterV2Options["makeRuntime"];
  readonly withProcess: AntigravityAdapterV2Options["withProcess"];
  readonly defaultModel: AntigravityAdapterV2Options["defaultModel"];
  /** The managed runtime's `GEMINI_HOME`, which holds its sessions. */
  readonly profileDirectory: string;
  /** The agy CLI's data directory (`~/.gemini/antigravity-cli`), which holds its sessions. */
  readonly cliDataDirectory: string;
}

const sideQuestionError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ANTIGRAVITY_DRIVER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** Keeps agy's own wording for sign-in, quota and setup failures. */
const sideQuestionFailure = (cause: unknown) =>
  isProviderAdapterError(cause)
    ? cause
    : sideQuestionError(
        isAntigravitySignInRequiredError(cause)
          ? ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE
          : isAcpRequestError(cause) && cause.errorMessage.trim().length > 0
            ? cause.errorMessage.trim()
            : isProviderSetupError(cause)
              ? cause.detail
              : "Antigravity could not answer the side question",
        cause,
      );

/** Turns down a request the way agy's own `/btw` does: deny, and let the model answer without it. */
function denyPermission(
  request: EffectAcpSchema.RequestPermissionRequest,
): EffectAcpSchema.RequestPermissionResponse {
  const reject =
    request.options.find((option) => option.kind === "reject_once") ??
    request.options.find((option) => option.kind === "reject_always");
  return reject === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: reject.optionId } };
}

export const makeAntigravitySideChat = Effect.fn("makeAntigravitySideChat")(function* (
  options: AntigravitySideChatOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** One side session from spawn to deleted files. Streams the answer through `onUpdate`. */
  const answer = (input: {
    readonly modelSelection: ModelSelection;
    readonly text: string;
    readonly onUpdate: (
      update: ProviderAdapter.ProviderAdapterV2SideChatUpdate,
    ) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const processScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
      const session = Effect.gen(function* () {
        // The process is killed first, then its session files go, then this folder.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-btw-" });
        let sessionId: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.all(
            [
              removeAntigravityCliSessionFiles({
                dataDirectory: options.cliDataDirectory,
                sessionId,
              }),
              removeAntigravitySessionFiles({
                profileDirectory: options.profileDirectory,
                sessionId,
                cwd,
              }),
            ],
            { discard: true },
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const runtime = yield* options.makeRuntime({ cwd, mcpServers: [] });
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            event._tag === "EventStreamBarrier"
              ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const refuse = () =>
          Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "Side questions cannot use tools.",
            }),
          );
        yield* runtime.handleRequestPermission((request) =>
          Effect.succeed(denyPermission(request)),
        );
        yield* runtime.handleElicitation(() => Effect.succeed({ action: "decline" as const }));
        yield* runtime.handleReadTextFile(refuse);
        yield* runtime.handleWriteTextFile(refuse);
        yield* runtime.handleCreateTerminal(refuse);
        yield* runtime.handleTerminalOutput(refuse);
        yield* runtime.handleTerminalWaitForExit(refuse);
        yield* runtime.handleTerminalKill(refuse);
        yield* runtime.handleTerminalRelease(refuse);
        yield* runtime.handleUnknownExtRequest(refuse);

        let text = "";
        const tools = new Map<string, string>();
        yield* runtime.handleSessionUpdate((notification) => {
          if (sessionId === undefined || notification.sessionId !== sessionId) return Effect.void;
          const update = notification.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            text += update.content.text;
            return input.onUpdate({ type: "text", text });
          }
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            const label = update.title ?? tools.get(update.toolCallId) ?? "Tool call";
            tools.set(update.toolCallId, label);
            const status: SideChatActivity["status"] =
              update.status === "completed"
                ? "completed"
                : update.status === "failed"
                  ? "failed"
                  : "running";
            return input.onUpdate({
              type: "activity",
              activity: { id: update.toolCallId, label, status },
            });
          }
          return Effect.void;
        });

        const started = yield* runtime.start();
        sessionId = started.sessionId;
        // The CLI's own default mode asks before edits and commands, which are then denied.
        yield* runtime.setMode("default");
        yield* applyAntigravityAcpModelSelection({
          runtime,
          model:
            input.modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL
              ? undefined
              : input.modelSelection.model,
          defaultModel: yield* options.defaultModel,
          mapError: (cause) => cause,
        });
        const result = yield* runtime
          .prompt({ prompt: [{ type: "text", text: input.text }] })
          .pipe(
            Effect.onInterrupt(() =>
              runtime.cancel.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore),
            ),
          );
        if (result.stopReason === "cancelled") {
          return yield* sideQuestionError("Antigravity cancelled the side question");
        }
        if (result.stopReason === "error") {
          if (result.error == null) {
            return yield* sideQuestionError("Antigravity could not answer the side question");
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: result.error.code,
            errorMessage: result.error.message,
            ...(result.error.data === undefined ? {} : { data: result.error.data }),
          });
        }
        const response = text.trim();
        const failure = antigravityPromptStopFailure({
          stopReason: result.stopReason,
          replyText: response,
          now: yield* DateTime.now,
        });
        const unfinished = failure?.message ?? acpUnfinishedStopMessage(result.stopReason);
        if (unfinished !== undefined) return yield* sideQuestionError(unfinished);
        if (response.length === 0) {
          return yield* sideQuestionError("Antigravity returned no answer to the side question");
        }
        return response;
      });
      return yield* options
        .withProcess(Scope.close(processScope, Exit.void), session)
        .pipe(Effect.provideService(Scope.Scope, processScope));
    }).pipe(Effect.scoped, Effect.mapError(sideQuestionFailure));

  const openSideChat: NonNullable<ProviderAdapter.ProviderAdapterV2["Service"]["openSideChat"]> = (
    sideInput,
  ) =>
    Effect.sync(() => {
      // Follow-ups see this chat's earlier questions, as in agy's side thread.
      const exchanges: Array<ProviderAdapter.ProviderAdapterV2SideQuestionExchange> = [];
      return {
        kind: "btw" as const,
        ask: ({ prompt, onUpdate }) =>
          Effect.gen(function* () {
            // Fails once the thread has moved to another account or harness.
            const current = sideInput.current === undefined ? undefined : yield* sideInput.current;
            const transcript =
              sideInput.transcript === undefined ? [] : yield* sideInput.transcript;
            const response = yield* answer({
              modelSelection: current?.modelSelection ?? sideInput.modelSelection,
              text: antigravitySideQuestionPrompt({ transcript, exchanges, question: prompt }),
              onUpdate,
            });
            exchanges.push({ question: prompt, response });
            return response;
          }),
      } satisfies ProviderAdapter.ProviderAdapterV2SideChat;
    });
  return openSideChat;
});

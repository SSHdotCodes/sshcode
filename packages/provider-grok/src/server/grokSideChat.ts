/**
 * Grok's native `/btw` side question.
 *
 * On the stdio agent SSHCode already runs, the call is one ACP extension
 * request, `_x.ai/btw` (canonical `x.ai/btw` when a build registers that
 * name). Params are exactly `{ sessionId, question }`. The agent answers
 * from the live session (`extensions/btw.rs` `handle_btw`) and returns
 * `{ result: { answer } }` on that RPC. It does not stream the answer
 * through `session/update`, and it does not take a `session/prompt` turn.
 *
 * The agent logs the call as an auxiliary side call with
 * `cache_key_forwarded=true` (`session::acp_session::side_call`). Measured
 * on grok 1.0.62 against a throwaway session: a question during a main
 * turn read 18048 of 18096 prompt tokens (0.997), and one after that turn
 * read 18048 of 19604 (0.921). The same session model is used. Nothing
 * here sends `session/prompt`, `session/cancel`, or `session/set_model`.
 *
 * Earlier side questions are not in the request. A follow-up that asked
 * whether it had seen them answered NONE. Each `ask` is one independent
 * question, matching the CLI. The CLI records the exchange in its own
 * `btw_history.jsonl`; the thread transcript stays the main conversation.
 *
 * `AcpSessionRuntime.request` goes straight to the JSON-RPC connection. It
 * does not take the prompt permit, so this call can be in flight beside
 * `session/prompt`. A live probe confirmed the side RPC returned while the
 * main prompt was still running, and that prompt then finished `end_turn`.
 *
 * @module provider-grok/server/grokSideChat
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const GROK_DRIVER = ProviderDriverKind.make("grok");

/**
 * Wire names, underscore alias first. grok 1.0.62 registers `_x.ai/btw`
 * and answers `x.ai/btw` with JSON-RPC -32601.
 */
export const GROK_BTW_METHODS = ["_x.ai/btw", "x.ai/btw"] as const;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** The only fields the native `BtwRequest` needs. Extra fields are not sent. */
export function grokBtwParams(
  sessionId: string,
  question: string,
): { readonly sessionId: string; readonly question: string } {
  return { sessionId, question };
}

function readAnswer(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = Reflect.get(value, "answer");
  return typeof answer === "string" ? answer : null;
}

/**
 * grok 1.0.62 returns `{ result: { answer } }`. A bare `{ answer }` is
 * accepted so a build that flattens the payload still parses.
 */
export function grokBtwAnswer(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const nested = readAnswer(Reflect.get(payload, "result"));
  if (nested !== null) return nested;
  return readAnswer(payload);
}

export interface GrokSideChatTransport {
  /** Null until this process has finished `start`. Then the adopted session id. */
  readonly currentSessionId: Effect.Effect<string | null, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

const grokSideChatTransports = new Set<GrokSideChatTransport>();

const liveSessionDetail = "Grok side questions need the live session";

function protocolError(detail: string, cause?: unknown, payload?: unknown) {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: GROK_DRIVER,
    detail,
    ...(cause === undefined ? {} : { cause }),
    ...(payload === undefined ? {} : { payload }),
  });
}

function protocolErrorFromAcp(cause: EffectAcpErrors.AcpError) {
  const detail =
    isAcpRequestError(cause) && cause.errorMessage.trim().length > 0
      ? cause.errorMessage
      : "Grok could not answer the side question";
  return protocolError(detail, cause);
}

const findLiveGrokSideSession = Effect.fn("findLiveGrokSideSession")(function* (sessionId: string) {
  for (const transport of [...grokSideChatTransports]) {
    const current = yield* transport.currentSessionId.pipe(Effect.option);
    if (Option.isSome(current) && current.value === sessionId) {
      return transport;
    }
  }
  return undefined;
});

/**
 * Remembers a running Grok ACP process so a side question can reuse it.
 * `start` on the returned runtime marks the process live. `loadSession`
 * and `resumeSession` update the id `start` reports, and lookup reads
 * that current id, so a side question is only sent to the session the
 * process is actually on. The entry leaves when the runtime scope closes.
 */
export const bindGrokSideChatRuntime = Effect.fn("bindGrokSideChatRuntime")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
) {
  const ready = yield* Ref.make(false);
  const transport: GrokSideChatTransport = {
    currentSessionId: Ref.get(ready).pipe(
      Effect.flatMap((isReady) =>
        isReady
          ? runtime.start().pipe(Effect.map((result) => result.sessionId))
          : Effect.succeed(null),
      ),
    ),
    request: (method, payload) => runtime.request(method, payload),
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      grokSideChatTransports.add(transport);
    }),
    () =>
      Effect.sync(() => {
        grokSideChatTransports.delete(transport);
      }),
  );
  return {
    ...runtime,
    start: () => runtime.start().pipe(Effect.tap(() => Ref.set(ready, true))),
  };
});

/** One native side question. The question text is sent as itself. */
export const askGrokSideQuestion = Effect.fn("askGrokSideQuestion")(function* (input: {
  readonly request: GrokSideChatTransport["request"];
  readonly sessionId: string;
  readonly question: string;
}) {
  const payload = grokBtwParams(input.sessionId, input.question);
  const response = yield* input.request(GROK_BTW_METHODS[0], payload).pipe(
    Effect.catchIf(
      (cause) => isAcpRequestError(cause) && cause.code === -32601,
      () => input.request(GROK_BTW_METHODS[1], payload),
    ),
    Effect.mapError(protocolErrorFromAcp),
  );
  const answer = grokBtwAnswer(response);
  if (answer === null) {
    return yield* protocolError("Grok side question returned no answer", undefined, response);
  }
  return answer;
});

/**
 * Opens Grok's `/btw` chat for one thread. The chat object does not hold
 * a process: each ask looks up the live runtime again, and fails when
 * that process is gone or has adopted another session. No fork and no
 * resume. Grok's CLI refuses `/btw` with no active session, and a fresh
 * prompt would miss the cache and write a turn.
 */
export const openGrokSideChat: NonNullable<
  ProviderAdapter.ProviderAdapterV2["Service"]["openSideChat"]
> = Effect.fn("GrokAdapterV2.openSideChat")(function* (input) {
  const nativeId = input.providerThread.nativeThreadRef?.nativeId?.trim() ?? "";
  return {
    kind: "btw" as const,
    ask: ({ prompt, onUpdate }) =>
      Effect.gen(function* () {
        if (nativeId.length === 0) {
          return yield* protocolError(liveSessionDetail);
        }
        const transport = yield* findLiveGrokSideSession(nativeId);
        if (transport === undefined) {
          return yield* protocolError(liveSessionDetail);
        }
        const answer = yield* askGrokSideQuestion({
          request: transport.request,
          sessionId: nativeId,
          question: prompt,
        });
        yield* onUpdate({ type: "text", text: answer });
        return answer;
      }),
  } satisfies ProviderAdapter.ProviderAdapterV2SideChat;
});

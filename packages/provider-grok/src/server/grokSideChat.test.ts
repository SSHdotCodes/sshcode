import { sideChatKindForDriver } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";

import { makeGrokAcpAdapterFlavor } from "./adapter.ts";
import {
  GROK_BTW_METHODS,
  askGrokSideQuestion,
  bindGrokSideChatRuntime,
  grokBtwAnswer,
  grokBtwParams,
  openGrokSideChat,
} from "./grokSideChat.ts";

const methodNotFound = new EffectAcpErrors.AcpRequestError({
  code: -32601,
  errorMessage: "Method not found",
});

describe("grok /btw request", () => {
  it.effect("keeps the native params to sessionId and question", () =>
    Effect.sync(() => {
      expect(grokBtwParams("session-1", "What color?")).toEqual({
        sessionId: "session-1",
        question: "What color?",
      });
      expect(Object.keys(grokBtwParams("session-1", "What color?")).sort()).toEqual([
        "question",
        "sessionId",
      ]);
      expect(GROK_BTW_METHODS).toEqual(["_x.ai/btw", "x.ai/btw"]);
    }),
  );

  it.effect("reads the nested answer grok 1.0.62 returns, and a bare answer", () =>
    Effect.sync(() => {
      expect(grokBtwAnswer({ result: { answer: "EARLY" } })).toBe("EARLY");
      expect(grokBtwAnswer({ answer: "PINECONE" })).toBe("PINECONE");
      expect(grokBtwAnswer({ result: { answer: "" } })).toBe("");
      expect(grokBtwAnswer({ result: {} })).toBeNull();
      expect(grokBtwAnswer(null)).toBeNull();
    }),
  );

  it.effect("calls _x.ai/btw and does not fall back when it succeeds", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const answer = yield* askGrokSideQuestion({
        sessionId: "session-1",
        question: "SCHEMA",
        request: (method, payload) => {
          calls.push({ method, payload });
          return Effect.succeed({ result: { answer: "none" } });
        },
      });
      expect(answer).toBe("none");
      expect(calls).toEqual([
        { method: "_x.ai/btw", payload: { sessionId: "session-1", question: "SCHEMA" } },
      ]);
    }),
  );

  it.effect("tries the canonical method only when the alias is missing", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const answer = yield* askGrokSideQuestion({
        sessionId: "session-1",
        question: "SCHEMA",
        request: (method, payload) => {
          calls.push({ method, payload });
          return method === "_x.ai/btw"
            ? Effect.fail(methodNotFound)
            : Effect.succeed({ result: { answer: "from-canonical" } });
        },
      });
      expect(answer).toBe("from-canonical");
      expect(calls.map((call) => call.method)).toEqual(["_x.ai/btw", "x.ai/btw"]);
      expect(calls[0]?.payload).toEqual(calls[1]?.payload);
    }),
  );

  it.effect("does not retry a request the agent rejected", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* askGrokSideQuestion({
        sessionId: "session-1",
        question: "SCHEMA",
        request: (method) => {
          calls.push(method);
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: "invalid params: missing field `question`",
            }),
          );
        },
      }).pipe(Effect.result);
      expect(calls).toEqual(["_x.ai/btw"]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ProviderAdapterProtocolError");
        expect(result.failure.message).toContain("missing field `question`");
      }
    }),
  );

  it.effect("fails when the payload has no answer and does not invent one", () =>
    Effect.gen(function* () {
      const result = yield* askGrokSideQuestion({
        sessionId: "session-1",
        question: "SCHEMA",
        request: () => Effect.succeed({ result: { status: "ok" } }),
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toBe("Grok side question returned no answer");
      }
    }),
  );
});

describe("grok /btw live session", () => {
  const fakeRuntime = (
    sessionIdRef: { current: string },
    calls: Array<{ method: string; payload: unknown }>,
  ) =>
    ({
      start: () =>
        Effect.succeed({
          sessionId: sessionIdRef.current,
        } as AcpSessionRuntime.AcpSessionRuntimeStartResult),
      request: (method: string, payload: unknown) => {
        calls.push({ method, payload });
        if (
          method === "session/prompt" ||
          method === "session/cancel" ||
          method === "session/set_model"
        ) {
          return Effect.die("side question must not touch the main session");
        }
        const question =
          typeof payload === "object" &&
          payload !== null &&
          typeof Reflect.get(payload, "question") === "string"
            ? Reflect.get(payload, "question")
            : "";
        return Effect.succeed({ result: { answer: `answer:${question}` } });
      },
    }) as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

  const sideInput = (nativeId: string | null) =>
    ({
      providerThread: {
        nativeThreadRef: nativeId === null ? null : { nativeId },
      },
    }) as ProviderAdapter.ProviderAdapterV2SideChatInput;

  it.effect("offers the same /btw kind as Claude", () =>
    Effect.sync(() => {
      expect(sideChatKindForDriver("grok")).toBe("btw");
    }),
  );

  it.effect("asks the live process with the raw question and one text update", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const sessionIdRef = { current: "native-1" };
      const flavor = makeGrokAcpAdapterFlavor(
        {
          makeRuntime: () => Effect.succeed(fakeRuntime(sessionIdRef, calls)),
        } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
        "/tmp/grok-side",
      );
      // The flavor's runtime type lists the process spawner. This fake never spawns.
      const runtime = yield* flavor
        .makeRuntime({} as AcpAdapterV2RuntimeInput)
        .pipe(Effect.provide(NodeServices.layer));
      yield* runtime.start();
      const chat = yield* openGrokSideChat(sideInput("native-1"));
      const updates: Array<ProviderAdapter.ProviderAdapterV2SideChatUpdate> = [];
      const first = yield* chat.ask({
        prompt: "What was the word?",
        onUpdate: (update) =>
          Effect.sync(() => {
            updates.push(update);
          }),
      });
      const second = yield* chat.ask({
        prompt:
          "What was the exact previous side question? If you were not shown earlier side questions, say NONE.",
        onUpdate: () => Effect.void,
      });
      expect(first).toBe("answer:What was the word?");
      expect(second).toContain("NONE");
      expect(updates).toEqual([{ type: "text", text: "answer:What was the word?" }]);
      expect(calls.map((call) => call.method)).toEqual(["_x.ai/btw", "_x.ai/btw"]);
      expect(calls[0]?.payload).toEqual({
        sessionId: "native-1",
        question: "What was the word?",
      });
      expect(calls[1]?.payload).toEqual({
        sessionId: "native-1",
        question:
          "What was the exact previous side question? If you were not shown earlier side questions, say NONE.",
      });
      expect(JSON.stringify(calls[1]?.payload)).not.toContain("What was the word?");
    }),
  );

  it.effect("follows the session the process adopted and ignores the one it left", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const sessionIdRef = { current: "session-a" };
      const wrapped = yield* bindGrokSideChatRuntime(fakeRuntime(sessionIdRef, calls));
      yield* wrapped.start();
      sessionIdRef.current = "session-b";
      const stale = yield* openGrokSideChat(sideInput("session-a"));
      const staleResult = yield* stale
        .ask({ prompt: "still there?", onUpdate: () => Effect.void })
        .pipe(Effect.result);
      expect(staleResult._tag).toBe("Failure");
      expect(calls).toEqual([]);
      const chat = yield* openGrokSideChat(sideInput("session-b"));
      const answer = yield* chat.ask({
        prompt: "which session?",
        onUpdate: () => Effect.void,
      });
      expect(answer).toBe("answer:which session?");
      expect(calls).toEqual([
        {
          method: "_x.ai/btw",
          payload: { sessionId: "session-b", question: "which session?" },
        },
      ]);
    }),
  );

  it.effect("fails closed when the live process is gone", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const scope = yield* Scope.make();
      const wrapped = yield* bindGrokSideChatRuntime(
        fakeRuntime({ current: "native-closed" }, calls),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      yield* wrapped.start();
      yield* Scope.close(scope, Exit.void);
      const chat = yield* openGrokSideChat(sideInput("native-closed"));
      const updates: Array<unknown> = [];
      const result = yield* chat
        .ask({
          prompt: "hello",
          onUpdate: (update) =>
            Effect.sync(() => {
              updates.push(update);
            }),
        })
        .pipe(Effect.result);
      expect(updates).toEqual([]);
      expect(calls).toEqual([]);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("ProviderAdapterProtocolError");
      if (result.failure._tag !== "ProviderAdapterProtocolError") return;
      expect(result.failure.detail).toBe("Grok side questions need the live session");
      const missing = yield* openGrokSideChat(sideInput(null));
      const missingResult = yield* missing
        .ask({ prompt: "hello", onUpdate: () => Effect.void })
        .pipe(Effect.result);
      expect(missingResult._tag).toBe("Failure");
    }),
  );
});

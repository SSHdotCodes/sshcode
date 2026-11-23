import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  sideChatKindForDriver,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import type { HttpClientRequest } from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import { OPENCODE_PROVIDER } from "../adapter.ts";
import { make } from "./adapter.ts";

const isAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);
const SESSION = "ses_side_question";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:side-question");
const instructions =
  "The user is asking a quick side question about the conversation so far. " +
  "Answer directly and concisely in markdown from what you already know. " +
  "Do not call any tools and do not take any actions.";

const sideInput = Effect.gen(function* () {
  const now = yield* DateTime.now;
  return {
    threadId,
    providerThread: {
      id: ProviderThreadId.make("provider-thread:side-question"),
      driver: OPENCODE_PROVIDER,
      providerInstanceId: instanceId,
      providerSessionId: ProviderSessionId.make("provider-session:main"),
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
    // The native session is authoritative. Sending this selection or changing
    // permissions would mutate the main turn and could invalidate its cache.
    modelSelection: { instanceId, model: "unused/do-not-switch" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work" },
  } satisfies ProviderAdapter.ProviderAdapterV2SideChatInput;
});

const fixture = (respond: (request: HttpClientRequest) => Effect.Effect<Response>) =>
  Effect.gen(function* () {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const opencode = yield* OpenCode2Client.make.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push({
              method: request.method,
              url: request.url,
              body:
                request.body._tag === "Uint8Array"
                  ? JSON.parse(new TextDecoder().decode(request.body.body))
                  : undefined,
            });
            return HttpClientResponse.fromWeb(request, yield* respond(request));
          }),
        ),
      ),
    );
    const connection = {
      ...(yield* opencode.connect({ baseUrl: "http://opencode.test", password: "test" })),
      url: "http://opencode.test",
      version: "2.0.30",
      external: false,
    };
    let borrowers = 0;
    const adapter = yield* make(instanceId).pipe(
      Effect.provideService(OpenCode2Server.OpenCode2Server, {
        retire: Effect.void,
        withConnection: (use) =>
          Effect.acquireUseRelease(
            Effect.sync(() => borrowers++),
            () => use(connection),
            () => Effect.sync(() => borrowers--),
          ),
      }),
    );
    assert.isDefined(adapter.openSideChat);
    return { open: adapter.openSideChat!, requests, borrowers: () => borrowers };
  });

const answer = (text: string) =>
  new Response(JSON.stringify({ data: { text } }), {
    headers: { "content-type": "application/json" },
  });
const layer = Layer.mergeAll(
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

it.layer(layer)("OpenCode native /btw", (it) => {
  it.effect("uses only generate on the original session and emits each one-shot answer", () =>
    Effect.gen(function* () {
      const test = yield* fixture(() => Effect.succeed(answer("  native answer\n")));
      const input = yield* sideInput;
      const before = JSON.stringify(input);
      const updates: Array<ProviderAdapter.ProviderAdapterV2SideChatUpdate> = [];
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const side = yield* test.open(input).pipe(Scope.provide(scope));
      assert.equal(side.kind, "btw");
      assert.equal(sideChatKindForDriver("opencode"), "btw");
      const onUpdate = (update: ProviderAdapter.ProviderAdapterV2SideChatUpdate) =>
        Effect.sync(() => void updates.push(update));
      assert.equal(yield* side.ask({ prompt: "  first question  ", onUpdate }), "native answer");
      assert.equal(yield* side.ask({ prompt: "follow-up", onUpdate }), "native answer");
      assert.deepEqual(test.requests, [
        {
          method: "POST",
          url: `http://opencode.test/api/session/${SESSION}/generate`,
          body: { prompt: `${instructions}\n\nfirst question` },
        },
        {
          method: "POST",
          url: `http://opencode.test/api/session/${SESSION}/generate`,
          body: { prompt: `${instructions}\n\nfollow-up` },
        },
      ]);
      assert.deepEqual(updates, [
        { type: "text", text: "native answer" },
        { type: "text", text: "native answer" },
      ]);
      assert.equal(JSON.stringify(input), before);
      assert.equal(test.borrowers(), 1);
      yield* Scope.close(scope, Exit.void);
      assert.equal(test.borrowers(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces native generate failures without a prompt or fork fallback", () =>
    Effect.gen(function* () {
      const test = yield* fixture(() =>
        Effect.succeed(
          new Response(
            JSON.stringify({
              _tag: "ServiceUnavailableError",
              message: "free tier can only be used from within OpenCode",
              service: "session generation",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const side = yield* test.open(yield* sideInput);
      const error = yield* side
        .ask({ prompt: "question", onUpdate: () => Effect.die("no answer") })
        .pipe(Effect.flip);
      assert.isTrue(isAdapterError(error));
      assert.include(error.message, "session.generate");
      assert.lengthOf(test.requests, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels only the transient HTTP request when an ask is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const test = yield* fixture(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
      );
      const side = yield* test.open(yield* sideInput);
      const running = yield* side
        .ask({ prompt: "question", onUpdate: () => Effect.die("no answer") })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      yield* Deferred.await(cancelled);
      assert.lengthOf(test.requests, 1);
      assert.include(test.requests[0]!.url, "/generate");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a thread without a native session before borrowing a server", () =>
    Effect.gen(function* () {
      const test = yield* fixture(() => Effect.die("must not send HTTP"));
      const input = yield* sideInput;
      const error = yield* test
        .open({ ...input, providerThread: { ...input.providerThread, nativeThreadRef: null } })
        .pipe(Effect.flip);
      assert.isTrue(isAdapterError(error));
      assert.isEmpty(test.requests);
      assert.equal(test.borrowers(), 0);
    }).pipe(Effect.scoped),
  );
});

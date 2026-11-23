import type { ThreadId, ThreadMediaPage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      compactIds: "1",
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadHistoryPage(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadHistoryPage({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
  });
});

export const fetchEnvironmentThreadMediaPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMediaPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
}) {
  const endpoint = { params: { threadId: input.threadId }, query: { cursor: input.cursor } };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadMediaPage(endpoint),
    timeoutMs: DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadMediaPage({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
  });
});

export class ThreadMediaLoader extends Context.Service<
  ThreadMediaLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: { readonly threadId: ThreadId; readonly cursor: string },
    ) => Effect.Effect<ThreadMediaPage, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/threadHistoryHttp/ThreadMediaLoader") {}

export const mediaLayer = Layer.effect(
  ThreadMediaLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return ThreadMediaLoader.of({
      load: (prepared, input) =>
        fetchEnvironmentThreadMediaPage({ prepared, ...input, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

export class ThreadMediaConnectionNotReadyError extends Data.TaggedError(
  "ThreadMediaConnectionNotReadyError",
)<{ readonly message: string }> {}

export function createThreadMediaCommand<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | ThreadMediaLoader | R, ER>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:thread-media:page",
    execute: (input: { readonly threadId: ThreadId; readonly cursor: string }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const loader = yield* ThreadMediaLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new ThreadMediaConnectionNotReadyError({
            message: "Environment is not connected.",
          });
        return yield* loader.load(prepared.value, input);
      }),
  });
}

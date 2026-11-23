import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SideChatService from "./SideChatService.ts";

const threadId = ThreadId.make("account-shared-codex-chat");
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "account-accounts-side-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each([
  { driver: "codex", mode: "open", selectionOnly: false },
  { driver: "codex", mode: "send", selectionOnly: false },
  { driver: "claudeAgent", mode: "open", selectionOnly: false },
  { driver: "claudeAgent", mode: "send", selectionOnly: false },
  { driver: "claudeAgent", mode: "send", selectionOnly: true },
  { driver: "codex", mode: "open", selectionOnly: true },
  { driver: "grok", mode: "open", selectionOnly: false },
  { driver: "grok", mode: "send", selectionOnly: true },
] as const)(
  "side questions follow account switches: $driver $mode staged=$selectionOnly",
  ({ driver, mode, selectionOnly }) =>
    Effect.gen(function* () {
      const primary = ProviderInstanceId.make(
        driver === "codex" ? "codex" : driver === "claudeAgent" ? "claudeAgent" : "grok_grok_build",
      );
      const secondary = ProviderInstanceId.make(
        driver === "codex"
          ? "codex_work"
          : driver === "claudeAgent"
            ? "claudeAgent_work"
            : "grok_work",
      );
      let selected = primary;
      const closedAccounts: string[] = [];
      const actualAccounts: string[] = [];
      const openedAccounts: string[] = [];
      // Match Codex's side adapter: the side process's login is fixed at open,
      // and ask() uses that same process. Only the service can pick another adapter.
      const adapterFor = (instanceId: typeof primary) => {
        const context = Layer.mock(ProviderAdapter.ProviderAdapterV2)({
          instanceId,
          driver: ProviderDriverKind.make(driver),
          openSideChat: (input) =>
            Effect.gen(function* () {
              openedAccounts.push(instanceId);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedAccounts.push(instanceId);
                }),
              );
              return {
                kind: driver === "codex" ? ("side" as const) : ("btw" as const),
                ask: () =>
                  Effect.gen(function* () {
                    const current = yield* input.current!;
                    expect(current.modelSelection?.instanceId).toBe(instanceId);
                    expect(current.providerThread.providerInstanceId).toBe(instanceId);
                    actualAccounts.push(instanceId);
                    return "synthetic answer";
                  }),
              };
            }),
        });
        return Layer.build(context).pipe(
          Effect.map((ctx) => Context.get(ctx, ProviderAdapter.ProviderAdapterV2)),
        );
      };
      const first = yield* adapterFor(primary);
      const second = yield* adapterFor(secondary);
      const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
        get: (instanceId) => Effect.succeed(instanceId === primary ? first : second),
        list: () => Effect.succeed([primary, secondary]),
        getMetadata: () =>
          Effect.succeed({
            driver: ProviderDriverKind.make(driver),
            continuationKey: "shared-home",
            enabled: true,
            capabilities: CodexProviderCapabilitiesV2,
          }),
      });
      const dependencies = Layer.mergeAll(
        registry,
        RuntimePolicy.layer,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: {
                    id: threadId,
                    activeProviderThreadId: ProviderThreadId.make("shared-provider-thread"),
                    modelSelection: { instanceId: selected, model: "gpt-6.1-sol" },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  },
                  providerThreads: [
                    {
                      id: ProviderThreadId.make("shared-provider-thread"),
                      providerInstanceId: selectionOnly ? primary : selected,
                      providerSessionId: null,
                      nativeThreadRef: { nativeId: "shared-native-session" },
                    },
                  ],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      );
      const context = yield* Layer.build(SideChatService.layer.pipe(Layer.provide(dependencies)));
      const service = Context.get(context, SideChatService.SideChatService);
      const settled = (count: number) =>
        service.subscribe({ threadId }).pipe(
          Stream.filter((state) => state?.status === "idle" && state.messages.length === count * 2),
          Stream.runHead,
        );
      const firstOpen = yield* service.open({
        threadId,
        prompt: "synthetic first question",
        messageId: "first",
      });
      yield* settled(1);
      // Both the selected account and the provider-thread owner already moved.
      selected = secondary;
      if (mode === "open")
        yield* service.open({ threadId, prompt: "synthetic second question", messageId: "second" });
      else
        yield* service.send({
          sideChatId: firstOpen.sideChatId,
          prompt: "synthetic second question",
          messageId: "second",
        });
      yield* settled(2);
      expect(actualAccounts).toEqual([primary, secondary]);
      expect(openedAccounts).toEqual([primary, secondary]);
      expect(closedAccounts).toEqual([primary]);
      selected = primary;
      yield* service.send({
        sideChatId: firstOpen.sideChatId,
        prompt: "synthetic third question",
        messageId: "third",
      });
      yield* settled(3);
      expect(actualAccounts).toEqual([primary, secondary, primary]);
      expect(openedAccounts).toEqual([primary, secondary, primary]);
      expect(closedAccounts).toEqual([primary, secondary]);
      // Replaying an accepted send does not switch accounts or open a process.
      yield* service.send({
        sideChatId: firstOpen.sideChatId,
        prompt: "synthetic second question",
        messageId: "second",
      });
      expect(actualAccounts).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderHost from "./ProviderHost.ts";

const input = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("chat"),
  environment: { TMPDIR: "/ambient" },
};

describe("chat environment policy", () => {
  it.effect(
    "captures the host policy for sessions started outside the driver construction context",
    () =>
      Effect.gen(function* () {
        const prepare = yield* ProviderHost.chatEnvironment.pipe(
          Effect.provideService(ProviderHost.ProviderHost, {
            prepareChatEnvironment: (received: ProviderHost.ChatEnvironmentInput) => {
              expect(received).toBe(input);
              return Effect.succeed({ TMPDIR: "/chat", TMP: "/chat", TEMP: "/chat" });
            },
          } as unknown as ProviderHost.ProviderHost["Service"]),
        );
        expect(yield* prepare(input)).toEqual({ TMPDIR: "/chat", TMP: "/chat", TEMP: "/chat" });
      }),
  );

  it.effect("leaves environments intact for hosts without a temp policy", () =>
    Effect.gen(function* () {
      const prepare = yield* ProviderHost.chatEnvironment;
      expect(yield* prepare(input)).toBe(input.environment);
    }),
  );
});

import type { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpAdapterV2Flavor } from "./adapter.ts";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isSteeringCapability = Schema.is(Schema.Struct({ supported: Schema.Literal(true) }));

export const supportsAcpSteering = (initialized: EffectAcpSchema.InitializeResponse) =>
  isSteeringCapability(initialized._meta?.steering);

export const steerAcpTurn = Effect.fn("steerAcpTurn")(function* (
  input: Parameters<NonNullable<AcpAdapterV2Flavor["steer"]>>[0] & {
    readonly driver: ProviderDriverKind;
  },
) {
  const { runtime, sessionId, text, driver, providerThreadId, providerTurnId } = input;
  const unsupported = new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
    driver,
    providerThreadId,
  });
  const steerError = (cause: unknown) =>
    new ProviderAdapter.ProviderAdapterSteerRunError({
      driver,
      providerThreadId,
      providerTurnId,
      cause,
    });
  const result = yield* runtime
    .request("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text }],
      // The extension selects host-owned idle delivery per request, without
      // adding a separate initialize capability (claude-agent-acp#919).
      _meta: { steering: { idleBehavior: "promptRequired" } },
    })
    .pipe(
      Effect.mapError((cause) =>
        isAcpRequestError(cause) && cause.code === -32601 ? unsupported : steerError(cause),
      ),
    );
  const outcome =
    typeof result === "object" && result !== null ? Reflect.get(result, "outcome") : undefined;
  if (outcome === "injected") return;
  if (outcome === "startedNewTurn") {
    // Older agents can ignore the idle opt-in. Stop their detached turn before
    // handing the unchanged input back to the host's normal prompt queue.
    yield* runtime.cancel.pipe(Effect.mapError(steerError));
  }
  return yield* unsupported;
});

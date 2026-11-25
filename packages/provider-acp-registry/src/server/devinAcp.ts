import type { ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type {
  AcpAdapterV2Flavor,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/**
 * Devin serves its SWE models' Lightning variants (Cerebras, billed per token, recorded as
 * `swe-2-1-low-lightning` and the like) as the model's Speed "fast" choice, not as models of their
 * own, so the picker names that choice the way Devin's own picker names the model.
 */
export function withDevinLightningSpeed(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const descriptors = model.capabilities?.optionDescriptors;
    if (!model.slug.startsWith("swe-") || model.capabilities == null || descriptors === undefined)
      return model;
    let changed = false;
    const optionDescriptors = descriptors.map((descriptor) => {
      if (descriptor.id !== "speed" || descriptor.type !== "select") return descriptor;
      return {
        ...descriptor,
        options: descriptor.options.map((option) => {
          if (option.id !== "fast" || option.label === "Lightning") return option;
          changed = true;
          return {
            ...option,
            label: "Lightning",
            description: "About 10× faster on Cerebras. Billed per token.",
          };
        }),
      };
    });
    return changed
      ? { ...model, capabilities: { ...model.capabilities, optionDescriptors } }
      : model;
  });
}

const EFFORT_NAME_SUFFIX = /\s+(?:Low|Medium|High|XHigh|Max)$/i;

/** Devin's selectable effort already names the level independently of the model. */
export function withoutDevinEffortSuffix(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const candidates = models.map((model) => {
    if (
      !model.capabilities?.optionDescriptors?.some(
        (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
      )
    ) {
      return model;
    }
    const name = model.name.replace(EFFORT_NAME_SUFFIX, "");
    const shortName = model.shortName?.replace(EFFORT_NAME_SUFFIX, "");
    return name === model.name && shortName === model.shortName
      ? model
      : { ...model, name, ...(shortName === undefined ? {} : { shortName }) };
  });

  const names = new Map<string, Set<number>>();
  for (const [index, original] of models.entries()) {
    const candidate = candidates[index]!;
    for (const name of [original.name, original.shortName, candidate.name, candidate.shortName]) {
      if (name === undefined) continue;
      const key = name.toLowerCase();
      const owners = names.get(key) ?? new Set<number>();
      owners.add(index);
      names.set(key, owners);
    }
  }
  return candidates.map((candidate, index) => {
    const original = models[index]!;
    const collides = (name: string) => (names.get(name.toLowerCase())?.size ?? 0) > 1;
    return (candidate.name !== original.name && collides(candidate.name)) ||
      (candidate.shortName !== undefined &&
        candidate.shortName !== original.shortName &&
        collides(candidate.shortName))
      ? original
      : candidate;
  });
}

// How long a steer watches for the turn ending under it before calling it delivered.
const STEER_SETTLE = "1500 millis";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Devin's typed extension metadata, captured from its native ACP stream. */
export function normalizeDevinSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const meta = record("_meta" in update ? update._meta : undefined);
  const parentAgentId = record(meta?.["cognition.ai/subagent_context"])?.parentAgentId;
  const routed =
    typeof parentAgentId === "string" && parentAgentId !== "root"
      ? { ...notification, sessionId: parentAgentId }
      : notification;
  const messageId = meta?.["cognition.ai/streamingMessageId"];
  if (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    typeof messageId === "string"
  ) {
    return { ...routed, update: { ...update, messageId } };
  }
  return routed;
}

export function normalizeDevinToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = record(tool.data.meta)?.["cognition.ai/inferenceToolName"];
  return typeof name === "string" && (!tool.title || tool.title === "Tool")
    ? { ...tool, title: name }
    : tool;
}

export function extractDevinSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const meta = record(tool.data.meta);
  const completed = record(meta?.["cognition.ai/subagent_completed"]);
  const started = record(meta?.["cognition.ai/subagent_started"]);
  const data = completed ?? started;
  if (typeof data?.agentId !== "string") return undefined;
  return {
    nativeTaskId: data.agentId,
    childSessionId: data.agentId,
    prompt: typeof started?.task === "string" ? started.task : "",
    title: typeof started?.title === "string" ? started.title : null,
    model: typeof started?.model === "string" ? started.model : null,
    status: completed ? (completed.success === false ? "failed" : "completed") : "running",
    result: typeof completed?.summary === "string" ? completed.summary : null,
  };
}

type DevinSteerInput = Parameters<NonNullable<AcpAdapterV2Flavor["steer"]>>[0] & {
  readonly driver: ProviderDriverKind;
};

/**
 * Devin folds a `session/prompt` sent during a turn into that turn
 * (`cognition.ai/midTurnPrompts`): it reads the new message at its next step and carries on,
 * and both calls return together when the turn ends. When the turn ends just before Devin
 * reads it, Devin starts a turn of its own that no SSHCode turn would show: that one is
 * cancelled and the message goes back to the host to send next, like any other agent's.
 */
export const steerDevinTurn = Effect.fn("steerDevinTurn")(function* (input: DevinSteerInput) {
  const unsupported = new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
    driver: input.driver,
    providerThreadId: input.providerThreadId,
  });
  if (yield* input.turnOver.isDone) return yield* unsupported;
  const answered = yield* Deferred.make<boolean>();
  yield* input.runtime
    .request("session/prompt", {
      sessionId: input.sessionId,
      prompt: [{ type: "text", text: input.text }],
    })
    .pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.succeed(answered, Exit.isSuccess(exit))),
      Effect.forkDetach,
    );
  const first = yield* Effect.raceFirst(
    Deferred.await(answered).pipe(Effect.map((ok) => (ok ? "answered" : "refused"))),
    input.turnOver.await.pipe(Effect.as("ended" as const)),
  ).pipe(Effect.timeoutOption(STEER_SETTLE));
  // Still running: Devin has it.
  if (Option.isNone(first) || first.value === "answered") return;
  if (first.value === "refused") return yield* unsupported;
  // The turn ended: a prompt Devin folded in returns with it; one it did not is a new turn.
  const late = yield* Deferred.await(answered).pipe(Effect.timeoutOption(STEER_SETTLE));
  if (Option.isSome(late)) {
    if (late.value) return;
    return yield* unsupported;
  }
  yield* input.runtime.cancel.pipe(Effect.ignore);
  return yield* unsupported;
});

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ShortText = Schema.String.check(Schema.isMaxLength(2_048));

export const ComputerUseSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  blockedAppIds: Schema.Array(Identifier).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ComputerUseSettings = typeof ComputerUseSettings.Type;
export const DEFAULT_COMPUTER_USE_SETTINGS = Schema.decodeSync(ComputerUseSettings)({});

export const ComputerApp = Schema.Struct({
  id: Identifier,
  name: ShortText,
  pid: Schema.optionalKey(Schema.Int),
});
export type ComputerApp = typeof ComputerApp.Type;

export const ComputerDriverStatus = Schema.Struct({
  platform: Schema.String,
  installed: Schema.Boolean,
  accessibility: Schema.Literals(["granted", "denied", "unknown"]),
  screenRecording: Schema.Literals(["granted", "denied", "unknown"]),
  reason: Schema.NullOr(ShortText),
});
export type ComputerDriverStatus = typeof ComputerDriverStatus.Type;

export const ComputerController = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  appId: Identifier,
  acquiredAt: Schema.Number,
});
export type ComputerController = typeof ComputerController.Type;

export const ComputerUseStatus = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  driver: ComputerDriverStatus,
  owner: Schema.NullOr(ComputerController),
  queued: Schema.Array(ThreadId),
  blockedAppIds: Schema.Array(Identifier),
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerAction = Schema.Union([
  Schema.Struct({
    delivery: Schema.optionalKey(Schema.Literals(["background", "foreground"])),
    kind: Schema.Literal("click"),
    ref: Identifier,
    button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
  }),
  Schema.Struct({
    delivery: Schema.optionalKey(Schema.Literals(["background", "foreground"])),
    kind: Schema.Literal("clickAt"),
    captureId: Identifier,
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
  }),
  Schema.Struct({
    delivery: Schema.optionalKey(Schema.Literals(["background", "foreground"])),
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({
    delivery: Schema.optionalKey(Schema.Literals(["background", "foreground"])),
    kind: Schema.Literal("press"),
    key: Identifier,
    modifiers: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(4))),
  }),
  Schema.Struct({
    delivery: Schema.optionalKey(Schema.Literals(["background", "foreground"])),
    kind: Schema.Literal("scroll"),
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.optionalKey(
      Schema.Number.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(10)),
    ),
  }),
]);
export type ComputerAction = typeof ComputerAction.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  reason: Schema.Literals([
    "disabled",
    "paused",
    "blocked_app",
    "busy",
    "invalid_lease",
    "unavailable",
    "permission_required",
    "stale_observation",
    "driver_failure",
    "cancelled",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Computer use is off. Enable it in Settings > Computer use.";
      case "paused":
        return "Computer control is with the user. Wait until they resume agent access.";
      case "blocked_app":
        return "This app is blocked in Computer use settings.";
      case "busy":
        return "Computer control is busy. Check status and retry when control is available.";
      case "invalid_lease":
        return "Computer control expired or was released. Open the app again.";
      case "permission_required":
        return "macOS computer permissions need setup in System Settings.";
      case "stale_observation":
        return "The observation is stale. Inspect the app before trying again.";
      case "cancelled":
        return "Computer control was stopped.";
      case "unavailable":
        return "Computer control is unavailable on this environment.";
      case "driver_failure":
        return "The computer driver could not complete this operation.";
    }
  }
}

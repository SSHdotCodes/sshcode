import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const HarnessModelDefaults = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});
export type HarnessModelDefaults = typeof HarnessModelDefaults.Type;

export const HarnessDefaultsState = Schema.Struct({
  defaultHarness: Schema.optional(ProviderInstanceId),
  harnesses: Schema.Record(ProviderInstanceId, HarnessModelDefaults),
});
export type HarnessDefaultsState = typeof HarnessDefaultsState.Type;

/** Null clears a choice; omitted fields leave other devices' choices intact. */
export const HarnessDefaultsPatch = Schema.Struct({
  defaultHarness: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  harnesses: Schema.optional(
    Schema.Record(
      ProviderInstanceId,
      Schema.NullOr(
        Schema.Struct({
          model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
          options: Schema.optional(
            Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
          ),
        }),
      ),
    ),
  ),
});
export type HarnessDefaultsPatch = typeof HarnessDefaultsPatch.Type;

export class HarnessDefaultsError extends Schema.TaggedError<HarnessDefaultsError>()(
  "HarnessDefaultsError",
  {
    operation: Schema.Literals(["read", "decode", "write"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} harness defaults.`;
  }
}

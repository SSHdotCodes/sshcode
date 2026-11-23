import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

/** A server-resolved credential target. Secret values never appear on a run. */
export const ProviderCredentialRecovery = Schema.Struct({
  credentialRef: Schema.String,
  label: Schema.String,
  consoleUrl: Schema.optionalKey(Schema.String),
  alsoUsedBy: Schema.Array(Schema.String),
});
export type ProviderCredentialRecovery = typeof ProviderCredentialRecovery.Type;

export const ReplaceProviderCredentialInput = Schema.Struct({
  credentialRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
});
export type ReplaceProviderCredentialInput = typeof ReplaceProviderCredentialInput.Type;

export const ReplaceProviderCredentialResult = Schema.Struct({
  updatedInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ReplaceProviderCredentialResult = typeof ReplaceProviderCredentialResult.Type;

export class ProviderCredentialReplaceError extends Schema.TaggedError<ProviderCredentialReplaceError>()(
  "ProviderCredentialReplaceError",
  {
    reason: Schema.Literals(["unavailable", "invalid-value", "save", "refresh"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "This key changed or is no longer available. Reopen the chat and try again.";
      case "invalid-value":
        return "Enter an API key.";
      case "save":
        return "Could not save the API key. Try again.";
      case "refresh":
        return "The key was saved, but some provider sessions could not restart. Save again to retry.";
    }
  }
}

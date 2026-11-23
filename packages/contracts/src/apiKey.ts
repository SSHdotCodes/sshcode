import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ApiKeyName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,127}$/));
export const ApiKeyScope = Schema.Literals(["chat", "all"]);
export type ApiKeyScope = typeof ApiKeyScope.Type;
export const ApiKeyExpiry = Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0)));
export const ApiKeyRequest = Schema.Struct({
  name: ApiKeyName,
  suggestedScope: Schema.optional(ApiKeyScope),
  suggestedExpiresAt: Schema.optional(ApiKeyExpiry),
});
export const ApiKeyMetadata = Schema.Struct({
  id: Schema.String,
  name: ApiKeyName,
  label: TrimmedNonEmptyString,
  scope: ApiKeyScope,
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.Number,
  expiresAt: ApiKeyExpiry,
});
export type ApiKeyMetadata = typeof ApiKeyMetadata.Type;
export const ApiKeyUpdateInput = Schema.Struct({ id: Schema.String, expiresAt: ApiKeyExpiry });
export const ApiKeyDeleteInput = Schema.Struct({ id: Schema.String });
export const ApiKeyManageInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("update"), ...ApiKeyUpdateInput.fields }),
  Schema.Struct({ action: Schema.Literal("delete"), ...ApiKeyDeleteInput.fields }),
]);
export type ApiKeyManageInput = typeof ApiKeyManageInput.Type;
export class ApiKeyError extends Schema.TaggedError<ApiKeyError>()("ApiKeyError", {
  reason: Schema.Literals([
    "storage",
    "unavailable",
    "invalid_expiry",
    "invalid_key",
    "invalid_ticket",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Could not access the secure API key vault. Check that the host credential store is available.";
      case "unavailable":
        return "This API key is missing, expired, or unavailable to this chat. Use request_api_key.";
      case "invalid_expiry":
        return "Choose an expiry in the future, or Never.";
      case "invalid_key":
        return "Enter a nonempty API key without null characters (up to 16 KB).";
      case "invalid_ticket":
        return "This API key ticket expired or was already used. Call prepare_api_key again.";
    }
  }
}

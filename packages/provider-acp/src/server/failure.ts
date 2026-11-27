import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";
import { acpRequestErrorMessage, makeProviderFailure } from "@t3tools/provider-core/server/failure";

export { acpRequestErrorMessage };

const isRequestError = Schema.is(AcpErrors.AcpRequestError);
const isTransportError = Schema.is(
  Schema.Union([AcpErrors.AcpTransportError, AcpErrors.AcpInputStreamEndedError]),
);

/** Only protocol errors carry provider text; process defects remain private. */
export function acpPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isRequestError(cause)
      ? {
          message: acpRequestErrorMessage(cause),
          code: String(cause.code),
          class: cause.code === -32000 ? "authentication_error" : "provider_error",
        }
      : isTransportError(cause)
        ? { class: "transport_error", retryable: true }
        : { class: "provider_error" }),
  });
}

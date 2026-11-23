import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const ApiErrorDetail = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  type: Schema.optional(Schema.String),
});
const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...ApiErrorDetail.fields,
      error: Schema.optional(ApiErrorDetail),
    }),
  ),
);

const vertexCapacityMessage =
  /\bResource exhausted[.,] please try again later\. Please refer to https:\/\/cloud\.google\.com\/vertex-ai\/generative-ai\/docs\/error-code-429\b/iu;

/** OpenCode 1 wraps API failures in data; OpenCode 2 sends type/message directly. */
export function openCodeProviderFailure(input: {
  readonly message: string;
  readonly code?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly responseBody?: string | undefined;
  readonly retryable?: boolean | undefined;
}) {
  const body = Option.getOrUndefined(decodeBody(input.responseBody));
  const detail = body?.error ?? body;
  const code = detail?.code ?? detail?.type ?? input.code;
  const message = detail?.message ?? input.message;
  if (vertexCapacityMessage.test(message)) {
    return makeProviderFailure({
      class: "provider_error",
      code: "vertex_capacity",
      message: "Vertex AI is temporarily out of capacity. Try again later.",
      // OpenCode has already attempted this request with its own retry policy.
      retryable: false,
    });
  }
  return makeProviderFailure({
    message,
    code: code === undefined ? null : String(code),
    statusCode: input.statusCode,
    retryable: input.retryable ?? null,
    class: "provider_error",
  });
}

import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import type { AuthMcpAuthorizationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

/**
 * The sign-in page registers a public request, even in an owner's signed-in browser.
 * Only the authenticated app connection can answer it. No owner cookie or bearer is sent.
 */
export function requestMcpInAppApproval(
  httpBaseUrl: string,
  authorization: AuthMcpAuthorizationRequest,
) {
  return makeEnvironmentHttpApiClient(httpBaseUrl).pipe(
    Effect.flatMap((client) => client.mcpOAuth.approval({ payload: authorization })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit" }),
  );
}

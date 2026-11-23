import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { requestMcpInAppApproval } from "./mcpApproval";

const authorization = {
  client_id: "registered-client",
  redirect_uri: "https://claude.ai/callback",
  response_type: "code",
  code_challenge: "pkce-challenge",
  code_challenge_method: "S256",
  resource: "https://sshcode.test/mcp",
};

describe("public MCP sign-in initiation", () => {
  it.effect("requests in-app approval without the owner's cookie, bearer or fetch defaults", () =>
    Effect.gen(function* () {
      let observed: Request | null = null;
      const details = {
        clientName: "Claude",
        redirectHost: "claude.ai",
        environmentHost: "sshcode.test",
        pendingApproval: { id: "pending-request", pollSecret: "test-poll-secret", code: "0042" },
      };
      const result = yield* requestMcpInAppApproval("https://sshcode.test", authorization).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
          observed = new Request(input, init);
          return Response.json(details);
        }),
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: "include",
          headers: { Authorization: "Bearer owner-test-token" },
        }),
      );
      expect(result).toEqual(details);
      const request = observed as Request | null;
      expect(request?.url).toBe("https://sshcode.test/oauth/mcp/approval");
      expect(request?.credentials).toBe("omit");
      expect(request?.headers.has("authorization")).toBe(false);
      expect(request?.headers.has("cookie")).toBe(false);
      expect(yield* Effect.promise(() => request!.json())).toEqual(authorization);
    }),
  );
});

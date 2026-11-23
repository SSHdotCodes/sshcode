import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  AuthMcpClientAccess,
  AuthOrchestrationReadScope,
  AuthSessionState,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
} from "@t3tools/contracts";
import {
  canSuggestMcpAccess,
  mcpSignInCompleted,
  resolveMcpGate,
  resolvePublicMcpUrl,
  suggestedMcpAccess,
} from "./mcpGate";

const ready = {
  connected: true,
  canAccept: true,
  canEnable: true,
  outsideAgents: true,
  mcpUrl: "https://public.test/mcp",
  publicUrl: "https://public.test/mcp",
  needsPublicUrl: true,
  connectAvailable: true,
};

describe("MCP setup gate", () => {
  it("requires a connection, loaded settings and permission before opening sign-ins", () => {
    expect(resolveMcpGate(ready)).toBe("open");
    expect(resolveMcpGate({ ...ready, connected: false })).toBe("disconnected");
    expect(resolveMcpGate({ ...ready, outsideAgents: undefined })).toBe("checking");
    expect(resolveMcpGate({ ...ready, canAccept: false })).toBe("no-permission");
  });
  it("offers to turn outside agents on without silently enabling them", () => {
    expect(resolveMcpGate({ ...ready, outsideAgents: false })).toBe("turn-on");
    expect(resolveMcpGate({ ...ready, outsideAgents: false, canEnable: false })).toBe(
      "no-settings-permission",
    );
    expect(resolveMcpGate({ ...ready, canEnable: false })).toBe("open");
  });
  it("requires the relay address for cloud apps but permits local clients", () => {
    expect(resolveMcpGate({ ...ready, mcpUrl: "http://localhost:3773/mcp", publicUrl: null })).toBe(
      "public-address-needed",
    );
    expect(resolveMcpGate({ ...ready, publicUrl: null, connectAvailable: false })).toBe(
      "connect-unavailable",
    );
    expect(
      resolveMcpGate({
        ...ready,
        mcpUrl: "http://localhost:3773/mcp",
        publicUrl: null,
        needsPublicUrl: false,
      }),
    ).toBe("open");
    expect(resolveMcpGate({ ...ready, mcpUrl: null, publicUrl: null, needsPublicUrl: false })).toBe(
      "no-address",
    );
  });
  it("normalizes public URLs and never hands credentials to another app", () => {
    expect(
      resolvePublicMcpUrl({ relayBaseUrl: "https://public.test/path?token=private#fragment" }),
    ).toBe("https://public.test/mcp");
    for (const relayBaseUrl of [
      undefined,
      "invalid",
      "http://public.test",
      "https://user:pass@public.test",
    ])
      expect(resolvePublicMcpUrl({ relayBaseUrl })).toBeNull();
  });
});

describe("suggested access", () => {
  const session = AuthSessionState.make({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
      serverUpdateScope: "environment:maintain",
    },
    scopes: [AuthOrchestrationReadScope],
  });
  it("keeps the choice within this device's own scopes", () => {
    expect(canSuggestMcpAccess(null, "read-only")).toBe(false);
    expect(canSuggestMcpAccess(session, "read-only")).toBe(true);
    expect(canSuggestMcpAccess(session, "approval-required")).toBe(false);
    const scopes = [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthSettingsWriteScope,
      AuthSourceControlWriteScope,
    ];
    for (const access of AuthMcpClientAccess.literals)
      expect(canSuggestMcpAccess({ ...session, scopes }, access)).toBe(true);
    expect(
      canSuggestMcpAccess(
        { ...session, scopes: scopes.filter((scope) => scope !== AuthSourceControlWriteScope) },
        "full-access",
      ),
    ).toBe(false);
    expect(canSuggestMcpAccess({ ...session, permissions: [], scopes }, "full-access")).toBe(false);
  });
  const signIn = {
    id: "request",
    code: "0042",
    clientName: "An app",
    redirectHost: "app.test",
    requestedAt: 200,
    expiresAt: 900,
  };
  const preference = { access: "read-only" as const, startedAt: 100, expiresAt: 500 };
  it("suggests the selection only for new requests during this setup window", () => {
    expect(suggestedMcpAccess(preference, signIn, 300)).toBe("read-only");
    expect(suggestedMcpAccess(null, signIn, 300)).toBe("approval-required");
    expect(suggestedMcpAccess(preference, signIn, 500)).toBe("approval-required");
    expect(suggestedMcpAccess(preference, { ...signIn, requestedAt: 99 }, 300)).toBe(
      "approval-required",
    );
    expect(suggestedMcpAccess(preference, { ...signIn, requestedAt: 500 }, 300)).toBe(
      "approval-required",
    );
  });
});

it("shows connected only after a new MCP client session is issued for the approved sign-in", () => {
  const approved = {
    id: "request",
    code: "0042",
    clientName: "Claude",
    redirectHost: "claude.ai",
    requestedAt: 100,
    expiresAt: 900,
  };
  const client = {
    subject: "mcp-client",
    client: { label: "Claude", deviceType: "bot" as const },
    issuedAt: DateTime.makeUnsafe(150),
  };
  expect(mcpSignInCompleted([], approved)).toBe(false);
  expect(mcpSignInCompleted([client], null)).toBe(false);
  expect(mcpSignInCompleted([{ ...client, issuedAt: DateTime.makeUnsafe(99) }], approved)).toBe(
    false,
  );
  expect(mcpSignInCompleted([{ ...client, subject: "browser" }], approved)).toBe(false);
  expect(
    mcpSignInCompleted(
      [{ ...client, client: { label: "Other app", deviceType: "bot" as const } }],
      approved,
    ),
  ).toBe(false);
  expect(mcpSignInCompleted([client], approved)).toBe(true);
});

import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthMcpPendingApproval,
  AuthMcpApprovalPending,
} from "./auth.ts";
import { OutsideAgentsCommand, OutsideAgentSignIn } from "./outsideAgents.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeCommand = Schema.decodeUnknownSync(OutsideAgentsCommand);
const decodePending = Schema.decodeUnknownSync(AuthMcpPendingApproval);
const encodeStatus = Schema.encodeSync(AuthMcpApprovalPending);
const isSignIn = Schema.is(OutsideAgentSignIn);

it("only approval-capable sessions can subscribe to approval codes", () => {
  const required = [
    AuthAccessWriteScope,
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthSettingsWriteScope,
    AuthSourceControlWriteScope,
  ];
  expect(clientRpcRequiredScopes(WS_METHODS.outsideAgentsSubscribe, {})).toEqual(required);
  for (const input of [
    { _tag: "approve", id: "a", access: "read-only", code: "0000" },
    { _tag: "deny", id: "a" },
    { _tag: "accept-new" },
    { _tag: "stop-accepting" },
  ])
    expect(clientRpcRequiredScopes(WS_METHODS.outsideAgentsCommand, input)).toEqual(required);
});

it("preserves leading zeroes and decodes old approvals for the service's update message", () => {
  expect(
    decodeCommand({
      _tag: "approve",
      id: "a",
      access: "read-only",
      code: "0000",
    }),
  ).toMatchObject({ code: "0000" });
  expect(
    decodeCommand({
      _tag: "approve",
      id: "a",
      access: "read-only",
    }),
  ).not.toHaveProperty("code");
  expect(decodeCommand({ _tag: "deny", id: "a" })).toEqual({
    _tag: "deny",
    id: "a",
  });
  const pending = { id: "a", pollSecret: "secret", code: "0001" };
  expect(decodePending(pending)).toEqual(pending);
  expect(encodeStatus({ pending: true })).toEqual({ pending: true });
  for (const code of ["1", "12345", "abcd", "１２３４"])
    expect(
      isSignIn({
        id: "a",
        code,
        clientName: "app",
        redirectHost: "app.test",
        requestedAt: 0,
        expiresAt: 1,
      }),
    ).toBe(false);
});

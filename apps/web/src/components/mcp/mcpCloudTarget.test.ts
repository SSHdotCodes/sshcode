import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { mcpCloudTarget } from "./mcpCloudTarget";
const environmentId = EnvironmentId.make("test-environment");
const primary = new PrimaryConnectionTarget({
  environmentId,
  label: "Mac",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773/ws",
});
const prepared: PreparedConnection = {
  environmentId,
  label: "Mac",
  httpBaseUrl: "http://127.0.0.1:3773/path?ignored=true",
  socketUrl: "ws://127.0.0.1:3773/ws",
  httpAuthorization: null,
  target: primary,
};

describe("MCP T3 Connect target", () => {
  it("uses the host's direct route and never puts a pairing query in its websocket address", () => {
    expect(mcpCloudTarget(prepared)).toEqual({
      environmentId,
      label: "Mac",
      httpBaseUrl: prepared.httpBaseUrl,
      wsBaseUrl: "ws://127.0.0.1:3773/ws",
    });
    expect(mcpCloudTarget(null)).toBeNull();
  });
  it("uses a remote route's own bearer, never the primary machine's bearer", () => {
    const target = new BearerConnectionTarget({
      environmentId,
      label: "Remote",
      connectionId: "remote",
    });
    expect(
      mcpCloudTarget({
        ...prepared,
        target,
        httpBaseUrl: "https://remote.test",
        httpAuthorization: { _tag: "Bearer", token: "remote-test-token" },
      }),
    ).toMatchObject({
      environmentId,
      httpBaseUrl: "https://remote.test",
      wsBaseUrl: "wss://remote.test/ws",
      bearerToken: "remote-test-token",
    });
    expect(mcpCloudTarget({ ...prepared, target })).toBeNull();
  });
  it("does not turn a DPoP credential or an SSH forward into direct host credentials", () => {
    const relay = new RelayConnectionTarget({ environmentId, label: "Relay" });
    expect(
      mcpCloudTarget({
        ...prepared,
        target: relay,
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "test-dpop-token",
          expiresAtEpochMs: 99999,
        },
      }),
    ).toBeNull();
    const ssh = new SshConnectionTarget({ environmentId, label: "SSH", connectionId: "ssh" });
    expect(
      mcpCloudTarget({
        ...prepared,
        target: ssh,
        httpAuthorization: { _tag: "Bearer", token: "test-token" },
      }),
    ).toBeNull();
  });
});

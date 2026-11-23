import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WsRpcGroup, WsServerRpcGroups, WsSubscribeServerConfigRpc } from "./rpc.ts";

const decodeConfigSubscription = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema);
const decodeLegacyConfigSubscription = Schema.decodeExit(Schema.Struct({}));

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const decoded = decodeLegacyConfigSubscription({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeConfigSubscription({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeConfigSubscription({});
    expect(decoded).toEqual({});
  });

  it("accepts compact provider opt-in on new servers and ignores it on old ones", () => {
    for (const compactProviders of [true, false]) {
      expect(decodeConfigSubscription({ compactProviders })).toEqual({
        compactProviders,
      });
      expect(Exit.isSuccess(decodeLegacyConfigSubscription({ compactProviders }))).toBe(true);
    }
  });
});

describe("WebSocket RPC contracts", () => {
  it("partitions server handlers without changing their RPC definitions", () => {
    const serverRpcs = WsServerRpcGroups.flatMap((group) => [...group.requests.values()]);

    expect(serverRpcs.map((rpc) => rpc._tag)).toEqual([...WsRpcGroup.requests.keys()]);
    expect(new Set(serverRpcs.map((rpc) => rpc._tag)).size).toBe(serverRpcs.length);
    for (const rpc of serverRpcs) {
      const combined = WsRpcGroup.requests.get(rpc._tag);
      expect(combined?.payloadSchema).toBe(rpc.payloadSchema);
      expect(combined?.successSchema).toBe(rpc.successSchema);
      expect(combined?.errorSchema).toBe(rpc.errorSchema);
      expect(combined?.middlewares).toEqual(rpc.middlewares);
    }
  });

  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
});

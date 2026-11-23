import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CasualVoiceRequest, CasualVoiceReply } from "./casualVoice.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope } from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeReply = Schema.decodeUnknownSync(CasualVoiceReply);
const decode = Schema.decodeUnknownSync(CasualVoiceRequest);
describe("casual voice wire contract", () => {
  it("supports both backends and per-chat enablement without server settings changes", () => {
    expect(decode({ action: "configure", threadId: "chat", enabled: false })).toMatchObject({
      enabled: false,
    });
    expect(
      decode({
        action: "configure",
        threadId: "chat",
        backend: { kind: "provider", modelSelection: { instanceId: "fake", model: "test-model" } },
      }),
    ).toMatchObject({ backend: { kind: "provider" } });
    expect(
      decode({
        action: "configure",
        threadId: "chat",
        backend: { kind: "local", url: "https://example.invalid/v1/", model: "test" },
      }),
    ).toMatchObject({ backend: { kind: "local" } });
  });
  it("adds optional reasoning identity without changing existing requests", () => {
    expect(decode({ action: "rewrite", threadId: "chat", messageId: "reply" })).toEqual({
      action: "rewrite",
      threadId: "chat",
      messageId: "reply",
    });
    expect(
      decode({
        action: "rewrite",
        threadId: "chat",
        messageId: "steer",
        reasoningItemId: "thought",
      }),
    ).toMatchObject({ reasoningItemId: "thought" });
  });
  it("requires message identity for rewrites and bounds endpoint settings", () => {
    expect(() => decode({ action: "rewrite", threadId: "chat" })).toThrow();
    expect(() =>
      decode({
        action: "configure",
        threadId: "chat",
        backend: { kind: "local", url: "x".repeat(2049), model: "test" },
      }),
    ).toThrow();
  });
  it("can omit the catalog from rewrite replies and guards provider spending at the destination", () => {
    expect(decodeReply({ enabled: true, backend: null })).toEqual({
      enabled: true,
      backend: null,
    });
    expect(clientRpcRequiredScopes(WS_METHODS.casualVoice, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });
  it("keeps mode, the cloud backend and training saves optional on the old wire", () => {
    expect(decode({ action: "get", threadId: "chat" })).toEqual({
      action: "get",
      threadId: "chat",
    });
    expect(
      decode({
        action: "configure",
        threadId: "chat",
        mode: "hybrid",
        saveTraining: false,
        cloudBackend: {
          kind: "provider",
          modelSelection: { instanceId: "fake", model: "cloud-model" },
        },
      }),
    ).toMatchObject({ mode: "hybrid", saveTraining: false, cloudBackend: { kind: "provider" } });
    const hash = "ab".repeat(32);
    expect(decode({ action: "feedback", threadId: "chat", inputHash: hash })).toEqual({
      action: "feedback",
      threadId: "chat",
      inputHash: hash,
    });
    expect(() => decode({ action: "feedback", threadId: "chat", inputHash: "short" })).toThrow();
    expect(
      decodeReply({
        enabled: true,
        backend: null,
        mode: "cloud",
        cloudBackend: null,
        saveTraining: true,
        inputHash: hash,
        models: [
          {
            instanceId: "fake",
            model: "cloud-model",
            name: "Cloud",
            optionDescriptors: [
              {
                id: "thinkingLevel",
                label: "Thinking level",
                type: "select",
                options: [{ id: "medium", label: "Medium" }],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ mode: "cloud", inputHash: hash, saveTraining: true });
  });
});

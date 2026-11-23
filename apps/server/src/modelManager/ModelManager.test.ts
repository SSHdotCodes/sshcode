import {
  isModelManagerThreadId,
  MODEL_MANAGER_THREAD_ID_PREFIX,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { managerMessage, managerModelSelection } from "./ModelManager.ts";

const codex = (instanceId: string, models: ReadonlyArray<string>, enabled = true) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled,
    models: models.map((slug) => ({ slug })),
  }) as unknown as ServerProvider;

describe("model manager", () => {
  it("uses the helper marker already stored by the original Models service", () => {
    expect(isModelManagerThreadId("models:2ce540c1-8eb0-4228-9000-3875511fe4a1")).toBe(true);
    expect(isModelManagerThreadId(`${MODEL_MANAGER_THREAD_ID_PREFIX}new-id`)).toBe(true);
    expect(isModelManagerThreadId("a-user-chat-named-Models")).toBe(false);
  });

  it("runs on GPT-6.1 Terra at high reasoning, else GPT-6 Luna", () => {
    expect(
      managerModelSelection([codex("codex", ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"])]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-terra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(managerModelSelection([codex("codex", ["gpt-6-luna"])])?.model).toBe("gpt-6-luna");
  });

  it("needs a Codex that is on", () => {
    expect(managerModelSelection([codex("codex", ["gpt-6.1-terra"], false)])).toBeNull();
    expect(managerModelSelection([codex("codex", ["gpt-6.1-sol"])])).toBeNull();
  });

  it("falls back to a ready provider's default model without a Codex manager model", () => {
    const claude = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "claude-haiku-5-5", isCustom: false, capabilities: null },
        { slug: "claude-opus-5-5", isCustom: false, isDefault: true, capabilities: null },
      ],
    } as unknown as ServerProvider;
    expect(managerModelSelection([codex("codex", ["gpt-6.1-sol"]), claude])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("names the harness and points at the playbook", () => {
    const message = managerMessage({
      text: "Add https://openrouter.ai/tencent/hy4",
      harness: { instanceId: "pi", driver: "pi", displayName: "Pi", enabled: false },
      playbookPath: "/state/model-manager/PLAYBOOK.md",
    });
    expect(message).toContain("Add https://openrouter.ai/tencent/hy4");
    expect(message).toContain("Harness: Pi (instance `pi`, driver `pi`).");
    expect(message).toContain("Read /state/model-manager/PLAYBOOK.md first");
  });
});

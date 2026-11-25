import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  WorkflowId,
  type ServerProvider,
} from "@t3tools/contracts";
import { validateWorkflow } from "@t3tools/shared/workflows";

import { resolveWorkflowModel, workflowFromBoxes } from "./handlers.ts";

const provider = (instanceId: string, driver: string, slugs: string[]) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    models: slugs.map((slug) => ({ slug, name: slug })),
  }) as unknown as ServerProvider;

const providers = [
  provider("claudeAgent_qwen4", "claudeAgent", ["claude-opus-5-5"]),
  provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-haiku-5-5"]),
  provider("codex", "codex", ["gpt-6.1-sol"]),
  provider("opencode_alt", "opencode", ["anthropic/claude-opus-4-6"]),
  provider("opencode", "opencode", ["anthropic/claude-opus-4-6", "openai/gpt-5.4"]),
];

describe("workflow tool", () => {
  it("resolves bare slugs to the default instance and honors explicit instances", () => {
    expect(resolveWorkflowModel("claude-opus-5-5", providers)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    expect(resolveWorkflowModel("claudeAgent_qwen4/claude-opus-5-5", providers)?.instanceId).toBe(
      "claudeAgent_qwen4",
    );
    expect(resolveWorkflowModel("anthropic/claude-opus-4-6", providers)).toEqual({
      instanceId: "opencode",
      model: "anthropic/claude-opus-4-6",
    });
    expect(resolveWorkflowModel("opencode_alt/anthropic/claude-opus-4-6", providers)).toEqual({
      instanceId: "opencode_alt",
      model: "anthropic/claude-opus-4-6",
    });
    expect(
      resolveWorkflowModel("unknown_instance/anthropic/claude-opus-4-6", providers),
    ).toBeNull();
    expect(resolveWorkflowModel("gpt-0", providers)).toBeNull();
  });

  it("builds a runnable, laid out workflow from boxes", () => {
    const built = workflowFromBoxes({
      id: WorkflowId.make("wf_agent"),
      name: "Release team",
      boxes: [
        { id: "lead", label: "Lead", model: "claude-opus-5-5" },
        { id: "api", label: "API", model: "codex/gpt-6.1-sol", parent: "lead", worktree: true },
        { id: "ui", label: "UI", model: "gpt-6.1-sol", parent: "lead", after: "api" },
        { id: "tests", label: "Tests", model: "claude-haiku-5-5", parent: "api", upTo: true },
      ],
      notes: ["Keep PRs small."],
      existing: undefined,
      providers,
      now: "2026-11-06T17:00:00.000Z",
    });
    if (typeof built === "string") throw new Error(built);
    expect(built.rootNodeId).toBe("lead");
    expect(validateWorkflow(built)).toEqual([]);
    const tests = built.nodes.find((n) => n.id === "tests");
    expect(tests).toMatchObject({ count: { kind: "upTo", max: 8 }, label: "Tests" });
    expect(new Set(built.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(built.nodes.length);
    expect(built.edges.map((e) => `${e.kind}:${e.from}>${e.to}`)).toContain("then:api>ui");
  });

  it("explains bad boxes instead of saving them", () => {
    const base = {
      id: WorkflowId.make("wf"),
      name: "x",
      notes: undefined,
      existing: undefined,
      providers,
      now: "2026-11-06T17:00:00.000Z",
    };
    expect(
      workflowFromBoxes({ ...base, boxes: [{ id: "a", label: "A", model: "nope" }] }),
    ).toContain("Unknown model nope");
    expect(
      workflowFromBoxes({
        ...base,
        boxes: [{ id: "a", label: "A", model: "gpt-6.1-sol", parent: "b" }],
      }),
    ).toContain("missing box b");
  });
});

import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseWorkflowCompile, workflowCompilePrompt } from "./compile.ts";
import { catalog, workflowFixture } from "./fixtures.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const model = "claude-fable-5-2";
const providers = [
  {
    ...catalog[0]!,
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        ...catalog[0]!.models[0]!,
        slug: model,
        name: "Fable 5.2",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
            },
          ],
        },
      },
    ],
  },
];

it("lists provider effort ids and levels in the compact compile catalog", () => {
  const prompt = workflowCompilePrompt(
    { workflow: workflowFixture(), prompt: "Fable 5.2 max orchestrator" },
    providers,
  );
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
  expect(data.models).toEqual([
    {
      instanceId,
      model,
      name: "Fable 5.2",
      effort: [{ id: "effort", levels: ["low", "medium", "high", "max"] }],
    },
  ]);
  expect(prompt).toContain("options?:[{id,value}]");
  expect(prompt).toContain("leave options out when unspecified");
});

it.effect.each(["max", "xhigh", null])(
  "compiles effort %s without failing on an unsupported level",
  (effort) =>
    Effect.gen(function* () {
      const source = workflowFixture();
      const selection = {
        instanceId,
        model,
        ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
      };
      const workflow = {
        ...source,
        nodes: source.nodes.map((node) =>
          node.kind === "agent" ? { ...node, model: selection } : node,
        ),
      };
      const result = yield* parseWorkflowCompile(
        JSON.stringify({ workflow, issues: [], summary: "Resolved" }),
        { workflow: source },
        providers,
      );
      expect(result.workflow.nodes[0]).toMatchObject({
        model: effort === "max" ? selection : { instanceId, model },
      });
      if (effort === "xhigh") {
        for (const node of result.workflow.nodes)
          if (node.kind === "agent") expect(node.model).not.toHaveProperty("options");
        expect(result.issues).toEqual(
          workflow.nodes.map((node) => ({
            nodeId: node.id,
            edgeId: null,
            message:
              'Dropped unsupported effort "xhigh" for Fable 5.2. Available effort levels: low, medium, high, max.',
          })),
        );
      } else expect(result.issues).toEqual([]);
    }),
);

it.effect("drops effort when a model has no effort control", () =>
  Effect.gen(function* () {
    const workflow = workflowFixture();
    const result = yield* parseWorkflowCompile(
      JSON.stringify({
        workflow: {
          ...workflow,
          nodes: workflow.nodes.map((node) =>
            node.kind === "agent"
              ? {
                  ...node,
                  model: { ...node.model!, options: [{ id: "reasoningEffort", value: "max" }] },
                }
              : node,
          ),
        },
        issues: [],
        summary: "Resolved",
      }),
      { workflow },
      catalog,
    );
    expect(result.issues[0]).toMatchObject({
      nodeId: "lead",
      message: expect.stringContaining("Available effort levels: none."),
    });
    expect(result.workflow.nodes[0]).toMatchObject({
      model: workflow.nodes[0]!.kind === "agent" ? workflow.nodes[0]!.model : null,
    });
  }),
);

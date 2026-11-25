import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

import { GrokSettings } from "../settings.ts";
import {
  buildGrokModelsFromSessionModelState,
  checkGrokProviderStatus,
  parseGrokModelsCliOutput,
} from "./status.ts";

it.layer(NodeServices.layer)("Grok status", (it) => {
  it.effect("discovers account models without initializing ACP in the server workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "grok",
        source: `
          import { readdirSync } from "node:fs";
          import { createInterface } from "node:readline";
          switch (process.argv[2]) {
            case "--version": console.log("grok 1.0.92"); break;
            case "models": console.log("You are logged in with grok.com."); break;
            case "inspect": console.log(JSON.stringify({ skills: [] })); break;
            case "agent": {
              if (readdirSync(".").length > 0) process.exit(1);
              for await (const line of createInterface({ input: process.stdin })) {
                const { id } = JSON.parse(line);
                const modelState = {
                  currentModelId: "grok-test",
                  availableModels: [{ modelId: "grok-test", name: "Grok test" }],
                };
                const result = { protocolVersion: 1, agentCapabilities: {}, _meta: { modelState } };
                console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
              }
              break;
            }
          }
        `,
      });
      const path = yield* Path.Path;
      const snapshot = yield* checkGrokProviderStatus(
        yield* Schema.decodeEffect(GrokSettings)({
          enabled: true,
          binaryPath: path.relative(process.cwd(), binaryPath),
        }),
        { ...process.env, XAI_API_KEY: "" },
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-test"]);
    }),
  );
});

it("folds Grok's fast variant into a Fast mode switch on its model", () => {
  const efforts = {
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    reasoningEfforts: [
      { id: "high", value: "high", label: "High", default: true },
      { id: "low", value: "low", label: "Low" },
    ],
  };
  const models = buildGrokModelsFromSessionModelState({
    currentModelId: "grok-4.7-build-fast",
    availableModels: [
      { modelId: "grok-4.7", name: "Grok 4.7", _meta: efforts },
      { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast", _meta: efforts },
      { modelId: "grok-4.6", name: "Grok 4.6", _meta: efforts },
    ],
  });
  expect(models.map((model) => model.slug)).toEqual(["grok-4.7", "grok-4.6"]);
  const [grok47, grok46] = models;
  // The session runs the fast variant: its model is the default with Fast mode on.
  expect(grok47?.isDefault).toBe(true);
  expect(grok47?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
    "reasoningEffort",
    "fastMode",
  ]);
  expect(
    grok47?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "fastMode"),
  ).toMatchObject({ type: "boolean", currentValue: true });
  // A model without a fast variant gets no switch.
  expect(
    grok46?.capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "fastMode"),
  ).toBe(false);
});

it("folds the fast variant in `grok models` output too", () => {
  const { models } = parseGrokModelsCliOutput(
    [
      "You are logged in with grok.com.",
      "Available models:",
      "  * grok-4.7 (default)",
      "  - grok-4.7-build-fast",
      "  - grok-4.6",
    ].join("\n"),
  );
  expect(models.map((model) => model.slug)).toEqual(["grok-4.7", "grok-4.6"]);
  expect(models[0]?.isDefault).toBe(true);
  // No options here: the registry keeps the reasoning and Fast mode the ACP probe last read.
  expect(models[0]?.capabilities?.optionDescriptors ?? []).toEqual([]);
});

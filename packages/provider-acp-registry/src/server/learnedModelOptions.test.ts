import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  makeAcpRegistryLearnedModelOptions,
  rememberModelOptions,
  withSavedModelOptions,
} from "./learnedModelOptions.ts";

const levels = (...ids: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id: "thought_level",
  label: "Thinking",
  type: "select",
  options: ids.map((id) => ({ id, label: id })),
});
const mode: ProviderOptionDescriptor = {
  id: "mode",
  label: "Mode",
  type: "select",
  options: [{ id: "normal", label: "Normal" }],
};
const model = (
  slug: string,
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor> = [],
  isCustom = false,
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom,
  capabilities: createModelCapabilities({ optionDescriptors }),
});
const descriptorIds = (models: ReadonlyArray<ServerProviderModel>) =>
  models.map((entry) => [
    entry.slug,
    (entry.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
  ]);

it.layer(NodeServices.layer)("saved ACP model options", (it) => {
  it.effect("keeps every model's levels across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      const input = { cacheDir, instanceId: ProviderInstanceId.make("acpRegistry_devin") };
      const first = yield* makeAcpRegistryLearnedModelOptions(input);
      yield* first.remember([
        model("swe-2", [mode, levels("medium", "high", "max")]),
        model("gemini-4-hydrogen", [mode, levels("low", "high")]),
        model("adaptive", [mode]),
      ]);
      // After a restart the first check sees only the current model's options.
      const restarted = yield* makeAcpRegistryLearnedModelOptions(input);
      const merged = yield* restarted.withSaved([
        model("swe-2", [mode, levels("medium", "high", "max")]),
        model("gemini-4-hydrogen"),
      ]);
      assert.deepEqual(descriptorIds(merged), [
        ["swe-2", ["mode", "thought_level"]],
        ["gemini-4-hydrogen", ["mode", "thought_level"]],
        ["adaptive", ["mode"]],
      ]);
    }),
  );

  it.effect(
    "restarts from confirmed reads, upgrades legacy entries, and keeps levels across partial updates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheDir = yield* fs.makeTempDirectoryScoped();
        const input = { cacheDir, instanceId: ProviderInstanceId.make("acpRegistry_devin") };
        yield* fs.writeFileString(
          `${cacheDir}/acp-model-options-acpRegistry_devin.json`,
          JSON.stringify([
            { slug: "legacy", optionDescriptors: [mode, levels("high")] },
            { slug: "unread", optionDescriptors: [mode] },
          ]),
        );
        const first = yield* makeAcpRegistryLearnedModelOptions(input);
        assert.deepEqual([...(yield* first.readModelIds)], []);
        yield* first.remember(
          [
            model("empty"),
            model("adaptive", [mode]),
            model("legacy", [mode]),
            model("unread", [mode]),
          ],
          new Set(["empty", "adaptive"]),
        );
        const restarted = yield* makeAcpRegistryLearnedModelOptions(input);
        assert.deepEqual([...(yield* restarted.readModelIds)].sort(), ["adaptive", "empty"]);
        assert.deepEqual(descriptorIds(yield* restarted.withSaved([model("legacy")]))[0], [
          "legacy",
          ["mode", "thought_level"],
        ]);
        yield* restarted.remember([model("legacy")], new Set(["legacy"]));
        assert.deepEqual(descriptorIds(yield* restarted.withSaved([model("legacy")]))[0], [
          "legacy",
          [],
        ]);
      }),
  );

  it.effect("starts empty when the file is missing or unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${cacheDir}/acp-model-options-acpRegistry_devin.json`, "{");
      const saved = yield* makeAcpRegistryLearnedModelOptions({
        cacheDir,
        instanceId: ProviderInstanceId.make("acpRegistry_devin"),
      });
      assert.deepEqual(descriptorIds(yield* saved.withSaved([model("swe-2")])), [["swe-2", []]]);
    }),
  );
});

it("lets a model that reports more options keep them and skips custom models", () => {
  const saved = rememberModelOptions(
    [],
    [model("swe-2", [mode, levels("high")]), model("mine", [mode], true)],
  );
  assert.deepEqual(
    descriptorIds(
      withSavedModelOptions(
        [model("swe-2", [mode, levels("high"), { ...mode, id: "speed" }]), model("mine", [], true)],
        saved,
      ),
    ),
    [
      ["swe-2", ["mode", "thought_level", "speed"]],
      ["mine", []],
    ],
  );
});

it("replaces a model's saved options when it reports new ones and keeps the rest", () => {
  const saved = rememberModelOptions(
    [],
    [model("swe-2", [levels("high")]), model("glm-5-2", [levels("none", "max")])],
  );
  const next = rememberModelOptions(saved, [
    model("swe-2", [levels("medium", "max")]),
    model("glm-5-2"),
  ]);
  assert.deepEqual(
    next.map((entry) => [
      entry.slug,
      entry.optionDescriptors.flatMap((descriptor) =>
        descriptor.type === "select" ? descriptor.options.map((option) => option.id) : [],
      ),
    ]),
    [
      ["swe-2", ["medium", "max"]],
      ["glm-5-2", ["none", "max"]],
    ],
  );
});

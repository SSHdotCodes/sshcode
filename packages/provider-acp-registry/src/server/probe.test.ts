import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { isListedAcpRegistryModel, readAcpRegistryModelOptions } from "./probe.ts";

const MODELS = ["swe-2-high", "adaptive", "opus-medium", "fusion-a", "fusion-keep"];
// Devin's shape: the effort and speed options describe only the session's current model.
const OWN_EFFORTS: Record<string, ReadonlyArray<string>> = {
  "swe-2-high": ["medium", "high", "max"],
  "opus-medium": ["low", "medium", "high", "xhigh", "max"],
};

function configFor(
  modelId: string,
  models = MODELS,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  const efforts = OWN_EFFORTS[modelId];
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "smart",
      options: [{ value: "smart", name: "Smart" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelId,
      options: models.map((value) => ({ value, name: value })),
    },
    ...(efforts === undefined
      ? []
      : [
          {
            id: "thought_level",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: efforts[0]!,
            options: efforts.map((value) => ({ value, name: value })),
          } as const,
        ]),
  ];
}

function fakeRuntime(switches: Array<string>, failOn?: string) {
  return {
    setConfigOption: (configId: string, value: string | boolean) => {
      switches.push(`${configId}=${String(value)}`);
      return value === failOn
        ? Effect.die("unused failure path")
        : Effect.succeed({ configOptions: configFor(String(value)) });
    },
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
}

function started(modelId: string) {
  return {
    sessionSetupResult: { sessionId: "probe", configOptions: configFor(modelId) },
  } as unknown as AcpSessionRuntime.AcpSessionRuntimeStartResult;
}

describe("readAcpRegistryModelOptions", () => {
  it.effect("reads each listed model's own options, then switches back", () =>
    Effect.gen(function* () {
      const switches: Array<string> = [];
      const found = yield* readAcpRegistryModelOptions(
        fakeRuntime(switches),
        started("swe-2-high"),
        ["fusion-", "!fusion-keep"],
      );
      expect(switches).toEqual([
        "model=adaptive",
        "model=opus-medium",
        "model=fusion-keep",
        "model=swe-2-high",
      ]);
      expect(found.get("adaptive")).toEqual([]);
      expect(found.get("fusion-keep")).toEqual([]);
      expect(found.has("fusion-a")).toBe(false);
      expect(found.get("opus-medium")).toMatchObject([
        {
          id: "thought_level",
          role: "reasoning",
          options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
        },
      ]);
    }),
  );

  it.effect("reads models an earlier check missed before the ones it knows", () =>
    Effect.gen(function* () {
      const switches: Array<string> = [];
      yield* readAcpRegistryModelOptions(
        fakeRuntime(switches),
        started("swe-2-high"),
        [],
        [
          {
            slug: "adaptive",
            name: "Adaptive",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
          {
            slug: "opus-medium",
            name: "Opus",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "thought_level",
                  label: "Thinking",
                  type: "select",
                  options: [{ id: "low", label: "low" }],
                  currentValue: "low",
                },
              ],
            },
          },
        ],
      );
      expect(switches).toEqual([
        "model=adaptive",
        "model=fusion-a",
        "model=fusion-keep",
        "model=opus-medium",
        "model=swe-2-high",
      ]);
    }),
  );

  it.effect("fills a slow Devin catalog across three checks, including models with no effort", () =>
    Effect.gen(function* () {
      const models = [
        "adaptive",
        ...Array.from({ length: 57 }, (_, i) => `model-${i}`),
        "opus-medium",
        "swe-2-high",
      ];
      const read = new Set<string>();
      const attempts: string[] = [];
      const runtime = {
        setConfigOption: (_: string, id: string) =>
          Effect.gen(function* () {
            attempts.push(id);
            yield* Effect.sleep("3100 millis");
            return { configOptions: configFor(id, models) };
          }),
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
      const session = {
        sessionSetupResult: { sessionId: "probe", configOptions: configFor("adaptive", models) },
      } as AcpSessionRuntime.AcpSessionRuntimeStartResult;
      for (let check = 0; check < 3; check++) {
        const fiber = yield* readAcpRegistryModelOptions(runtime, session, [], [], {
          readModelIds: read,
          probeWithoutInitialOptions: true,
          onProgress: () => Effect.void,
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("2 minutes");
        const found = yield* Fiber.join(fiber);
        for (const id of found.keys()) read.add(id);
        if (found.has("opus-medium"))
          expect(found.get("opus-medium")?.[0]?.id).toBe("thought_level");
      }
      expect(read.size).toBe(models.length);
      const firstLateModel = attempts.indexOf("opus-medium");
      expect(firstLateModel).toBeGreaterThan(0);
      expect(attempts.slice(0, firstLateModel).filter((id) => id === "model-0")).toHaveLength(1);
    }),
  );

  it.effect("restores the original selection when a foreground startup preempts a sweep", () =>
    Effect.gen(function* () {
      const switching = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const runtime = {
        setConfigOption: (_: string, model: string) =>
          Effect.gen(function* () {
            attempted.push(model);
            if (model === "opus-medium") {
              yield* Deferred.succeed(switching, undefined);
              return yield* Effect.never;
            }
            return { configOptions: configFor(model) };
          }),
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
      const sweep = yield* readAcpRegistryModelOptions(runtime, started("swe-2-high"), []).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(switching);
      yield* Fiber.interrupt(sweep);
      expect(attempted).toEqual(["adaptive", "opus-medium", "swe-2-high"]);
    }),
  );

  it.effect("leaves agents whose options never depend on the model alone", () =>
    Effect.gen(function* () {
      const switches: Array<string> = [];
      const found = yield* readAcpRegistryModelOptions(
        fakeRuntime(switches),
        started("adaptive"),
        [],
      );
      expect(switches).toEqual([]);
      expect(found.size).toBe(0);
    }),
  );
});

describe("isListedAcpRegistryModel", () => {
  it("hides prefixed models unless a '!' entry keeps them", () => {
    const hidden = ["fusion-", "!fusion-keep", ""];
    expect(
      ["swe-2-high", "fusion-a", "fusion-keep-x"].map((id) => isListedAcpRegistryModel(id, hidden)),
    ).toEqual([true, false, true]);
  });
});

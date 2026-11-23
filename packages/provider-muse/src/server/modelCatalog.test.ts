import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MuseSdkHost } from "./sdk.ts";
import {
  discoverMuseModels,
  museModelCapabilities,
  resolveMuseReasoningEffort,
  museModelName,
  museContributorMode,
  museSelectionTransition,
} from "./modelCatalog.ts";

const settings = Schema.decodeSync(MuseSettings)({});
const host = (catalog: Record<string, unknown>): MuseSdkHost => ({
  connection: {
    request: async () => catalog,
    command: async () => ({}),
    mintCommandId: () => "test",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise<void>(() => {}),
  },
  initializeResult: { grantedCapabilities: [] },
  exited: new Promise(() => {}),
  close: async () => {},
});

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  displayLabel: modelId,
  providerId: "meta",
  profileId: "tbh",
  isDefault: false,
  contextLimit: 1_000_000,
  ...extra,
});

describe("museModelName", () => {
  it("says an id-only label as a name and keeps a real label", () => {
    expect(museModelName("muse-wonder-full-1.0", "muse-wonder-full-1.0")).toBe(
      "Muse Wonder Full 1.0",
    );
    expect(museModelName("muse-spark-1.3-contributor", "")).toBe("Muse Spark 1.3 Contributor");
    expect(museModelName("restful-walrus", " Restful Walrus ")).toBe("Restful Walrus");
  });
});

describe("contributor mode option", () => {
  const selection = (value?: boolean): ModelSelection => ({
    instanceId: ProviderInstanceId.make("muse"),
    model: "muse-wonder-1.0",
    ...(value === undefined ? {} : { options: [{ id: "contributorMode", value }] }),
  });

  it("is on only when the chat says so", () => {
    expect(museContributorMode(selection())).toBe(false);
    expect(museContributorMode(selection(false))).toBe(false);
    expect(museContributorMode(selection(true))).toBe(true);
    expect(museContributorMode(null)).toBe(false);
  });

  it("is never on, and not offered, for a model Muse refuses in that mode", () => {
    const ember: ModelSelection = { ...selection(true), model: "muse-ember-1.0" };
    expect(museContributorMode(ember)).toBe(false);
    // Moving a chat that has it on to such a model needs a host without it.
    expect(museSelectionTransition({ current: selection(true), target: ember })).toEqual({
      type: "restart_session",
    });
    const ids = (modelId: string) =>
      museModelCapabilities({ modelId, variants: ["high"] }).optionDescriptors?.map(
        (descriptor) => descriptor.id,
      );
    expect(ids("muse-ember-1.0")).toEqual(["reasoningEffort"]);
    expect(ids("muse-wonder-full-1.0")).toEqual(["reasoningEffort", "contributorMode"]);
    expect(ids("muse-spark-1.3")).toEqual(["reasoningEffort", "contributorMode"]);
  });

  it("restarts the host when it changes and applies other choices on the next turn", () => {
    expect(museSelectionTransition({ current: selection(), target: selection(true) })).toEqual({
      type: "restart_session",
    });
    expect(museSelectionTransition({ current: selection(true), target: selection(false) })).toEqual(
      { type: "restart_session" },
    );
    expect(
      museSelectionTransition({
        current: selection(),
        target: { ...selection(false), model: "muse-ember-1.0" },
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });
});

describe("Muse model catalog", () => {
  it.effect("uses the labels, efforts and defaults that model/list sends", () =>
    Effect.gen(function* () {
      const models = yield* discoverMuseModels(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          profileId: "tbh",
          source: "providerCatalog",
          models: [
            row("restful-walrus", {
              displayLabel: " Restful Walrus ",
              isDefault: true,
              variants: ["minimal", "low", "high", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
            row("older-host"),
            row("unknown-efforts", { variants: "unknown" }),
            row("foreign", { providerId: "another" }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["restful-walrus", "Restful Walrus", true],
        ["older-host", "Older Host", false],
        ["unknown-efforts", "Unknown Efforts", false],
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
        {
          id: "contributorMode",
          label: "Contributor mode",
          type: "boolean",
          description: "More usage from your plan. Meta may use this chat to train its models.",
          currentValue: false,
          trainsOnContent: true,
        },
      ]);
      // Older hosts and "unknown" fall back to Muse's documented tiers.
      expect(models[1]?.capabilities).toEqual(museModelCapabilities());
      expect(models[2]?.capabilities).toEqual(museModelCapabilities());
    }),
  );

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("max");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });

  it("moves a tier the model does not offer to its nearest offered tier, not the default", () => {
    const capped = museModelCapabilities({
      variants: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    });
    expect(resolveMuseReasoningEffort(capped, "max")).toBe("xhigh");
    expect(resolveMuseReasoningEffort(capped, "minimal")).toBe("low");
    expect(resolveMuseReasoningEffort(capped, "not-a-tier")).toBe("medium");
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  recommendAutoModel,
  type AutoModelCandidate,
  type RecommendAutoModelInput,
} from "./recommendAutoModel.logic.ts";

const selection = (model: string) => ({ instanceId: "provider", model });
const candidate = (model: string, quality: number): AutoModelCandidate => ({
  selection: selection(model),
  label: model,
  quality,
  available: true,
});
const now = 40 * 86400000;
const base: RecommendAutoModelInput = {
  difficulty: { tier: "fast", confidence: 0.85 },
  text: "rename foo to bar",
  attachmentCount: 0,
  currentSelection: selection("current"),
  candidates: [
    candidate("quality", 100),
    candidate("usual-big", 90),
    candidate("speed", 75),
    candidate("cheap", 60),
    candidate("usual-fast", 70),
  ],
  history: [],
  picks: { quality: selection("quality"), speed: selection("speed"), frugal: selection("cheap") },
  now,
};
const chat = (model: string, extra = {}) => ({
  createdBy: "user",
  createdAt: now - 1000,
  modelSelection: selection(model),
  ...extra,
});

describe("recommendAutoModel", () => {
  it("uses the Speed and Quality picks without owner history", () => {
    expect(recommendAutoModel(base)?.selection.model).toBe("speed");
    expect(
      recommendAutoModel({ ...base, difficulty: { tier: "big", confidence: 0.9 } })?.selection
        .model,
    ).toBe("quality");
  });
  it("stays quiet when the current model is already the kind the task needs", () => {
    const hard = {
      ...base,
      difficulty: { tier: "big" as const, confidence: 0.9 },
      history: [chat("usual-big")],
    };
    // On the strongest model: no nudge towards the usual big one.
    expect(recommendAutoModel({ ...hard, currentSelection: selection("quality") })).toBeNull();
    expect(
      recommendAutoModel({ ...hard, currentSelection: selection("speed") })?.selection.model,
    ).toBe("usual-big");
    // A simple task on a fast model needs nothing; on a big one it gets the fast pick.
    expect(recommendAutoModel({ ...base, currentSelection: selection("usual-fast") })).toBeNull();
    expect(
      recommendAutoModel({ ...base, currentSelection: selection("quality") })?.selection.model,
    ).toBe("speed");
  });

  it("counts owner-started chats in the last 30 days in the matching quality band", () => {
    const history = [
      chat("usual-fast"),
      chat("usual-fast"),
      chat("speed"),
      ...Array.from({ length: 4 }, () => chat("cheap", { createdBy: "agent" })),
      ...Array.from({ length: 4 }, () => chat("cheap", { createdAt: now - 31 * 86400000 })),
      chat("usual-big"),
      chat("usual-big"),
      chat("cheap", { createdAt: now + 1 }),
    ];
    expect(recommendAutoModel({ ...base, history })?.selection.model).toBe("usual-fast");
    expect(
      recommendAutoModel({ ...base, history, difficulty: { tier: "big", confidence: 0.9 } })
        ?.selection.model,
    ).toBe("usual-big");
  });
  it("aggregates model choices across efforts and restores that model's usual options", () => {
    const low = { ...selection("usual-fast"), options: [{ id: "reasoningEffort", value: "low" }] };
    const history = [
      chat("speed"),
      chat("speed"),
      chat("usual-fast"),
      chat("usual-fast", { modelSelection: low }),
      chat("usual-fast", { modelSelection: low }),
    ];
    expect(recommendAutoModel({ ...base, history })?.selection).toEqual(low);
  });
  it("breaks tied choices by recency", () => {
    expect(
      recommendAutoModel({
        ...base,
        history: [
          chat("speed", { createdAt: now - 2 }),
          chat("usual-fast", { createdAt: now - 1 }),
        ],
      })?.selection.model,
    ).toBe("usual-fast");
  });
  it.each([10, 0])("uses Low cost when Speed has %s percent remaining", (remainingPercent) => {
    expect(
      recommendAutoModel({
        ...base,
        candidates: base.candidates.map((c) =>
          c.selection.model === "speed" ? { ...c, remainingPercent } : c,
        ),
      })?.selection.model,
    ).toBe("cheap");
  });
  it("keeps Speed below 90% used", () => {
    expect(
      recommendAutoModel({
        ...base,
        candidates: base.candidates.map((c) => ({ ...c, remainingPercent: 10.01 })),
      })?.selection.model,
    ).toBe("speed");
  });
  it.each([
    { available: false },
    { disabled: true },
    { legacy: true },
    { superseded: true },
    { remainingPercent: 0 },
  ])("never returns an ineligible favorite or fallback: %j", (flags) => {
    const candidates = base.candidates.map((c) =>
      ["speed", "usual-fast"].includes(c.selection.model) ? { ...c, ...flags } : c,
    );
    const result = recommendAutoModel({ ...base, candidates, history: [chat("usual-fast")] });
    expect(result?.selection.model === "usual-fast" || result?.selection.model === "speed").toBe(
      false,
    );
  });
  it("suppresses low confidence, empty/short drafts, equal models, and missing evidence", () => {
    expect(
      recommendAutoModel({ ...base, difficulty: { tier: "fast", confidence: 0.69 } }),
    ).toBeNull();
    expect(recommendAutoModel({ ...base, text: "  commit  " })).toBeNull();
    expect(recommendAutoModel({ ...base, text: "", attachmentCount: 1 })).not.toBeNull();
    expect(
      recommendAutoModel({
        ...base,
        currentSelection: { ...selection("speed"), options: [{ id: "effort", value: "high" }] },
      }),
    ).toBeNull();
    expect(recommendAutoModel({ ...base, candidates: [] })).toBeNull();
  });
});

it("counts the same model across routes before choosing its usual selection", () => {
  const alternate = { instanceId: "alternate", model: "usual-fast-alias" };
  const candidates = [
    ...base.candidates.map((c) =>
      c.selection.model === "usual-fast" ? { ...c, key: "same-model" } : c,
    ),
    { ...candidate("usual-fast-alias", 70), key: "same-model", selection: alternate },
  ];
  const history = [
    chat("usual-fast"),
    chat("usual-fast"),
    chat("usual-fast", { modelSelection: alternate }),
    chat("usual-fast", { modelSelection: alternate }),
    chat("speed"),
    chat("speed"),
    chat("speed"),
  ];
  const result = recommendAutoModel({ ...base, candidates, history });
  expect(["usual-fast", "usual-fast-alias"]).toContain(result?.selection.model);
});

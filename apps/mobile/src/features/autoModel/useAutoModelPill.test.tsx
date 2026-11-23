// @vitest-environment jsdom
import type { AutoModelRecommendation } from "@t3tools/shared/autoModel/recommendAutoModel";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAutoModelPill } from "./useAutoModelPill";

let pill: ReturnType<typeof useAutoModelPill>;
function PillProbe(props: {
  readonly recommendation: AutoModelRecommendation | null;
  readonly allowed: boolean;
  readonly explain: boolean;
}) {
  const state = useAutoModelPill(props.recommendation, props.allowed, props.explain);
  useLayoutEffect(() => {
    pill = state;
  });
  return null;
}

const suggestion: AutoModelRecommendation = {
  tier: "fast",
  confidence: 0.9,
  selection: { instanceId: "provider", model: "small" },
  label: "Small",
};

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const renderPill = (
  recommendation: AutoModelRecommendation | null,
  allowed = true,
  explain = false,
) =>
  act(() =>
    root.render(<PillProbe recommendation={recommendation} allowed={allowed} explain={explain} />),
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("Auto model pill lifetime", () => {
  it("says it is staying on the model when a shown suggestion is taken back, then fades", () => {
    renderPill(suggestion, true, true);
    renderPill(null, true, true);
    // Still on screen, now as the note; it does not leave at once.
    expect(pill.withdrawn).toBe(true);
    expect(pill.exiting).toBe(false);
    expect(pill.displayed).toBe(suggestion);
    advance(1799);
    expect(pill.exiting).toBe(false);
    advance(1);
    expect(pill.exiting).toBe(true);
    expect(pill.withdrawn).toBe(true);
    advance(180);
    expect(pill.displayed).toBeNull();
    expect(pill.withdrawn).toBe(false);
  });

  it("drops the note for a new suggestion, and never shows it after a dismissal", () => {
    renderPill(suggestion, true, true);
    renderPill(null, true, true);
    const big = { ...suggestion, tier: "big" as const };
    renderPill(big, true, true);
    expect(pill.withdrawn).toBe(false);
    expect(pill.displayed).toBe(big);
    advance(3000);
    expect(pill.displayed).toBe(big);
    // Dismissed, taken or sent: the draft is no longer eligible, so it just fades.
    renderPill(big, false, true);
    expect(pill.withdrawn).toBe(false);
    expect(pill.exiting).toBe(true);
    advance(180);
    expect(pill.displayed).toBeNull();
  });

  it("just fades a taken-back suggestion when the prompt is too short to judge", () => {
    renderPill(suggestion, true, false);
    renderPill(null, true, false);
    expect(pill.withdrawn).toBe(false);
    expect(pill.exiting).toBe(true);
    advance(180);
    expect(pill.displayed).toBeNull();
  });

  it("shows acceptance briefly and fades without a note", () => {
    renderPill(suggestion, true, true);
    act(() => pill.acknowledge());
    renderPill(suggestion, false, true);
    expect(pill.acknowledged).toBe(true);
    expect(pill.withdrawn).toBe(false);
    advance(650);
    expect(pill.exiting).toBe(true);
    advance(180);
    expect(pill.displayed).toBeNull();
  });
});

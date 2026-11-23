import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAutoModelEvaluation } from "./useAutoModelEvaluation";
import { useAutoModelPill } from "./useAutoModelPill";
import type { AutoModelRecommendation } from "@t3tools/shared/autoModel/recommendAutoModel";

let root: Root;
const onEvaluation = vi.fn<Parameters<typeof useAutoModelEvaluation>[0]["onEvaluation"]>();
const base: Parameters<typeof useAutoModelEvaluation>[0] = {
  enabled: true,
  text: "rename foo to bar",
  attachmentCount: 0,
  currentSelection: { instanceId: "provider", model: "current" },
  candidates: [
    {
      selection: { instanceId: "provider", model: "small" },
      label: "Small",
      quality: 70,
      available: true,
    },
    {
      selection: { instanceId: "provider", model: "large" },
      label: "Large",
      quality: 100,
      available: true,
    },
  ],
  getHistory: () => [],
  picks: {
    speed: { instanceId: "provider", model: "small" },
    quality: { instanceId: "provider", model: "large" },
    frugal: null,
  },
  onEvaluation,
};
function Probe(props: typeof base) {
  useAutoModelEvaluation(props);
  return null;
}
const render = async (patch: Partial<typeof base> = {}) => {
  await act(() => root.render(<Probe {...base} {...patch} />));
};
const advance = async (ms: number) => {
  await act(() => vi.advanceTimersByTime(ms));
};

beforeEach(() => {
  vi.useFakeTimers();
  onEvaluation.mockClear();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget, setTimeout, clearTimeout });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("first-prompt Auto evaluation", () => {
  it("waits for 400ms of stillness and replaces a pending classification when typing continues", async () => {
    await render();
    await advance(399);
    expect(onEvaluation).not.toHaveBeenCalled();
    await render({ text: "design a parser and refactor the call sites" });
    await advance(399);
    expect(onEvaluation).not.toHaveBeenCalled();
    await advance(1);
    expect(onEvaluation).toHaveBeenCalledTimes(1);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("large");
    await render();
    await advance(400);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("small");
  });
  it("clears a suggestion without classifying an empty or short draft", async () => {
    await render();
    await advance(400);
    await render({ text: "short" });
    await advance(400);
    expect(onEvaluation.mock.lastCall).toEqual([null, null]);
  });
  it("cancels pending work after send, opt-out, dismissal or a manual model choice", async () => {
    await render();
    await advance(200);
    await render({ enabled: false });
    await advance(1000);
    expect(onEvaluation).not.toHaveBeenCalled();
    await render({ enabled: false, text: "research a new architecture" });
    await advance(1000);
    expect(onEvaluation).not.toHaveBeenCalled();
  });
  it("keeps waiting through unrelated updates that hand it new arrays and callbacks", async () => {
    await render();
    // Other chats updating, a provider refresh: same content, new identities, every 300ms.
    for (let i = 0; i < 3; i++) {
      await advance(300);
      await render({
        candidates: base.candidates.map((candidate) => ({ ...candidate })),
        getHistory: () => [],
        picks: { ...base.picks },
        currentSelection: { ...base.currentSelection },
      });
    }
    // 900ms after the last keystroke the 400ms wait has long ended: evaluated exactly once.
    expect(onEvaluation).toHaveBeenCalledTimes(1);
    expect(onEvaluation.mock.calls[0]?.[1]?.selection.model).toBe("small");
  });

  it("evaluates again when the evidence arrives after the prompt was typed", async () => {
    await render({ candidates: [], picks: { speed: null, quality: null, frugal: null } });
    await advance(400);
    expect(onEvaluation.mock.calls.at(-1)?.[1]).toBeNull();
    await render();
    await advance(400);
    expect(onEvaluation.mock.calls.at(-1)?.[1]?.selection.model).toBe("small");
  });

  it("does not rerun on an unrelated render and cancels on draft unmount", async () => {
    await render();
    await advance(400);
    await render();
    await advance(1000);
    expect(onEvaluation).toHaveBeenCalledTimes(1);
    await render({ text: "debug the cache" });
    await act(() => root.render(null));
    await advance(1000);
    expect(onEvaluation).toHaveBeenCalledTimes(1);
  });
});

describe("first-prompt Auto evaluation with a decision model", () => {
  const pending = () => {
    let answer!: (quick: number | null) => void;
    const decide = vi.fn(
      (_input: { text: string; attachmentCount: number }) =>
        new Promise<number | null>((resolve) => {
          answer = resolve;
        }),
    );
    return { decide, answer: (quick: number | null) => act(async () => answer(quick)) };
  };

  it("asks once typing pauses and lets a hard verdict overrule the local model", async () => {
    const { decide, answer } = pending();
    await render({ decide, text: "  rename foo to bar  " });
    await advance(400);
    expect(decide).toHaveBeenCalledWith({ text: "rename foo to bar", attachmentCount: 0 });
    // Nothing is shown on the local model's word while the answer is on its way.
    expect(onEvaluation).not.toHaveBeenCalled();
    await answer(0.02);
    expect(onEvaluation).toHaveBeenCalledTimes(1);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("large");
  });

  it("uses the local model alone when the server has no answer", async () => {
    const { decide, answer } = pending();
    await render({ decide });
    await advance(400);
    await answer(null);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("small");
  });

  it("stops waiting after 1.5s, and still takes the answer when it comes late", async () => {
    const { decide, answer } = pending();
    await render({ decide });
    await advance(400 + 1499);
    expect(onEvaluation).not.toHaveBeenCalled();
    await advance(1);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("small");
    await answer(0.02);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("large");
  });

  it("drops an answer for a draft that has changed since, and a failed request", async () => {
    const first = pending();
    await render({ decide: first.decide });
    await advance(400);
    const failing = vi.fn(() => Promise.reject(new Error("offline")));
    await render({ decide: failing, text: "rename foo to baz" });
    await first.answer(0.02);
    expect(onEvaluation).not.toHaveBeenCalled();
    await advance(400);
    await act(async () => {});
    expect(onEvaluation).toHaveBeenCalledTimes(1);
    expect(onEvaluation.mock.lastCall?.[1]?.selection.model).toBe("small");
  });

  it("never sends a draft that is too short to judge, and caps a long one", async () => {
    const { decide } = pending();
    await render({ decide, text: "short" });
    await advance(400);
    expect(decide).not.toHaveBeenCalled();
    await render({ decide, text: "x".repeat(9000) });
    await advance(400);
    expect(decide.mock.lastCall?.[0].text).toHaveLength(2500);
  });
});

let pill: ReturnType<typeof useAutoModelPill>;
function PillProbe({
  recommendation,
  allowed,
  explain = false,
}: {
  recommendation: AutoModelRecommendation | null;
  allowed: boolean;
  explain?: boolean;
}) {
  const state = useAutoModelPill(recommendation, allowed, explain);
  useLayoutEffect(() => {
    pill = state;
  });
  return null;
}
const suggestion: AutoModelRecommendation = {
  tier: "fast",
  confidence: 0.85,
  selection: { instanceId: "provider", model: "small" },
  label: "Small",
};
const renderPill = async (
  recommendation: AutoModelRecommendation | null,
  allowed = true,
  explain = false,
) => {
  await act(() =>
    root.render(<PillProbe recommendation={recommendation} allowed={allowed} explain={explain} />),
  );
};
describe("Auto model pill lifetime", () => {
  it("updates the tier in place, then keeps the last label for the 180ms exit", async () => {
    await renderPill(suggestion);
    expect(pill.displayed?.tier).toBe("fast");
    const big = { ...suggestion, tier: "big" as const };
    await renderPill(big);
    expect(pill.displayed?.tier).toBe("big");
    await renderPill(null);
    expect(pill.exiting).toBe(true);
    await advance(179);
    expect(pill.displayed).toBe(big);
    await advance(1);
    expect(pill.displayed).toBeNull();
  });
  it("says it is staying on the model when a shown suggestion is taken back, then fades", async () => {
    await renderPill(suggestion, true, true);
    await renderPill(null, true, true);
    // Still on screen, now as the note; it does not leave at once.
    expect(pill.withdrawn).toBe(true);
    expect(pill.exiting).toBe(false);
    expect(pill.displayed).toBe(suggestion);
    await advance(1799);
    expect(pill.exiting).toBe(false);
    await advance(1);
    expect(pill.exiting).toBe(true);
    expect(pill.withdrawn).toBe(true);
    await advance(180);
    expect(pill.displayed).toBeNull();
    expect(pill.withdrawn).toBe(false);
  });
  it("drops the note for a new suggestion, and never shows it after a dismissal", async () => {
    await renderPill(suggestion, true, true);
    await renderPill(null, true, true);
    const big = { ...suggestion, tier: "big" as const };
    await renderPill(big, true, true);
    expect(pill.withdrawn).toBe(false);
    expect(pill.displayed).toBe(big);
    await advance(3000);
    expect(pill.displayed).toBe(big);
    // Dismissed, taken or sent: the draft is no longer eligible, so it just fades.
    await renderPill(big, false, true);
    expect(pill.withdrawn).toBe(false);
    expect(pill.exiting).toBe(true);
    await advance(180);
    expect(pill.displayed).toBeNull();
  });
  it("shows acceptance briefly and fades without reopening when evaluation is suppressed", async () => {
    await renderPill(suggestion);
    await act(() => pill.acknowledge());
    await renderPill(suggestion, false);
    expect(pill.acknowledged).toBe(true);
    await advance(650);
    expect(pill.exiting).toBe(true);
    await advance(180);
    expect(pill.displayed).toBeNull();
    await advance(1000);
    expect(pill.displayed).toBeNull();
  });
});

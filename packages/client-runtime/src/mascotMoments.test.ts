import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createMascotPetting,
  createTurnMascotMoments,
  MASCOT_BUBBLE_COOLDOWN_MS,
  MASCOT_BUBBLE_MS,
  MASCOT_REACTION_MS,
  pettedMascotState,
  type TurnMascotSnapshot,
} from "./mascotMoments.ts";

describe("petting", () => {
  it("escalates gentle pets, ignores rapid taps, then rests before greeting again", () => {
    const petting = createMascotPetting();
    expect(petting.pet(0)).toEqual({ state: "greet", hearts: 1 });
    expect(petting.pet(100)).toBeNull();
    expect(petting.pet(500)).toEqual({ state: "idea", hearts: 2 });
    expect(petting.pet(1000)).toEqual({ state: "idea", hearts: 3 });
    expect(petting.pet(8999)).toBeNull();
    expect(petting.pet(9000)).toEqual({ state: "greet", hearts: 1 });
  });

  it("starts a fresh greeting after a pause and keeps work and approval poses readable", () => {
    const petting = createMascotPetting();
    petting.pet(0);
    const reaction = petting.pet(3000);
    expect(reaction?.hearts).toBe(1);
    expect(pettedMascotState("idle", reaction)).toBe("greet");
    expect(pettedMascotState("working", reaction)).toBe("working");
    expect(pettedMascotState("waiting", reaction)).toBe("waiting");
    expect(pettedMascotState("failed", reaction)).toBe("failed");
  });
});

describe("turn moments", () => {
  let shown: TurnMascotSnapshot;
  let moments: ReturnType<typeof createTurnMascotMoments>;
  const update = (status: string, waiting = false, threadKey = "chat-a") =>
    moments.update({ threadKey, working: status === "running", waiting, status });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    moments = createTurnMascotMoments((snapshot) => {
      shown = snapshot;
    });
  });
  afterEach(() => {
    moments.dispose();
    vi.useRealTimers();
  });

  it("opens completed and failed history quietly", () => {
    update("completed");
    expect(shown).toMatchObject({ state: "idle", moment: null });
    update("failed", false, "chat-b");
    expect(shown).toMatchObject({ state: "idle", moment: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reacts only to a witnessed completion and clears itself without polling", () => {
    update("running");
    update("completed");
    expect(shown).toMatchObject({ state: "done", moment: null });
    vi.advanceTimersByTime(MASCOT_REACTION_MS);
    expect(shown.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not carry reactions or a milestone count into another chat", () => {
    for (let turn = 0; turn < 4; turn++) {
      update("running");
      update("completed");
    }
    update("running");
    update("completed", false, "chat-b");
    expect(shown).toMatchObject({ threadKey: "chat-b", state: "idle", moment: null });
    update("running", false, "chat-b");
    update("completed", false, "chat-b");
    expect(shown.moment).toBeNull();
  });

  it("does not count the same run again during optimistic send work", () => {
    const observe = (working: boolean, status: string, runKey: string) =>
      moments.update({ threadKey: "chat-a", working, waiting: false, status, runKey });
    observe(false, "completed", "old-run");
    observe(true, "completed", "old-run");
    observe(false, "completed", "old-run");
    expect(shown.state).toBe("idle");
    for (let turn = 1; turn <= 5; turn++) {
      const runKey = `run-${turn}`;
      observe(true, "running", runKey);
      observe(false, "completed", runKey);
      expect(shown.moment?.kind ?? null).toBe(turn === 5 ? "milestone" : null);
      observe(true, "completed", runKey);
      observe(false, "completed", runKey);
      expect(shown.state).toBe("idle");
    }
  });

  it("shows one small milestone on the fifth completed turn, excluding failures", () => {
    update("running");
    update("failed");
    for (let turn = 1; turn <= 5; turn++) {
      update("running");
      update("completed");
      expect(shown.moment?.kind ?? null).toBe(turn === 5 ? "milestone" : null);
    }
    vi.advanceTimersByTime(MASCOT_BUBBLE_MS);
    expect(shown.moment).toBeNull();
    for (let turn = 0; turn < 5; turn++) {
      update("running");
      update("completed");
    }
    expect(shown.moment).toBeNull();
  });

  it("waits before a prompt, cancels short waits, and never prompts on loaded approvals", () => {
    update("running", true);
    vi.advanceTimersByTime(1500);
    expect(shown.moment).toBeNull();
    update("running");
    update("running", true);
    vi.advanceTimersByTime(1000);
    update("running");
    vi.advanceTimersByTime(500);
    expect(shown.moment).toBeNull();
    update("running", true);
    vi.advanceTimersByTime(1200);
    expect(shown).toMatchObject({ state: "waiting", moment: { kind: "waiting" } });
    update("running");
    expect(shown.moment).toBeNull();
  });

  it("spaces automatic bubbles apart even across multiple waits and failures", () => {
    update("running");
    update("running", true);
    vi.advanceTimersByTime(1200);
    update("running");
    update("failed");
    expect(shown.moment).toBeNull();
    vi.advanceTimersByTime(MASCOT_BUBBLE_COOLDOWN_MS);
    update("running");
    update("failed");
    expect(shown.moment?.kind).toBe("failed");
    vi.advanceTimersByTime(MASCOT_BUBBLE_MS);
    expect(shown.moment).toBeNull();
  });

  it("greets a return from a long turn after its reaction timer has already ended", () => {
    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(65_000);
    update("completed");
    vi.advanceTimersByTime(30_000);
    expect(shown).toMatchObject({ state: "idle", moment: null });
    moments.setActive(true);
    expect(shown.moment?.kind).toBe("returned");
    vi.advanceTimersByTime(MASCOT_BUBBLE_MS);
    expect(shown.moment).toBeNull();
    moments.setActive(false);
    moments.setActive(true);
    expect(shown.moment).toBeNull();
  });

  it("does not greet a short turn, a stale result, or a result replaced by new work", () => {
    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(10_000);
    update("completed");
    moments.setActive(true);
    expect(shown.moment).toBeNull();
    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(65_000);
    update("completed");
    vi.advanceTimersByTime(5 * 60_000);
    moments.setActive(true);
    expect(shown.moment).toBeNull();
    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(65_000);
    update("completed");
    update("running");
    moments.setActive(true);
    expect(shown).toMatchObject({ state: "working", moment: null });
  });

  it("handles a suspended client's result arriving just after foregrounding", () => {
    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(65_000);
    moments.setActive(true);
    vi.advanceTimersByTime(100);
    update("completed");
    expect(shown.moment?.kind).toBe("returned");

    update("running");
    moments.setActive(false);
    vi.advanceTimersByTime(65_000);
    moments.setActive(true);
    vi.advanceTimersByTime(10_000);
    update("completed");
    expect(shown.moment).toBeNull();
  });

  it("preserves approval priority and cancels timers when disposed", () => {
    update("running");
    update("failed", true);
    expect(shown).toMatchObject({ state: "waiting", moment: null });
    moments.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Verifies shipped sprite files and native asset references.
import { beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import {
  HARNESS_MASCOTS,
  loadHarnessMascotAnimations,
  type HarnessMascotId,
  createHarnessMascotPlayer,
  harnessMascotCompletedTurnDuration,
  harnessMascotVariants,
  defaultHarnessMascotDriver,
  defaultHarnessMascotProvider,
  harnessMascotAgentId,
  harnessMascotAnimation,
  harnessMascotDuration,
  harnessMascotForDriver,
  harnessMascotForModel,
  harnessMascotTurnState,
  resolveHarnessMascotFrame,
  resolveHarnessMascotPosterFrame,
} from "./harnessMascots.ts";

const mascotIds = Object.keys(HARNESS_MASCOTS) as HarnessMascotId[];
const states = ["idle", "greet", "working", "waiting", "done", "failed", "idea"] as const;
beforeAll(() => Promise.all(mascotIds.map(loadHarnessMascotAnimations)));

describe("harness mascots", () => {
  it("gives every shipped driver a pet independently of harness themes", () => {
    expect(harnessMascotForDriver("claudeAgent")?.name).toBe("Clawd");
    expect(harnessMascotForDriver("codex")?.name).toBe("Byte");
    expect(harnessMascotForDriver("grok")?.name).toBe("Grok Bot");
    expect(harnessMascotForDriver("muse")?.name).toBe("Jolly");
    expect(harnessMascotForDriver("cursor")?.name).toBe("Nib");
    expect(harnessMascotForDriver("opencode")?.name).toBe("Otto");
    expect(harnessMascotForDriver("pi")?.name).toBe("Pip");
    // Antigravity runs Google's models, so Gemini's own sparkle fronts it.
    expect(harnessMascotForDriver("antigravity")?.name).toBe("Twins");
    expect(harnessMascotForDriver("acpRegistry")?.name).toBe("Patch");
    for (const driver of ["claude", "uninstalled-driver", "constructor", null, undefined]) {
      expect(harnessMascotForDriver(driver)).toBeNull();
    }
  });
  it("uses ACP's actual agent ID and keeps new or local agents covered", () => {
    expect(harnessMascotForDriver("acpRegistry", "kimi")?.name).toBe("Kimi");
    expect(harnessMascotForDriver("acpRegistry", " kimi-code ")?.name).toBe("Kimi");
    expect(harnessMascotForDriver("acpRegistry", "mistral-vibe")?.name).toBe("Le Chonk");
    expect(harnessMascotForDriver("acpRegistry", "devin")?.name).toBe("Devin");
    expect(harnessMascotForDriver("acpRegistry", "gemini")?.name).toBe("Twins");
    expect(harnessMascotForDriver("acpRegistry", "qwen-code")?.name).toBe("Capy");
    expect(harnessMascotForDriver("qwenCode")?.name).toBe("Capy");
    expect(harnessMascotForDriver("acpRegistry", "codex-acp")?.name).toBe("Byte");
    expect(harnessMascotForDriver("acpRegistry", "claude-acp")?.name).toBe("Clawd");
    expect(harnessMascotForDriver("acpRegistry", "future-registry-agent")?.name).toBe("Patch");
    expect(harnessMascotForDriver("codex", "kimi")?.name).toBe("Byte");
    expect(harnessMascotForDriver("my-kimi-instance", "kimi")).toBeNull();
  });
  it("finds the pet of a model's family, for chats whose harness has none", () => {
    expect(harnessMascotForModel("qwen3.8-flash-next")).toEqual({
      driver: "acpRegistry",
      agentId: "qwen",
    });
    expect(harnessMascotForModel("mistralai/devstral-3")).toEqual({
      driver: "acpRegistry",
      agentId: "mistral-vibe",
    });
    expect(harnessMascotForModel("x-ai/grok-4.7")).toEqual({ driver: "grok", agentId: null });
    expect(harnessMascotForModel("swe-2-flash")).toEqual({
      driver: "acpRegistry",
      agentId: "devin",
    });
    expect(harnessMascotForModel("answer-2")).toBeNull();
    expect(harnessMascotForModel("deepseek-v4.1-flash-1017")).toEqual({
      driver: "acpRegistry",
      agentId: "deepseek",
    });
    expect(harnessMascotForModel("deepseek-r1-distill-qwen-32b")?.agentId).toBe("deepseek");
    expect(harnessMascotForModel("google-vertex/gemini-4-carbon")?.agentId).toBe("gemini");
    expect(harnessMascotForModel("z-ai/glm-5.3-flash")?.agentId).toBe("glm");
    expect(harnessMascotForModel("minimax/minimax-m3")?.agentId).toBe("minimax");
    expect(harnessMascotForDriver("acpRegistry", "deepseek")?.name).toBe("Moby");
    expect(harnessMascotForDriver("acpRegistry", "glm")?.name).toBe("Zippy");
    for (const model of ["llama-5-70b", "opus", "sonnet", "", null, undefined]) {
      expect(harnessMascotForModel(model)).toBeNull();
    }
  });
  it("gives a flat pet a second sheet for dark themes and every drawn state a still picture", async () => {
    const grok = await loadHarnessMascotAnimations("grok");
    for (const choices of Object.values(grok)) {
      for (const animation of choices) {
        expect(animation.darkFile).toBe(animation.file.replace("grok-", "grok-dark-"));
      }
    }
    expect(resolveHarnessMascotPosterFrame("grok", "failed").darkFile).toBe(
      "grok-dark-failed.webp",
    );
    // The still picture of a failure is the exclamation mark, not the resting orb.
    expect(resolveHarnessMascotPosterFrame("grok", "failed").index).toBeGreaterThan(3);
    expect(resolveHarnessMascotPosterFrame("grok", "idle").index).toBe(0);
    const cat = await loadHarnessMascotAnimations("mistral");
    expect(cat.idle[0].darkFile).toBeUndefined();
    // Eighteen squares across the cell: clients snap to them so the mosaic stays sharp.
    expect(cat.idle[0].pixelSize).toBe(18);
  });
  it("extracts registry identity from config without branding local commands by stale IDs", () => {
    expect(harnessMascotAgentId("acpRegistry", { agentId: " kimi " })).toBe("kimi");
    expect(
      harnessMascotAgentId("acpRegistry", { source: "registry", agentId: "mistral-vibe" }),
    ).toBe("mistral-vibe");
    for (const config of [
      null,
      undefined,
      "kimi",
      {},
      { agentId: 1 },
      { agentId: " " },
      { source: "local", agentId: "kimi" },
    ]) {
      expect(harnessMascotAgentId("acpRegistry", config)).toBeNull();
    }
    expect(harnessMascotAgentId("codex", { agentId: "kimi" })).toBeNull();
  });
  it("follows the user's default harness", () => {
    const providers = [
      { instanceId: "codex", driver: "codex", enabled: true, models: [{ isDefault: true }] },
      { instanceId: "my-muse", driver: "muse", enabled: true, isHarnessDefault: true, models: [] },
      { instanceId: "cursor", driver: "cursor", enabled: true, models: [] },
    ];
    expect(defaultHarnessMascotDriver(providers, null)).toBe("muse");
    expect(defaultHarnessMascotDriver(providers, "cursor")).toBe("cursor");
    expect(defaultHarnessMascotDriver(providers, "missing")).toBeNull();
    expect(defaultHarnessMascotDriver([], null)).toBeNull();
  });
  it("retains instance identity when two registry agents share the same driver", () => {
    const providers = [
      {
        instanceId: "personal",
        driver: "acpRegistry",
        enabled: true,
        models: [],
        config: { agentId: "kimi" },
      },
      {
        instanceId: "work",
        driver: "acpRegistry",
        enabled: true,
        isHarnessDefault: true,
        models: [],
        config: { agentId: "mistral-vibe" },
      },
    ];
    const selected = defaultHarnessMascotProvider(providers, "personal")!;
    const implicit = defaultHarnessMascotProvider(providers, null)!;
    expect(
      harnessMascotForDriver(
        selected.driver,
        harnessMascotAgentId(selected.driver, selected.config),
      )?.id,
    ).toBe("kimi");
    expect(
      harnessMascotForDriver(
        implicit.driver,
        harnessMascotAgentId(implicit.driver, implicit.config),
      )?.id,
    ).toBe("mistral");
  });
  it("resolves the official Codex variable durations and row boundaries", () => {
    expect(resolveHarnessMascotFrame("codex", "idle", 1679).column).toBe(0);
    expect(resolveHarnessMascotFrame("codex", "idle", 1680).column).toBe(1);
    expect(resolveHarnessMascotFrame("claude", "working", (9 * 1000) / 12 + 1)).toMatchObject({
      column: 1,
      row: 1,
    });
    expect(resolveHarnessMascotFrame("codex", "working", 600).column).toBe(5);
  });
  it("honors one-shot repeat counts, then returns to the idle clock", () => {
    for (const id of mascotIds) {
      for (const state of ["greet", "done", "failed", "idea"] as const) {
        const boundary =
          harnessMascotDuration(id, state) * harnessMascotAnimation(id, state).repeats!;
        expect(resolveHarnessMascotFrame(id, state, boundary - 1).state).toBe(state);
        expect(resolveHarnessMascotFrame(id, state, boundary)).toMatchObject({
          state: "idle",
          column: 0,
          row: 0,
        });
        expect(resolveHarnessMascotFrame(id, state, boundary + 1)).toEqual(
          resolveHarnessMascotFrame(id, "idle", 1),
        );
      }
    }
  });
  it("keeps a meaningful still pose under reduced motion", () => {
    // Clawd's working loop is all typing, so its first frame is already the pose.
    expect(resolveHarnessMascotPosterFrame("claude", "working")).toEqual(
      resolveHarnessMascotFrame("claude", "working", 0),
    );
    expect(resolveHarnessMascotPosterFrame("codex", "greet")).toEqual(
      resolveHarnessMascotFrame("codex", "idle", 0),
    );
  });
  it("keeps working and waiting live until the actual status changes", () => {
    for (const state of ["working", "waiting", "idle"] as const) {
      const duration = harnessMascotDuration("claude", state);
      expect(resolveHarnessMascotFrame("claude", state, duration * 100).state).toBe(state);
    }
    expect(harnessMascotTurnState(true, true, "done")).toBe("waiting");
    expect(harnessMascotTurnState(true, false, "done")).toBe("working");
    expect(harnessMascotTurnState(false, false, "failed")).toBe("failed");
    expect(harnessMascotTurnState(false, false, null)).toBe("idle");
  });

  it("settles the Codex pet into its slow idle after three plays, like the Codex app", () => {
    for (const state of ["working", "waiting"] as const) {
      const duration = harnessMascotDuration("codex", state);
      expect(resolveHarnessMascotFrame("codex", state, duration * 3 - 1).state).toBe(state);
      expect(resolveHarnessMascotFrame("codex", state, duration * 3).state).toBe("idle");
    }
  });
});

describe("mascot variety", () => {
  it("drifts after 20–60 seconds of the injected visible clock", () => {
    let clock = 0;
    const player = createHarnessMascotPlayer("claude", { random: () => 0, now: () => clock });
    const initial = player.frame("idle").file;
    clock = 19_999;
    expect(player.frame("idle").file).toBe(initial);
    clock = 20_000;
    expect(player.frame("idle").file).not.toBe(initial);
    const changed = player.frame("idle").file;
    // A hidden client supplies the same accumulated visible time on resume.
    expect(player.frame("idle").file).toBe(changed);
    const slow = createHarnessMascotPlayer("grok", { random: () => 0.999999 });
    const first = slow.frame("idle", 0).file;
    expect(slow.frame("idle", 59_999).file).toBe(first);
    expect(slow.frame("idle", 60_000).file).not.toBe(first);
  });

  it("never repeats an event variant when another eligible variant exists", () => {
    for (const id of ["claude", "codex", "grok"] as const) {
      for (const state of ["greet", "working", "waiting", "done", "failed", "idea"] as const) {
        const player = createHarnessMascotPlayer(id, { random: () => 0 });
        const first = player.frame(state, 0).file;
        player.frame("idle", 100_000);
        expect(player.frame(state, 100_001).file).not.toBe(first);
      }
    }
  });

  it("saves Clawd's biggest celebrations for a witnessed long turn", () => {
    const player = createHarnessMascotPlayer("claude", { random: () => 0.999999 });
    expect(player.frame("done", 0).file).not.toMatch(/confetti|breakdancing/);
    player.frame("working", 1000);
    player.frame("waiting", 30_000);
    player.frame("working", 40_000);
    const celebration = player.frame("done", 61_000);
    expect(celebration.file).toMatch(/breakdancing/);
    expect(player.frame("idle", 64_800).file).toBe(celebration.file);
    expect(player.frame("idle", 90_000).state).toBe("idle");
  });

  it("returns rare idle movement to a quiet idle after one play", () => {
    const player = createHarnessMascotPlayer("claude", { random: () => 0.999999 });
    expect(player.frame("idle", 0).file).toMatch(/turning/);
    const duration = harnessMascotDuration("claude", "idle", 5);
    expect(player.frame("idle", duration + 1).file).not.toMatch(/turning/);
  });

  it("resolves every variant within its sheet and honors its own repeat count", () => {
    for (const id of mascotIds) {
      for (const state of states) {
        for (const [variant, animation] of harnessMascotVariants(id, state).entries()) {
          const duration = harnessMascotDuration(id, state, variant);
          expect(duration).toBeGreaterThan(0);
          expect(animation.durations.length).toBeLessThanOrEqual(
            animation.columns * animation.rows,
          );
          const frame = resolveHarnessMascotFrame(id, state, duration - 1, variant);
          expect(frame.column).toBeLessThan(animation.columns);
          expect(frame.row).toBeLessThan(animation.rows);
          if (animation.repeats !== null) {
            expect(
              resolveHarnessMascotFrame(id, state, duration * animation.repeats, variant).state,
            ).toBe("idle");
          }
        }
      }
    }
  });
  it("gives every pet several idle and celebration choices", () => {
    for (const id of mascotIds) {
      expect(harnessMascotVariants(id, "idle").length).toBeGreaterThanOrEqual(3);
      expect(harnessMascotVariants(id, "done").length).toBeGreaterThanOrEqual(3);
      const player = createHarnessMascotPlayer(id, { random: () => 0 });
      const first = player.frame("done", 0).file;
      player.frame("working", 100_000);
      expect(player.frame("done", 100_001).file).not.toBe(first);
    }
  });
  it("ships every animation on both clients with identical vector and Byte sheets", () => {
    for (const id of mascotIds) {
      const assetModule = NodeFS.readFileSync(
        new URL(
          `../../../apps/mobile/src/components/harnessMascotAssets/${id}.ts`,
          import.meta.url,
        ),
        "utf8",
      );
      for (const state of states) {
        for (const animation of harnessMascotVariants(id, state)) {
          const web = NodeFS.readFileSync(
            new URL(`../../../apps/web/public/mascots/${animation.file}`, import.meta.url),
          );
          const mobile = NodeFS.readFileSync(
            new URL(`../../../apps/mobile/assets/mascots/${animation.file}`, import.meta.url),
          );
          if (id !== "claude") {
            expect(assetModule).toContain(`require("../../../assets/mascots/${animation.file}")`);
          }
          expect(web.length).toBeLessThan(200_000);
          if (id !== "claude") expect(mobile.equals(web)).toBe(true);
        }
      }
    }
  });
});

it("uses completed run timing when a client mounts the result mascot after work ends", () => {
  const duration = harnessMascotCompletedTurnDuration({
    startedAt: "2026-10-19T12:00:00Z",
    completedAt: "2026-10-19T12:01:01Z",
  });
  expect(duration).toBe(61_000);
  const player = createHarnessMascotPlayer("claude", { random: () => 0.999999 });
  expect(player.frame("done", 0, duration).file).toMatch(/breakdancing/);
  expect(harnessMascotCompletedTurnDuration(null)).toBe(0);
  expect(harnessMascotCompletedTurnDuration({ startedAt: "invalid", completedAt: "invalid" })).toBe(
    0,
  );
});

describe("pets by model maker", () => {
  it("knows Muse, Claude and GPT models, and leaves makers without a pet alone", () => {
    expect(harnessMascotForModel("meta/muse-spark-2")).toEqual({ driver: "muse", agentId: null });
    expect(harnessMascotForModel("anthropic/claude-opus-5-5")).toEqual({
      driver: "claudeAgent",
      agentId: null,
    });
    expect(harnessMascotForModel("openai/gpt-6.1-sol")).toEqual({ driver: "codex", agentId: null });
    expect(harnessMascotForModel("meta/llama-5-70b")).toBeNull();
    expect(harnessMascotForModel("nvidia/nemotron-4-ultra")).toBeNull();
    expect(harnessMascotForModel("amused-model")).toBeNull();
  });
});

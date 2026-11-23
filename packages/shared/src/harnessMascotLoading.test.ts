import { expect, it, vi } from "vite-plus/test";

const evaluated = vi.hoisted(() => new Set<string>());
vi.mock("./harnessMascotAnimations.ts", () => {
  throw new Error("The runtime registry must not import the build-time aggregate.");
});
vi.mock("./harnessMascotData/claude.ts", async (original) => {
  evaluated.add("claude");
  return original();
});
vi.mock("./harnessMascotData/codex.ts", async (original) => {
  evaluated.add("codex");
  return original();
});
vi.mock("./harnessMascotData/grok.ts", async (original) => {
  evaluated.add("grok");
  return original();
});
vi.mock("./harnessMascotData/muse.ts", async (original) => {
  evaluated.add("muse");
  return original();
});
vi.mock("./harnessMascotData/cursor.ts", async (original) => {
  evaluated.add("cursor");
  return original();
});
vi.mock("./harnessMascotData/opencode.ts", async (original) => {
  evaluated.add("opencode");
  return original();
});
vi.mock("./harnessMascotData/pi.ts", async (original) => {
  evaluated.add("pi");
  return original();
});
vi.mock("./harnessMascotData/devin.ts", async (original) => {
  evaluated.add("devin");
  return original();
});
vi.mock("./harnessMascotData/kimi.ts", async (original) => {
  evaluated.add("kimi");
  return original();
});
vi.mock("./harnessMascotData/mistral.ts", async (original) => {
  evaluated.add("mistral");
  return original();
});
vi.mock("./harnessMascotData/acp.ts", async (original) => {
  evaluated.add("acp");
  return original();
});

it("imports only the tiny registry until one specific pet is requested", async () => {
  const registry = await import("./harnessMascots.ts");
  expect(registry.harnessMascotForDriver("acpRegistry", "kimi")?.name).toBe("Kimi");
  expect(evaluated.size).toBe(0);
  const first = registry.loadHarnessMascotAnimations("codex");
  const second = registry.loadHarnessMascotAnimations("codex");
  expect(second).toBe(first);
  await first;
  expect([...evaluated]).toEqual(["codex"]);
  expect(registry.resolveHarnessMascotFrame("codex", "idle", 1680).column).toBe(1);
});

import { ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_HARNESS_THEME_SETTINGS } from "@t3tools/shared/harnessThemes";
import { describe, expect, it } from "vite-plus/test";

import { harnessThemeRows } from "./HarnessThemeSettings.logic";

function provider(driver: string, enabled = true, installed = true) {
  return { driver: ProviderDriverKind.make(driver), enabled, installed };
}

describe("harnessThemeRows", () => {
  it("lists each harness the user has once, in provider order", () => {
    const rows = harnessThemeRows(
      [
        provider("muse"),
        provider("claudeAgent"),
        provider("codex"),
        provider("codex"),
        provider("opencode"),
        provider("cursor", false),
        provider("pi", true, false),
      ],
      DEFAULT_HARNESS_THEME_SETTINGS,
    );
    expect(rows).toEqual([
      { driver: "codex", label: "Codex" },
      { driver: "claudeAgent", label: "Claude" },
      { driver: "opencode", label: "OpenCode" },
      { driver: "muse", label: "Muse Code" },
    ]);
  });

  it("shows installed, enabled registry agents once and omits those without presets", () => {
    const registry = (agentId: string, enabled = true, installed = true) => ({
      ...provider("acpRegistry", enabled, installed),
      config: { source: "registry", agentId },
    });
    expect(
      harnessThemeRows(
        [
          provider("codex"),
          registry("mistral-vibe"),
          registry("qwen-code"),
          registry("qwen"),
          registry("kimi"),
          registry("unknown"),
        ],
        DEFAULT_HARNESS_THEME_SETTINGS,
      ),
    ).toEqual([
      { driver: "codex", label: "Codex" },
      { driver: "acpRegistry:mistral-vibe", label: "Mistral Vibe" },
      { driver: "acpRegistry:qwen", label: "Qwen Code" },
    ]);
    expect(
      harnessThemeRows(
        [
          provider("codex"),
          registry("mistral-vibe", false),
          registry("qwen", true, false),
          { ...registry("mistral-vibe"), config: { source: "local", agentId: "mistral-vibe" } },
        ],
        DEFAULT_HARNESS_THEME_SETTINGS,
      ),
    ).toEqual([{ driver: "codex", label: "Codex" }]);
    expect(
      harnessThemeRows([provider("codex")], {
        enabled: true,
        choices: { "acpRegistry:kimi": "theme:grove", "acpRegistry:qwen": "default" },
      }),
    ).toEqual([
      { driver: "codex", label: "Codex" },
      { driver: "acpRegistry:kimi", label: "kimi" },
      { driver: "acpRegistry:qwen", label: "Qwen Code" },
    ]);
  });

  it("keeps a customized harness listed so it can be reset", () => {
    const rows = harnessThemeRows([provider("codex")], {
      enabled: true,
      choices: { grok: "default" },
    });
    expect(rows.map((row) => row.driver)).toEqual(["codex", "grok"]);
  });

  it("stands in the harnesses with a built-in look until providers load", () => {
    expect(harnessThemeRows([], DEFAULT_HARNESS_THEME_SETTINGS).map((row) => row.driver)).toEqual([
      "codex",
      "claudeAgent",
      "grok",
      "muse",
    ]);
  });
});

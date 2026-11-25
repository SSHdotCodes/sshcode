import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
  providerInstanceMark,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a snapshot name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the snapshot only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});

describe("providerInstanceMark", () => {
  it("marks a numbered account with its number", () => {
    expect(providerInstanceMark("Max-2")).toBe("2");
    expect(providerInstanceMark("Claude · Work 12")).toBe("12");
  });

  it("falls back to the name's first letter", () => {
    expect(providerInstanceMark("Studio · Claude Code")).toBe("S");
    expect(providerInstanceMark("work")).toBe("W");
    // Digits inside a word, or a year, are not an account number.
    expect(providerInstanceMark("Qwen4 Code")).toBe("Q");
    expect(providerInstanceMark("Plan 2026")).toBe("P");
    expect(providerInstanceMark("😀 Work")).toBe("😀");
    expect(providerInstanceMark("")).toBe("");
  });
  it.each([
    ["Max 1", "1"],
    ["Team 20x", "T"],
    ["StudioGrok 2", "2"],
    ["StudioGrok", "SG"],
    ["SuperClaude", "SC"],
  ])("gives %s the account mark %s", (name, mark) => {
    expect(providerInstanceMark(name)).toBe(mark);
  });
});

describe("providerInstanceInitials", () => {
  it("takes the first two characters of a single word", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("takes the first character of each of the first two words", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it.each([
    ["Max 1", "M1"],
    ["Team 20x", "T2"],
    ["StudioGrok 2", "S2"],
    ["StudioGrok", "SG"],
    ["ClaudeAPI", "CA"],
    ["(ClaudeProx)", "CP"],
    ["ClaudeProx Work", "CW"],
    ["Alex’s Codex", "AC"],
    ["Codex (hub)", "CH"],
  ])("gives %s the initials %s", (name, initials) => {
    expect(providerInstanceInitials(name)).toBe(initials);
  });

  it("ignores words past the first two", () => {
    expect(providerInstanceInitials("Codex Personal Backup Account")).toBe("CP");
  });

  it("skips separator words like a middle dot", () => {
    expect(providerInstanceInitials("Qwen4 · Claude Code")).toBe("QC");
  });

  it("returns an empty string for an empty label", () => {
    expect(providerInstanceInitials("")).toBe("");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  it("accepts a lowercase hex color", () => {
    expect(normalizeProviderAccentColor("#ff8800")).toBe("#ff8800");
  });

  it("accepts an uppercase hex color", () => {
    expect(normalizeProviderAccentColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });

  it("rejects a short hex value", () => {
    expect(normalizeProviderAccentColor("#fff")).toBeUndefined();
  });

  it("treats undefined and blank as unset", () => {
    expect(normalizeProviderAccentColor(undefined)).toBeUndefined();
    expect(normalizeProviderAccentColor("   ")).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin" };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("shows badges for multiple instances of the same ACP agent", () => {
    const first = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const second = { ...first };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("keeps an explicit accent on a single ACP agent", () => {
    const entry = {
      driverKind: acpRegistry,
      acpRegistryAgentId: "mistral-vibe",
      accentColor: "#ff8800",
    };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("never badges the user's own default instance, only the extra ones", () => {
    const own = { instanceId: "claudeAgent", driverKind: claude };
    const studio = { instanceId: "claude_studio", driverKind: claude };
    const qwen = { instanceId: "claudeAgent_qwen4", driverKind: claude };
    const work = { instanceId: "claude_work", driverKind: claude };
    expect(shouldShowInstanceBadge(own, [own, studio])).toBe(false);
    expect(shouldShowInstanceBadge(own, [own, studio, qwen, work])).toBe(false);
    // Extra instances keep their badge, so their chats read apart from the user's own.
    expect(shouldShowInstanceBadge(studio, [own, studio])).toBe(true);
    expect(shouldShowInstanceBadge(qwen, [own, qwen])).toBe(true);
    expect(shouldShowInstanceBadge(work, [own, studio, work])).toBe(true);
    // An extra instance that draws its own icon needs no badge.
    const qwenIcon = {
      ...qwen,
      acpRegistryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen-code.svg",
    };
    expect(shouldShowInstanceBadge(qwenIcon, [own, qwenIcon])).toBe(false);
    // An accent still badges the default instance.
    expect(shouldShowInstanceBadge({ ...own, accentColor: "#ff8800" }, [own])).toBe(true);
  });

  it("treats Grok Build as the first account when no default-id instance exists", () => {
    const grok = ProviderDriverKind.make("grok");
    const own = { instanceId: "grok_grok_build", driverKind: grok };
    const second = { instanceId: "grok_second", driverKind: grok };
    expect(shouldShowInstanceBadge(own, [own, second])).toBe(false);
    expect(shouldShowInstanceBadge(second, [own, second])).toBe(true);
    expect(providerInstanceMark("Grok-2")).toBe("2");
    const defaultEntry = { instanceId: "grok", driverKind: grok };
    expect(shouldShowInstanceBadge(own, [own, second, defaultEntry])).toBe(true);
    expect(shouldShowInstanceBadge(defaultEntry, [own, second, defaultEntry])).toBe(false);
  });

  it("hides a linked Max-2 mark, while keeping unlinked and explicit accent marks", () => {
    const own = {
      instanceId: "claudeAgent",
      driverKind: claude,
      continuationGroupKey: "claude:main",
    };
    const linked = {
      instanceId: "claude_work",
      driverKind: claude,
      continuationGroupKey: "claude:main",
    };
    expect(shouldShowInstanceBadge(linked, [linked, own])).toBe(false);
    expect(providerInstanceMark("Max-2")).toBe("2");
    const unlinked = { ...linked, continuationGroupKey: "claude:second" };
    expect(shouldShowInstanceBadge(unlinked, [own, unlinked])).toBe(true);
    expect(shouldShowInstanceBadge({ ...linked, accentColor: "#ff8800" }, [own, linked])).toBe(
      true,
    );
    expect(
      shouldShowInstanceBadge({ ...linked, continuationGroupKey: undefined }, [own, linked]),
    ).toBe(true);
    // A custom primary id uses the same rule, even if it is disabled.
    const grok = ProviderDriverKind.make("grok");
    const build = {
      instanceId: "grok_grok_build",
      driverKind: grok,
      continuationGroupKey: "grok:main",
      enabled: false,
    };
    const second = {
      instanceId: "grok_second",
      driverKind: grok,
      continuationGroupKey: "grok:main",
    };
    expect(shouldShowInstanceBadge(second, [build, second])).toBe(false);
    const defaultGrok = {
      ...build,
      instanceId: "grok",
      continuationGroupKey: "grok:other",
      enabled: true,
    };
    expect(shouldShowInstanceBadge(second, [build, second, defaultGrok])).toBe(true);
    // A one-shot iterable must be read only once.
    expect(shouldShowInstanceBadge(linked, [linked, own].values())).toBe(false);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined };
    const second = { driverKind: codex, accentColor: undefined };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined };
    const other = { driverKind: claude, accentColor: undefined };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
  });
});

describe("initials badge with one usable entry", () => {
  const grok = ProviderDriverKind.make("grok");
  const build = { instanceId: "grok_grok_build", driverKind: grok };

  it("drops the badge when the other entry of that provider is off or not installed", () => {
    expect(shouldShowInstanceBadge(build, [build, { instanceId: "grok", driverKind: grok }])).toBe(
      true,
    );
    expect(
      shouldShowInstanceBadge(build, [
        build,
        { instanceId: "grok", driverKind: grok, enabled: false, installed: true },
      ]),
    ).toBe(false);
    expect(
      shouldShowInstanceBadge(build, [
        build,
        { instanceId: "grok", driverKind: grok, enabled: true, installed: false },
      ]),
    ).toBe(false);
  });

  it("keeps the badge when the entry itself is off but a second usable one exists", () => {
    expect(
      shouldShowInstanceBadge({ ...build, enabled: false } as typeof build, [
        { ...build, enabled: false },
        { instanceId: "grok", driverKind: grok, enabled: true, installed: true },
      ]),
    ).toBe(true);
  });
});

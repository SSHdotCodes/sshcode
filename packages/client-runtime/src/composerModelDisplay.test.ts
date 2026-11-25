import { describe, expect, it } from "vite-plus/test";
import {
  composerModelName,
  effortChoices,
  effortDisplay,
  effortGauge,
} from "./composerModelDisplay.ts";

describe("composer model name", () => {
  it("prefers the catalog short name exactly as provided", () => {
    expect(composerModelName({ name: "Claude Opus 5.5", shortName: "Claude Opus" })).toBe(
      "Claude Opus",
    );
  });

  it.each([
    ["Claude Opus 5.5", "Opus 5.5"],
    ["Anthropic Claude Opus 5.5", "Claude Opus 5.5"],
    ["Anthropic Opus 5.5", "Opus 5.5"],
    ["GPT-6.2-Sol", "Sol 6.2"],
    ["GPT-6.1 Terra", "Terra 6.1"],
    ["GPT-5.1-Codex-Max", "Codex Max 5.1"],
    ["GPT-6.2", "GPT-6.2"],
    ["GPT-5.4 Mini", "GPT-5.4 Mini"],
    ["Gemini 4 Neon", "Neon 4"],
    ["Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (High)"],
    ["Gemini 3.8 Flash", "Gemini 3.8 Flash"],
    ["Muse Ember", "Ember"],
    ["Muse Wonder Full", "Wonder Full"],
    ["DeepSeek V4 Pro", "DeepSeek V4 Pro"],
    ["Kimi K2.6", "Kimi K2.6"],
    ["Grok 4.7", "Grok 4.7"],
    ["Acme Claude Model", "Acme Claude Model"],
    ["Claude", "Claude"],
  ])("displays %s as %s", (name, expected) => {
    expect(composerModelName({ name })).toBe(expected);
  });
});

const options = [
  { id: "max", label: "Max" },
  { id: "ultrathink", label: "Ultrathink" },
  { id: "provider-deep", label: "Extra High" },
  { id: "ultra", label: "Ultra" },
  { id: "low", label: "Low" },
  { id: "ultracode", label: "Ultracode" },
  { id: "high", label: "High", isDefault: true },
  { id: "medium", label: "Medium" },
];

describe("effort levels", () => {
  it("orders only offered levels and keeps provider values and modes", () => {
    const { levels, otherChoices } = effortChoices(options);
    expect(levels.map(({ shortLabel }) => shortLabel)).toEqual([
      "Low",
      "Med",
      "High",
      "XHigh",
      "Max",
      "Ultra",
      "Ultra",
    ]);
    expect(levels.map(({ id }) => id)).toEqual([
      "low",
      "medium",
      "high",
      "provider-deep",
      "max",
      "ultra",
      "ultracode",
    ]);
    // Stops use the theme colour; only Ultracode has an accent of its own.
    expect(levels.filter(({ accent }) => accent).map(({ id }) => id)).toEqual(["ultracode"]);
    // Effects build up from High: glow, shimmer, breathing, then Ultracode's embers.
    expect(levels.map(({ fx }) => fx)).toEqual([0, 0, 1, 2, 3, 3, 4]);
    expect(levels.find((level) => level.id === "high")?.isDefault).toBe(true);
    // Ultrathink is typed into the prompt, never picked.
    expect(otherChoices).toEqual([]);
    expect(effortChoices(options.filter((choice) => choice.id !== "medium")).levels).toHaveLength(
      6,
    );
  });

  it("sweeps the gauge through the chosen level", () => {
    const display = effortDisplay(options, "provider-deep");
    expect(display).toEqual({
      label: "XHigh",
      filledBars: 4,
      barCount: 7,
      fx: 2,
      accent: undefined,
    });
    const gauge = effortGauge(display!);
    expect(gauge).toMatchObject({
      width: 18,
      height: 10.25,
      track: "M 1.25 9 A 7.75 7.75 0 0 1 16.75 9",
    });
    // Four of seven stops sweeps just past the top of the dial.
    expect(gauge.fill).toBe("M 1.25 9 A 7.75 7.75 0 0 1 10.72 1.44");
    expect(effortGauge(effortDisplay([{ id: "high", label: "High" }], "high")!).fill).toBe(
      gauge.track,
    );
  });

  it("fills the whole meter for Ultracode, names Ultrathink in words, and omits an absent effort", () => {
    expect(effortDisplay(options, "ultrathink")).toEqual({
      label: "Ultrathink",
      filledBars: 0,
      barCount: 0,
      fx: 0,
      accent: undefined,
    });
    const ultracode = effortDisplay(options, "ultracode")!;
    expect(ultracode).toEqual({
      label: "Ultracode",
      filledBars: 7,
      barCount: 7,
      fx: 4,
      accent: "#EA8C55",
    });
    expect(effortGauge(ultracode).fill).toBe(effortGauge(ultracode).track);
    expect(effortDisplay([], undefined)).toBeNull();
  });
});

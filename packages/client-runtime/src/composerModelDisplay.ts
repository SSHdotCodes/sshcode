import type { ProviderOptionDescriptor } from "@t3tools/contracts";

export type ReasoningDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type ReasoningChoice = ReasoningDescriptor["options"][number];

// Stops draw in the app's theme colour; only Ultracode, which runs past Max, gets its own warm accent.
// The last field is the effects tier: 1 glows, 2 shimmers, 3 breathes, 4 throws embers.
const LEVELS = [
  ["minimal", "Min", 0],
  ["low", "Low", 0],
  ["medium", "Med", 0],
  ["high", "High", 1],
  ["xhigh", "XHigh", 2],
  ["max", "Max", 3],
  ["ultra", "Ultra", 3],
  ["ultracode", "Ultra", 4],
] as const;
const ACCENTS: Partial<Record<string, string>> = { ultracode: "#E07A50" };

/** Picked by typing it into the prompt; the picker no longer offers it. */
const HIDDEN_CHOICES = new Set(["ultrathink"]);

// Tier words that say nothing on their own: "Gemini 3.1 Pro" never becomes "Pro 3.1".
const GENERIC_MODEL_WORD =
  /^(?:pro|flash|mini|nano|lite|plus|max|ultra|fast|turbo|preview|instant|high|medium|low)\b/iu;

/**
 * The model's name without the maker or product line its logo already shows, where what is left
 * still reads as a name: "Claude Opus 5.5" reads "Opus 5.5", "GPT-6.2-Sol" "Sol 6.2", "Gemini 4
 * Neon" "Neon 4" and "Muse Ember" "Ember". Tiers ("GPT-5.4 Mini", "Gemini 3.1 Pro") and bare
 * versions ("GPT-6.2", "Grok 4.7") keep their names.
 */
export function composerModelName(model: { name: string; shortName?: string | undefined }) {
  const name = model.shortName || model.name.replace(/^(?:Claude|Anthropic) (?=\S)/u, "");
  const versioned = /^(?:GPT|Gemini)[- ](\d+(?:\.\d+)*)[- ](\S.*)$/u.exec(name);
  if (versioned && !GENERIC_MODEL_WORD.test(versioned[2]!)) {
    return `${versioned[2]!.replace(/-/gu, " ")} ${versioned[1]}`;
  }
  const line = /^Muse (\S.*)$/u.exec(name);
  if (line && !GENERIC_MODEL_WORD.test(line[1]!)) return line[1]!;
  return name;
}

function effortLevelIndex(value: string) {
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  return LEVELS.findIndex(([id]) => id === (key === "extrahigh" ? "xhigh" : key));
}

export function effortChoiceLabel(choice: ReasoningChoice) {
  return /^(?:extra[ _-]?high|xhigh)$/i.test(choice.label) ? "XHigh" : choice.label;
}

/** Order known ranks across providers while retaining every advertised choice and wire id. */
export function effortChoices(options: ReasoningDescriptor["options"]) {
  const levels = [];
  const otherChoices = [];
  for (const option of options) {
    if (HIDDEN_CHOICES.has(option.id.toLowerCase())) continue;
    const idRank = effortLevelIndex(option.id);
    const rank = idRank === -1 ? effortLevelIndex(option.label) : idRank;
    const level = LEVELS[rank];
    if (level) {
      levels.push({
        ...option,
        rank,
        shortLabel: level[1],
        fx: level[2],
        accent: ACCENTS[level[0]],
      });
    } else otherChoices.push(option);
  }
  levels.sort((a, b) => a.rank - b.rank);
  return { levels, otherChoices };
}

export type EffortDisplay = {
  readonly label: string;
  readonly filledBars: number;
  readonly barCount: number;
  /** Effects tier of the chosen level (see LEVELS). */
  readonly fx: number;
  /** Ultracode's own colour; otherwise the theme colour applies. */
  readonly accent?: string | undefined;
};

export function effortDisplay(
  options: ReasoningDescriptor["options"],
  value: string | boolean | undefined,
  fallbackLabel?: string,
): EffortDisplay | null {
  const { levels } = effortChoices(options);
  const index = levels.findIndex((level) => level.id === value);
  const choice = options.find((option) => option.id === value);
  const label = choice ? effortChoiceLabel(choice) : fallbackLabel;
  if (!label) return null;
  const level = levels[index];
  return {
    label,
    filledBars: index + 1,
    barCount: index === -1 ? 0 : levels.length,
    fx: level?.fx ?? 0,
    accent: level?.accent,
  };
}

const GAUGE_WIDTH = 18;
const GAUGE_STROKE = 2.5;

/**
 * The composer's effort gauge: a half ring whose fill sweeps left to right with the effort, so it
 * reads as a dial rather than the signal bars it used to resemble. Paths share one geometry on
 * every client; the fill is null when no level is chosen.
 */
export function effortGauge({ filledBars, barCount }: EffortDisplay) {
  const radius = (GAUGE_WIDTH - GAUGE_STROKE) / 2;
  const cx = GAUGE_WIDTH / 2;
  const cy = radius + GAUGE_STROKE / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  const arc = (fraction: number) => {
    const angle = Math.PI * (1 - fraction);
    const x = round(cx + radius * Math.cos(angle));
    const y = round(cy - radius * Math.sin(angle));
    return `M ${round(cx - radius)} ${round(cy)} A ${radius} ${radius} 0 0 1 ${x} ${y}`;
  };
  const fraction = barCount > 0 ? Math.min(1, filledBars / barCount) : 0;
  return {
    width: GAUGE_WIDTH,
    height: cy + GAUGE_STROKE / 2,
    stroke: GAUGE_STROKE,
    track: arc(1),
    fill: fraction > 0 ? arc(fraction) : null,
  };
}

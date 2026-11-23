/**
 * Which release retires which across a maker's tiers. The model pickers
 * (`modelPickerCatalog` in client-runtime) and the agents' model list
 * (`modelFamilySupersessions`) both read these rules, so they agree on what is current.
 * Phone-safe: no `toSorted`/`findLast`, no `.groups` from `matchAll`.
 */
export type ModelGenerationRule = {
  /** `generation` names the release; an optional `line` names a tier that updates on its own. */
  readonly pattern: RegExp;
  /** Tiers that succeed one another under a new name compare as one line. */
  readonly lineAliases?: Readonly<Record<string, string>>;
  /** The generation of a release whose name carries no number (Inkling → Inkling 2). */
  readonly unnumbered?: string;
  /**
   * Only the picker retires across tiers; agents keep comparing each tier on its own
   * (Qwen4 Max retires Qwen3.8 Max, Qwen3.8 Flash stays current for agents).
   */
  readonly pickerOnly?: true;
};

// Compare major generations across sizes/variants. Minor releases of distinct lines
// (M3 and M3.1 Flash) coexist; the version parser handles same-line updates.
export const MODEL_GENERATION_RULES: Readonly<Record<string, ModelGenerationRule>> = {
  // Point releases retire the whole family: Qwen 3.8 retires 3.5, GLM 5.3 retires GLM-5 Turbo.
  qwen: { pattern: /\bqwen[- ]?(?<generation>\d+(?:\.\d+)?)/i, pickerOnly: true },
  // A newer DeepSeek release retires every older tier (V4.1 Flash retires V4 Pro); tiers
  // of one release coexist, and a dated snapshot is that same release.
  // `v4-1` is V4.1 (a hyphen stands in for the dot), but `4-9b` is a size and `v4-0813` a date.
  // The names from before the numbered releases ("DeepSeek Chat", "DeepSeek R1") are the oldest.
  deepseek: {
    pattern:
      /\bdeepseek[- ]?(?:v(?<generation>\d+(?:[.-]\d{1,2}(?![\dbk]))?)|(?:chat|r1)\b(?![- ]?v\d))/i,
    unnumbered: "1",
  },
  glm: { pattern: /\bglm[- ]?(?<generation>\d+(?:[.-]\d{1,2}(?![\dbk]))?)/i },
  kimi: { pattern: /(?:\bkimi[- ]?(?:k)?|\bmoonshot[- ]?v?|\bk)(?<generation>\d+)/i },
  // `mistral-small-24b` is a size and `mistral-small-2603` a date; the name then says "Mistral Small 4".
  mistral: {
    pattern:
      /\b(?<line>mistral[- ](?:large|medium|small)|ministral|devstral|codestral)[- ]?(?<generation>\d{1,2})(?![\dbk])/i,
  },
  minimax: { pattern: /\b(?:minimax[- ]?)?m(?<generation>\d+)/i },
  // Gemini keeps the newest flagship (Argon, formerly Pro) and the newest Flash.
  gemini: {
    pattern: /\bgemini[- ]?(?<generation>\d+(?:[.-]\d+)?)[- ]?(?<line>argon|pro|ultra|flash)?/i,
    lineAliases: { argon: "flagship", pro: "flagship", ultra: "flagship" },
  },
  // The first Inkling has no number; "256k" is a context size, not a generation.
  inkling: {
    pattern: /\binkling(?:[- ](?<generation>\d{1,2}(?:\.\d+)?)(?![\dkb]))?/i,
    unnumbered: "1",
  },
};

/**
 * A model's maker, line and release as one comparable id (`gemini-flagship-3.1`), or
 * null when no rule reads it. `familyLine` is the provider-reported line
 * (`gemini:argon` → `argon`), used when the name itself carries none.
 */
export function modelGeneration(
  maker: string | null,
  text: string,
  familyLine?: string | undefined,
): string | null {
  const rule = maker === null ? undefined : MODEL_GENERATION_RULES[maker];
  if (!rule) return null;
  const match = rule.pattern.exec(text);
  if (!match) return null;
  const generation = match.groups?.generation ?? rule.unnumbered;
  if (!generation) return null;
  const line = (match.groups?.line ?? familyLine ?? "model").toLowerCase().replace(/ /g, "-");
  return `${maker}-${rule.lineAliases?.[line] ?? line}-${generation}`;
}

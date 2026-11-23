import type { TaskDifficulty } from "./classifyTaskDifficulty.logic.ts";

export interface AutoModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export interface AutoModelCandidate {
  /** Canonical identity from modelPicks, shared across provider routes and aliases. */
  readonly key?: string;
  readonly selection: AutoModelSelection;
  readonly label: string;
  /** Quality from modelPicks, scaled against its best model (0–100). */
  readonly quality: number;
  readonly available: boolean;
  readonly disabled?: boolean;
  readonly legacy?: boolean;
  readonly superseded?: boolean;
  readonly remainingPercent?: number;
}

export interface AutoModelHistoryEntry {
  readonly createdBy: string;
  readonly createdAt: number;
  readonly modelSelection: AutoModelSelection;
}

export interface RecommendAutoModelInput {
  readonly difficulty: TaskDifficulty;
  readonly text: string;
  readonly attachmentCount: number;
  readonly currentSelection: AutoModelSelection;
  readonly candidates: ReadonlyArray<AutoModelCandidate>;
  readonly history: ReadonlyArray<AutoModelHistoryEntry>;
  readonly picks: {
    readonly quality: AutoModelSelection | null;
    readonly speed: AutoModelSelection | null;
    readonly frugal: AutoModelSelection | null;
  };
  readonly now: number;
}

export interface AutoModelRecommendation {
  readonly tier: "fast" | "big";
  readonly confidence: number;
  readonly selection: AutoModelSelection;
  readonly label: string;
}

const keyOf = (selection: AutoModelSelection) => `${selection.instanceId}\0${selection.model}`;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
// Same quality band as modelPicks' Value pick: within 15% of the best needs power.
const BIG_QUALITY_FLOOR = 85;
const tierOf = (candidate: AutoModelCandidate): "fast" | "big" =>
  candidate.quality >= BIG_QUALITY_FLOOR ? "big" : "fast";

/** Counts only owner-started chats; ties prefer the most recent choice, then a stable key. */
export function recommendAutoModel(input: RecommendAutoModelInput): AutoModelRecommendation | null {
  const { difficulty } = input;
  if (
    !Number.isFinite(difficulty.confidence) ||
    difficulty.confidence < 0.7 ||
    (input.text.trim().length < 12 && input.attachmentCount === 0)
  )
    return null;
  // Already on a model of the kind the task calls for: trading one big model for another
  // (or one fast model for another) is not a suggestion worth a pill.
  const current = input.candidates.find(
    (candidate) => keyOf(candidate.selection) === keyOf(input.currentSelection),
  );
  if (current && Number.isFinite(current.quality) && tierOf(current) === difficulty.tier)
    return null;
  const candidates = input.candidates.filter(
    (candidate) =>
      candidate.available &&
      !candidate.disabled &&
      !candidate.legacy &&
      !candidate.superseded &&
      Number.isFinite(candidate.quality) &&
      (candidate.remainingPercent ?? 100) > 0,
  );
  const byKey = new Map(candidates.map((candidate) => [keyOf(candidate.selection), candidate]));
  const counts = new Map<
    string,
    {
      count: number;
      at: number;
      selections: Map<string, { count: number; at: number; selection: AutoModelSelection }>;
    }
  >();
  for (const chat of input.history) {
    if (
      chat.createdBy !== "user" ||
      chat.createdAt < input.now - MONTH_MS ||
      chat.createdAt > input.now
    )
      continue;
    const key = keyOf(chat.modelSelection);
    const candidate = byKey.get(key);
    if (!candidate || tierOf(candidate) !== difficulty.tier) continue;
    const modelKey = candidate.key ?? candidate.selection.model;
    const count = counts.get(modelKey) ?? { count: 0, at: 0, selections: new Map() };
    count.count++;
    count.at = Math.max(count.at, chat.createdAt);
    const optionsKey = JSON.stringify([
      chat.modelSelection.instanceId,
      chat.modelSelection.model,
      (chat.modelSelection.options ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
    ]);
    const variant = count.selections.get(optionsKey) ?? {
      count: 0,
      at: 0,
      selection: chat.modelSelection,
    };
    variant.count++;
    variant.at = Math.max(variant.at, chat.createdAt);
    count.selections.set(optionsKey, variant);
    counts.set(modelKey, count);
  }
  const favorite = Array.from(counts).sort(
    (a, b) => b[1].count - a[1].count || b[1].at - a[1].at || a[0].localeCompare(b[0]),
  )[0];
  let selection: AutoModelSelection | null;
  if (favorite) {
    selection =
      Array.from(favorite[1].selections).sort(
        (a, b) => b[1].count - a[1].count || b[1].at - a[1].at || a[0].localeCompare(b[0]),
      )[0]?.[1].selection ?? null;
  } else if (difficulty.tier === "big") {
    selection = input.picks.quality;
  } else {
    const speed = input.picks.speed;
    // Inspect even an exhausted Speed pick: it should fall back to Low cost too.
    const remaining = input.candidates.find(
      (candidate) => speed && keyOf(candidate.selection) === keyOf(speed),
    )?.remainingPercent;
    selection = remaining !== undefined && remaining <= 10 ? input.picks.frugal : speed;
  }
  if (!selection || keyOf(selection) === keyOf(input.currentSelection)) return null;
  const candidate = byKey.get(keyOf(selection));
  if (!candidate) return null;
  return {
    tier: difficulty.tier,
    confidence: Math.min(1, difficulty.confidence),
    selection,
    label: candidate.label,
  };
}

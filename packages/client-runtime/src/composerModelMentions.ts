import { collectModelLinks } from "@t3tools/shared/modelLinks";
import type { ModelPickerSearchableModel } from "./modelSearch.ts";

/** Literal word prefixes in picker order; a bare @ keeps the file menu unchanged. */
export function rankComposerModelMentions<T>(
  candidates: ReadonlyArray<T>,
  query: string,
  toSearchable: (candidate: T) => ModelPickerSearchableModel,
): T[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s:/-]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return [];
  return candidates
    .filter((candidate) => {
      const model = toSearchable(candidate);
      const words = [
        model.name,
        model.shortName,
        model.subProvider,
        model.driverKind,
        model.providerDisplayName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .split(/[\s:/-]+/u);
      return tokens.every((token) => words.some((word) => word.startsWith(token)));
    })
    .slice(0, 4);
}

/** Prompt text naming a provider instance and model for the agent. No `@`, which the editor would turn into a file chip. */
export function formatComposerModelMention(instanceId: string, model: string): string {
  return `model:${instanceId}/${model}`;
}

export interface ComposerModelMentionOccurrence {
  readonly label?: string;
  readonly instanceId: string;
  readonly model: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

// Instance ids match ProviderInstanceId; model slugs may contain `/`, as in `opencode/anthropic/opus`.
const MODEL_MENTION_PATTERN = /(?<![^\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu;
const SENTENCE_PUNCTUATION = ".;:!?";
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

// Slugs like `foo(bar)` or `GPT-6.1-Sol[1m]` keep balanced brackets; prose wrapping them does not.
function trimModelSlug(slug: string): string {
  let trimmed = slug;
  while (trimmed.length > 0) {
    const last = trimmed.at(-1)!;
    const opening = CLOSING_BRACKETS[last];
    const unbalanced = opening !== undefined && countOf(trimmed, opening) < countOf(trimmed, last);
    if (!SENTENCE_PUNCTUATION.includes(last) && !unbalanced) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** Finds the `model:<instance>/<model>` references that `formatComposerModelMention` writes. */
export function collectComposerModelMentions(
  text: string,
): ReadonlyArray<ComposerModelMentionOccurrence> {
  const links = collectModelLinks(text);
  if (!text.includes("model:")) return links;
  const occurrences: ComposerModelMentionOccurrence[] = [];
  for (const match of text.matchAll(MODEL_MENTION_PATTERN)) {
    const instanceId = match[1]!;
    const model = trimModelSlug(match[2]!);
    if (model.length === 0) continue;
    const start = match.index;
    const end = start + "model:".length + instanceId.length + 1 + model.length;
    occurrences.push({ instanceId, model, source: text.slice(start, end), start, end });
  }
  return [...occurrences, ...links].sort((a, b) => a.start - b.start);
}

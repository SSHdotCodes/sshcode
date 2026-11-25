import {
  composerBuiltInSlashRecencyKey,
  composerProviderSlashRecencyKey,
  composerRecentRankMap,
  composerRecentTieBreakerPrefix,
  composerSkillRecencyKey,
  orderByComposerRecentUse,
} from "@t3tools/client-runtime/composer-command-recency";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreProviderSkill } from "../../providerSkillSearch";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

export function slashSearchItemRecencyKey(item: SlashSearchItem): string {
  if (item.type === "slash-command") return composerBuiltInSlashRecencyKey(item.command);
  if (item.type === "provider-slash-command") {
    return composerProviderSlashRecencyKey(item.command.name);
  }
  return composerSkillRecencyKey(item.skill.name);
}

/**
 * A provider expands a slash command only when it opens the whole message;
 * anywhere else it reaches the agent as literal text, so it is not offered
 * there. Built-ins apply locally on selection and skills insert a `$` mention
 * the server dispatches from any position, so both stay available.
 */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
): SlashSearchItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter(
    (item) =>
      item.type !== "provider-slash-command" &&
      !(item.type === "slash-command" && item.command === "debug"),
  );
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    return scoreProviderSkill(item.skill, query);
  }

  const primaryValue =
    item.type === "slash-command" ? item.command.toLowerCase() : item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function slashMatchBand(item: SlashSearchItem, query: string, score: number): number {
  const primaryValue =
    item.type === "slash-command"
      ? item.command.toLowerCase()
      : item.type === "provider-slash-command"
        ? item.command.name.toLowerCase()
        : item.skill.name.toLowerCase();
  if (primaryValue === query) return 0;
  if (primaryValue.startsWith(query)) return 1;
  if (score < 20) return 2;
  if (score < 100) return 3;
  return 4;
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
  recentKeys: ReadonlyArray<string> = [],
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return orderByComposerRecentUse(items, recentKeys, slashSearchItemRecencyKey);
  }

  const recentRanks = composerRecentRankMap(recentKeys);
  const scored: Array<{
    item: SlashSearchItem;
    band: number;
    recentRank: number;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    const baseTieBreaker =
      item.type === "slash-command"
        ? `0\u0000${item.command}`
        : item.type === "provider-slash-command"
          ? `1\u0000${item.command.name}\u0000${item.provider}`
          : `2\u0000${item.skill.name}\u0000${item.provider}`;
    const recentRank = recentRanks.get(slashSearchItemRecencyKey(item));
    scored.push({
      item,
      band: slashMatchBand(item, normalizedQuery, score),
      recentRank: recentRank ?? Number.POSITIVE_INFINITY,
      score,
      tieBreaker: `${composerRecentTieBreakerPrefix(recentRank)}\u0000${baseTieBreaker}`,
    });
  }

  if (recentRanks.size === 0) {
    const ranked: Array<{ item: SlashSearchItem; score: number; tieBreaker: string }> = [];
    for (const entry of scored) {
      insertRankedSearchResult(ranked, entry, Number.POSITIVE_INFINITY);
    }
    return ranked.map((entry) => entry.item);
  }

  scored.sort(
    (left, right) =>
      left.band - right.band ||
      left.recentRank - right.recentRank ||
      left.score - right.score ||
      left.tieBreaker.localeCompare(right.tieBreaker),
  );
  return scored.map((entry) => entry.item);
}

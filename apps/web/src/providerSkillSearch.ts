import {
  composerRecentRankMap,
  composerRecentTieBreakerPrefix,
  composerSkillRecencyKey,
  orderByComposerRecentUse,
} from "@t3tools/client-runtime/composer-command-recency";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
} from "@t3tools/client-runtime/providerSkills";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

export function scoreProviderSkill(skill: ServerProviderSkill, query: string): number | null {
  const normalizedName = skill.name.toLowerCase();
  const normalizedLabel = formatProviderSkillDisplayName(skill).toLowerCase();
  const normalizedShortDescription = skill.shortDescription?.toLowerCase() ?? "";
  const normalizedDescription = skill.description?.toLowerCase() ?? "";
  const normalizedScope = skill.scope?.toLowerCase() ?? "";

  const scores = [
    scoreQueryMatch({
      value: normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: normalizedLabel,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
      fuzzyBase: 110,
    }),
    scoreQueryMatch({
      value: normalizedShortDescription,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: normalizedDescription,
      query,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
    scoreQueryMatch({
      value: normalizedScope,
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function skillMatchBand(skill: ServerProviderSkill, query: string, score: number): number {
  const name = skill.name.toLowerCase();
  const label = formatProviderSkillDisplayName(skill).toLowerCase();
  if (name === query || label === query) return 0;
  if (name.startsWith(query) || label.startsWith(query)) return 1;
  if (score < 20) return 2;
  if (score < 100) return 3;
  return 4;
}

export function searchProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
  limit = Number.POSITIVE_INFINITY,
  recentKeys: ReadonlyArray<string> = [],
): ServerProviderSkill[] {
  const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\p{Sc}+/u });

  if (!normalizedQuery) {
    return orderByComposerRecentUse(enabledSkills, recentKeys, (skill) =>
      composerSkillRecencyKey(skill.name),
    ).slice(0, limit);
  }

  const recentRanks = composerRecentRankMap(recentKeys);
  const scored: Array<{
    item: ServerProviderSkill;
    band: number;
    recentRank: number;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const skill of enabledSkills) {
    const score = scoreProviderSkill(skill, normalizedQuery);
    if (score === null) {
      continue;
    }

    const recentRank = recentRanks.get(composerSkillRecencyKey(skill.name));
    scored.push({
      item: skill,
      band: skillMatchBand(skill, normalizedQuery, score),
      recentRank: recentRank ?? Number.POSITIVE_INFINITY,
      score,
      tieBreaker: `${composerRecentTieBreakerPrefix(recentRank)}\u0000${formatProviderSkillDisplayName(skill).toLowerCase()}\u0000${skill.name}`,
    });
  }

  if (recentRanks.size === 0) {
    const ranked: Array<{ item: ServerProviderSkill; score: number; tieBreaker: string }> = [];
    for (const entry of scored) {
      insertRankedSearchResult(ranked, entry, limit);
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
  return scored.slice(0, limit).map((entry) => entry.item);
}

import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

export type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  /** Matched only by words with a `/` ("tencent/hy4"), so plain searches stay as they were. */
  slug?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;
// Far below any token-scored match, favorites included.
const MODEL_PICKER_EXACT_NAME_SCORE = -1000;

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    buildModelPickerSearchText(model),
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
    ignorePosition: true,
  });
}

function normalizeModelName(name: string): string {
  return normalizeSearchQuery(name).replace(/\s+/gu, " ");
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const normalizedQuery = tokens.join(" ");
  if (
    normalizedQuery === normalizeModelName(model.name) ||
    normalizedQuery === normalizeModelName(model.shortName ?? "")
  ) {
    return MODEL_PICKER_EXACT_NAME_SCORE;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores: Array<number> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const fieldScore = scoreModelPickerSearchToken(fields[index]!, token, index * 10);
      if (fieldScore !== null) {
        tokenScores.push(fieldScore);
      }
    }

    if (token.includes("/") && model.slug) {
      const slugScore = scoreQueryMatch({
        value: normalizeSearchQuery(model.slug),
        query: token,
        exactBase: fields.length * 10,
        prefixBase: fields.length * 10 + 2,
        boundaryBase: fields.length * 10 + 4,
        includesBase: fields.length * 10 + 6,
        ignorePosition: true,
      });
      if (slugScore !== null) tokenScores.push(slugScore);
    }

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

/**
 * Filters `items` to those matching `query`, best match first. Equal matches
 * keep their order in `items`, which is the provider's own newest-first order.
 */
export function rankModelPickerSearch<T>(
  items: ReadonlyArray<T>,
  query: string,
  toSearchable: (item: T) => ModelPickerSearchableModel,
): T[] {
  const ranked: Array<{
    item: T;
    score: number;
    isFavorite: boolean;
    order: number;
  }> = [];
  items.forEach((item, order) => {
    const searchable = toSearchable(item);
    const score = scoreModelPickerSearch(searchable, query);
    if (score !== null) {
      ranked.push({
        item,
        score,
        isFavorite: searchable.isFavorite === true,
        order,
      });
    }
  });
  return ranked
    .sort(
      (a, b) =>
        a.score - b.score || Number(b.isFavorite) - Number(a.isFavorite) || a.order - b.order,
    )
    .map((entry) => entry.item);
}

const makerNameKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The maker a query names outright ("meta", "Z.ai", or the company behind it: "alibaba"),
 * whatever its case or punctuation.
 */
export function makerNamedByQuery<
  G extends {
    readonly maker: { readonly label: string; readonly aliases?: ReadonlyArray<string> };
  },
>(groups: ReadonlyArray<G>, query: string): G | null {
  const wanted = makerNameKey(query);
  if (wanted.length < 2) return null;
  return (
    groups.find((group) =>
      [group.maker.label, ...(group.maker.aliases ?? [])].some(
        (name) => makerNameKey(name) === wanted,
      ),
    ) ?? null
  );
}

/**
 * A maker's routes in the order its own list reads: every model's best route, which is the
 * row that list shows, then the other ways to run each model. Model by model instead, one
 * model's four gateway routes would push the next model's plan route off the first screen.
 */
export function makerRoutesBestFirst<R>(
  models: ReadonlyArray<{ readonly routes: ReadonlyArray<R> }>,
): R[] {
  const best: R[] = [];
  const others: R[] = [];
  for (const model of models) {
    model.routes.forEach((route, index) => (index === 0 ? best : others).push(route));
  }
  return [...best, ...others];
}

/**
 * Search results for a maker's name: that maker's routes in the given order (see
 * `makerRoutesBestFirst`), then the rest as ranked. A gateway that happens to share the
 * name ("OpenCode · Meta") no longer outranks the maker's own harness.
 */
export function listMakerRoutesFirst<T>(
  ranked: ReadonlyArray<T>,
  makerRouteKeys: ReadonlyArray<string>,
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(ranked.map((item) => [keyOf(item), item] as const));
  const own: T[] = [];
  for (const key of makerRouteKeys) {
    const item = byKey.get(key);
    if (item === undefined) continue;
    own.push(item);
    byKey.delete(key);
  }
  return [...own, ...byKey.values()];
}

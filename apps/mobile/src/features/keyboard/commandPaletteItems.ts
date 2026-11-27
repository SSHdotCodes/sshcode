import {
  compareThreadSearchOrder,
  makeThreadSearchContextMatcher,
} from "@t3tools/shared/threadSearch";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly title: string;
  readonly detail?: string;
  readonly activityAt?: string | null;
  readonly searchAboutTerms?: ReadonlyArray<string>;
  readonly searchTerms: ReadonlyArray<string>;
  readonly run: () => void;
}

type SearchMatchOrder = { readonly about?: boolean; readonly activityAt?: string | null };

/** `>` narrows to actions, matching the desktop palette. */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  matches: ReadonlyMap<string, SearchMatchOrder>,
) {
  const actionsOnly = query.startsWith(">");
  const normalized = (actionsOnly ? query.slice(1) : query).trim().toLocaleLowerCase();
  const tokens = normalized.split(/\s+/);
  const matchesContext = makeThreadSearchContextMatcher(normalized);
  return items
    .flatMap((item, index) => {
      if (actionsOnly && item.kind !== "action") return [];
      if (!normalized)
        return item.kind === "project"
          ? []
          : [{ item, rank: 0, index, about: false, activityAt: null }];
      const title = item.title.toLocaleLowerCase();
      const haystack = [title, ...item.searchTerms].join(" ").toLocaleLowerCase();
      const match = item.kind === "thread" ? matches.get(item.key) : undefined;
      const about =
        item.kind === "thread" &&
        (match?.about === true || (item.searchAboutTerms ?? [item.title]).some(matchesContext));
      if (!about && !match && !tokens.every((token) => haystack.includes(token))) return [];
      const rank =
        title === normalized
          ? 3
          : title.startsWith(normalized)
            ? 2
            : title.includes(normalized)
              ? 1
              : 0;
      return [
        { item, rank, index, about, activityAt: item.activityAt ?? match?.activityAt ?? null },
      ];
    })
    .sort((left, right) => {
      if (!normalized) return left.index - right.index;
      const leftThread = left.item.kind === "thread";
      const rightThread = right.item.kind === "thread";
      return (
        Number(leftThread) - Number(rightThread) ||
        (leftThread ? compareThreadSearchOrder(left, right) : 0) ||
        right.rank - left.rank ||
        left.index - right.index
      );
    })
    .map(({ item }) => item);
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}

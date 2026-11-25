import {
  EnvironmentId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
  readonly failed: boolean;
  readonly pagination?: {
    readonly isLoading: boolean;
    readonly failed: boolean;
    readonly loadMore: () => void;
  };
}

type SearchCursor = NonNullable<OrchestrationSearchThreadsInput["cursor"]>;
interface SearchPage {
  readonly environmentId: EnvironmentId;
  readonly cursor?: SearchCursor;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Invalid search keys, failed
 * requests, and disconnected environments contribute no content matches,
 * preserving local title search as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
    cursor?: SearchCursor,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) => {
    const request = Atom.make<{
      readonly pages: ReadonlyArray<SearchPage>;
      readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
    } | null>(null).pipe(Atom.setIdleTTL(0));
    return Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false, failed: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const pending = get(request);
      const pages =
        pending?.pages ?? environmentIds.map((environmentId): SearchPage => ({ environmentId }));
      const matches = new Map(
        pending?.matches.map((match) => [threadSearchMatchKey(match), match] as const),
      );
      const next: SearchPage[] = [];
      const failedPages: Array<ReturnType<typeof options.getSearchAtom>> = [];
      let isLoading = false;

      for (const { environmentId, cursor } of pages) {
        const source = options.getSearchAtom(environmentId, query, cursor);
        const result = get(source);
        const waiting = result.waiting || (pending !== null && AsyncResult.isInitial(result));
        isLoading ||= waiting;
        if (pending && waiting) {
          if (cursor) next.push({ environmentId, cursor });
          continue;
        }
        if (AsyncResult.isFailure(result)) {
          failedPages.push(source);
          if (cursor) next.push({ environmentId, cursor });
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null) continue;
        if (!AsyncResult.isFailure(result) && value.nextCursor)
          next.push({ environmentId, cursor: value.nextCursor });
        for (const match of value.matches) {
          const scopedMatch = { ...match, environmentId };
          const matchKey = threadSearchMatchKey(scopedMatch);
          if (!matches.has(matchKey)) matches.set(matchKey, scopedMatch);
        }
      }

      const visible = [...matches.values()];
      const base = {
        matches: visible,
        isLoading: pending === null && isLoading,
        failed: pending === null && failedPages.length > 0 && failedPages.length === pages.length,
      };
      if (!next.length || (pending === null && isLoading)) return base;
      const registry = get.registry;
      return {
        ...base,
        pagination: {
          isLoading,
          failed: pending !== null && failedPages.length > 0,
          loadMore: () => {
            // An old event handler or a double tap must not replace a page already in flight.
            if (isLoading || registry.get(request) !== pending) return;
            registry.set(request, { pages: next, matches: visible });
            if (pending) for (const page of failedPages) registry.refresh(page);
          },
        },
      };
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`${options.labelPrefix}:${key}`));
  });
}

/** A search selection survives navigation until the destination timeline can reveal it. */
export const pendingThreadSearchJumpAtom = Atom.make<EnvironmentThreadSearchMatch | null>(
  null,
).pipe(Atom.keepAlive);

export type TimelineJumpTarget = Pick<
  import("../threadMedia.ts").ThreadMediaItem,
  "sourceItemId" | "messageId"
> & {
  /** A find result uses its entry ID across the visible transcript, including inherited rows. */
  readonly sourceThreadId?: import("@t3tools/contracts").ThreadId;
};
export interface TimelineJumpRequest {
  readonly item: TimelineJumpTarget;
  readonly sequence: number;
  readonly highlight?: boolean;
}
export function searchJumpTarget(match: EnvironmentThreadSearchMatch): TimelineJumpTarget | null {
  return match.messageId
    ? {
        sourceThreadId: match.threadId,
        sourceItemId: TurnItemId.make(match.messageId),
        messageId: match.messageId,
      }
    : null;
}
export function matchesTimelineJump(
  projected: OrchestrationV2ProjectedTurnItem | undefined,
  target: TimelineJumpTarget,
) {
  return (
    projected !== undefined &&
    (target.sourceThreadId === undefined || projected.sourceThreadId === target.sourceThreadId) &&
    (projected.sourceItemId === target.sourceItemId ||
      (target.sourceThreadId === undefined && projected.item.id === target.sourceItemId) ||
      (target.messageId !== undefined &&
        "messageId" in projected.item &&
        projected.item.messageId === target.messageId))
  );
}

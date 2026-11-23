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
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false, failed: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;
      let failures = 0;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        if (AsyncResult.isFailure(result)) failures += 1;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading, failed: failures > 0 && failures === environmentIds.length };
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}

/** A search selection survives navigation until the destination timeline can reveal it. */
export const pendingThreadSearchJumpAtom = Atom.make<EnvironmentThreadSearchMatch | null>(
  null,
).pipe(Atom.keepAlive);

export type TimelineJumpTarget = Pick<
  import("../threadMedia.ts").ThreadMediaItem,
  "sourceThreadId" | "sourceItemId" | "messageId"
>;
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
    projected?.sourceThreadId === target.sourceThreadId &&
    (projected.sourceItemId === target.sourceItemId ||
      (target.messageId !== undefined &&
        "messageId" in projected.item &&
        projected.item.messageId === target.messageId))
  );
}

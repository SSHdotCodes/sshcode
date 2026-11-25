import type {
  EnvironmentId,
  OrchestrationV2SearchThreadResult,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import type { ThreadFindAnchorReader, ThreadFindStart } from "./thread-find";

const FIND_REFRESH_MS = 300;

export function useMobileThreadFind(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly progressive: boolean;
  readonly contentRevision: object | null;
  readonly readAnchor: ThreadFindAnchorReader;
  readonly onReveal: (entryId: string) => void;
}) {
  const [find, setFind] = useState<{
    readonly input: string;
    readonly start: ThreadFindStart | undefined;
    readonly offset: number;
    readonly navigation: number;
  }>({ input: "", start: undefined, offset: 0, navigation: 0 });
  const { input, start, offset, navigation } = find;
  const { environmentId, threadId, progressive, contentRevision, readAnchor, onReveal } = props;
  const query = input.trim();
  const settledQuery = useDebouncedValue(query, 100);
  const atom = useMemo(
    () =>
      query && query === settledQuery
        ? (progressive
            ? orchestrationEnvironment.threadFindProgressive
            : orchestrationEnvironment.threadFind)({
            environmentId,
            input: {
              threadId,
              query,
              ...(start ? { start } : {}),
              ...(offset ? { offset } : {}),
            },
          })
        : null,
    [environmentId, threadId, query, settledQuery, progressive, start, offset],
  );
  const remote = useEnvironmentQuery(atom);
  const [lastAnswer, setLastAnswer] = useState<{
    readonly query: string;
    readonly result: OrchestrationV2SearchThreadResult | null;
  }>({ query: "", result: null });
  if (lastAnswer.query !== query || (remote.data && lastAnswer.result !== remote.data)) {
    setLastAnswer({ query, result: remote.data });
  }
  const result = remote.data ?? (lastAnswer.query === query ? lastAnswer.result : null);
  const isPending = Boolean(
    query && (atom === null || remote.isPending || remote.data?.complete === false),
  );
  const entryId = remote.data?.match?.entryId;
  const lastReveal = useRef<{ entryId: string; navigation: number } | null>(null);
  useEffect(() => {
    if (!entryId) return;
    if (lastReveal.current?.entryId === entryId && lastReveal.current.navigation === navigation)
      return;
    lastReveal.current = { entryId, navigation };
    onReveal(entryId);
  }, [entryId, navigation, onReveal]);

  const lastRevision = useRef(contentRevision);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRefresh = useRef(false);
  const refresh = useEffectEvent(() => {
    if (!atom) return;
    if (isPending) {
      queuedRefresh.current = true;
      return;
    }
    const match = result?.match;
    const rebased = match ? { entryId: match.entryId, occurrence: match.occurrence } : readAnchor();
    if (
      offset !== 0 ||
      rebased?.entryId !== start?.entryId ||
      rebased?.occurrence !== start?.occurrence
    ) {
      setFind((current) => ({ ...current, start: rebased, offset: 0 }));
    } else {
      remote.refresh();
    }
  });
  useEffect(() => {
    if (lastRevision.current === contentRevision) return;
    lastRevision.current = contentRevision;
    if (!query || refreshTimer.current !== null) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, FIND_REFRESH_MS);
  }, [contentRevision, query]);
  useEffect(() => {
    if (isPending || !queuedRefresh.current) return;
    queuedRefresh.current = false;
    refresh();
  }, [isPending]);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      queuedRefresh.current = false;
    },
    [query],
  );

  const match = result?.match;
  const canStep = Boolean(!isPending && !remote.error && match && (result?.totalMatches ?? 0) > 1);
  return {
    input,
    result,
    query,
    isPending,
    error: remote.error,
    canStep,
    changeQuery: (input: string) => {
      if (input.trim() === query) {
        setFind((current) => ({ ...current, input }));
        return;
      }
      setFind((current) => ({
        input,
        start: readAnchor(),
        offset: 0,
        navigation: current.navigation + 1,
      }));
    },
    step: (offset: number) => {
      if (!match || !canStep) return;
      setFind((current) => ({
        ...current,
        start: { entryId: match.entryId, occurrence: match.occurrence },
        offset,
        navigation: current.navigation + 1,
      }));
    },
  };
}

import {
  readSharedSkillsCatalog,
  subscribeSharedSkillsCatalog,
} from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId, SharedSkillsList } from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** Library skills for the composer. Settings writes publish into the same cache. */
export function useSharedSkillsCatalog(
  environmentId: EnvironmentId | null,
): SharedSkillsList | null {
  const listSkills = useAtomCommand(serverEnvironment.sharedSkillsList, { reportFailure: false });
  const listRef = useRef(listSkills);
  useEffect(() => {
    listRef.current = listSkills;
  }, [listSkills]);

  const catalog = useSyncExternalStore(
    subscribeSharedSkillsCatalog,
    () => (environmentId === null ? null : readSharedSkillsCatalog(environmentId)),
    () => null,
  );

  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A failed read would leave skills "loading" for good; retry, slower each time.
    const attempt = (retryMs: number) => {
      void listRef.current({ environmentId, input: {} }).then((result) => {
        if (cancelled || result._tag === "Success") return;
        timer = setTimeout(() => attempt(Math.min(retryMs * 2, 60_000)), retryMs);
      });
    };
    attempt(2_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentId]);

  return catalog;
}

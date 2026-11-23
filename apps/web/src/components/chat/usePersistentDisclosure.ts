import { useCallback, useState } from "react";

/** Keep a local render mirror of the timeline's bounded, per-thread disclosure cache. */
export function usePersistentDisclosure(entries: Set<string> | undefined, key: string | null) {
  const [expanded, setExpanded] = useState(() => key !== null && (entries?.has(key) ?? false));
  const updateExpanded = useCallback(
    (next: boolean) => {
      if (entries && key !== null) {
        if (next) entries.add(key);
        else entries.delete(key);
      }
      setExpanded(next);
    },
    [entries, key],
  );
  return [expanded, updateExpanded] as const;
}

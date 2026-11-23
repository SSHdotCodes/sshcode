import Storage from "expo-sqlite/kv-store";
import { useCallback, useEffect, useRef, useState } from "react";

const writes = new Map<string, Promise<void>>();

export function useWorkspaceHtmlScripts(environmentId: string | null, absolutePath: string | null) {
  const key =
    environmentId && absolutePath
      ? `workspace-html-scripts:${JSON.stringify([environmentId, absolutePath])}`
      : null;
  const revision = useRef(0);
  const [choice, setChoice] = useState<{ key: string; allowed: boolean } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let active = true;
    const currentRevision = revision.current;
    void (writes.get(key) ?? Promise.resolve())
      .then(() => Storage.getItem(key))
      .then((value) => {
        if (active && revision.current === currentRevision)
          setChoice({ key, allowed: value === "allowed" });
      })
      .catch(() => {
        if (active && revision.current === currentRevision) setChoice({ key, allowed: false });
      });
    return () => {
      active = false;
    };
  }, [key]);
  const allowed = key !== null && choice?.key === key && choice.allowed;
  const setAllowed = useCallback(
    (value: boolean) => {
      if (key === null) return;
      revision.current += 1;
      setChoice({ key, allowed: value });
      const write = (writes.get(key) ?? Promise.resolve())
        .then(() => (value ? Storage.setItem(key, "allowed") : Storage.removeItem(key)))
        .catch(() => undefined);
      writes.set(key, write);
      void write.finally(() => {
        if (writes.get(key) === write) writes.delete(key);
      });
    },
    [key],
  );
  return { allowed, setAllowed };
}

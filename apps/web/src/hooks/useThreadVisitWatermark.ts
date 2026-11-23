import { useLayoutEffect, useRef, useState } from "react";

/** Hold the unread boundary that was visible when this thread opened. */
export function useThreadVisitWatermark(
  threadKey: string,
  lastVisitedAt: string | null | undefined,
) {
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchAtRef = useRef(0);
  const [watermark, setWatermark] = useState<{
    threadKey: string;
    openedAt: string;
    lastVisitedAt: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    lastDispatchedVisitRef.current = null;
    lastVisitDispatchAtRef.current = 0;
  }, [threadKey]);
  useLayoutEffect(() => {
    if (watermark?.threadKey === threadKey) return;
    setWatermark(
      lastVisitedAt === undefined
        ? null
        : {
            threadKey,
            lastVisitedAt,
            openedAt: new Date().toISOString(),
          },
    );
  }, [threadKey, lastVisitedAt, watermark]);
  return {
    visitWatermark: watermark?.threadKey === threadKey ? watermark : null,
    lastDispatchedVisitRef,
    lastVisitDispatchAtRef,
  };
}

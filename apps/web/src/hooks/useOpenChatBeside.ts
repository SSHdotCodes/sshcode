import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { readThreadShell } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSplitChatStore } from "../splitChatStore";

export function isSplittableChat(ref: ScopedThreadRef) {
  const thread = readThreadShell(ref);
  return thread !== null && !thread.archivedAt && !thread.deletedAt && !thread.source.comparison;
}

export function useOpenChatBeside() {
  const active = useParams({ strict: false, select: resolveThreadRouteRef });
  const navigate = useNavigate();
  return useCallback(
    async (beside: ScopedThreadRef) => {
      if (!active || !isSplittableChat(active) || !isSplittableChat(beside)) return;
      useSplitChatStore.getState().openBeside(active, beside);
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(beside) });
    },
    [active, navigate],
  );
}

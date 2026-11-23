import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

/** Codex 0.156 replaces count-based rollback with a boundary in paginated history. */
export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  numTurns: number,
  boundary?: { readonly firstRemoved: string; readonly lastRetained: string | null },
) {
  let remaining = numTurns;
  let pageSize = Math.min(remaining, 100);
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  history: while (pageSize > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: pageSize,
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      if (boundary !== undefined) {
        if (turn.id === boundary.lastRetained) break history;
        if (turn.id === boundary.firstRemoved) {
          beforeTurnId = turn.id;
          break history;
        }
      } else {
        beforeTurnId = turn.id;
      }
      remaining--;
      if (remaining === 0 && boundary === undefined) break history;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
    pageSize = boundary === undefined ? Math.min(remaining, 100) : 100;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});

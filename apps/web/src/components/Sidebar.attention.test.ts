import { describe, expect, it } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../test-fixtures";
import {
  sidebarAttentionCountsAtom,
  sidebarAttentionSourceAtom,
  sidebarAttentionDescription,
} from "./Sidebar.attention";

describe("collapsed sidebar attention description", () => {
  it.effect("retains live shell counts after the expanded list's last consumer unmounts", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const threads = Array.from({ length: 22 }, (_, index) =>
        makeThreadFixture({
          id: ThreadId.make(`attention-${index}`),
          hasPendingApprovals: index < 4,
          lastVisitedAt: "2026-10-25T20:00:00.000Z",
          latestRun: {
            runId: RunId.make(`run-${index}`),
            status: "completed",
            requestedAt: null,
            startedAt: null,
            completedAt: "2026-10-26T01:00:00.000Z",
            assistantMessageId: null,
          },
        }),
      );
      try {
        registry.set(sidebarAttentionSourceAtom, { threads, visits: {}, discordMode: false });
        const closeList = registry.mount(sidebarAttentionCountsAtom);
        expect(registry.get(sidebarAttentionCountsAtom)).toEqual({ unread: 22, needsYou: 4 });
        closeList();
        yield* Effect.yieldNow;
        expect(registry.get(sidebarAttentionCountsAtom)).toEqual({ unread: 22, needsYou: 4 });

        // A visit/approval update while closed must reach the collapsed trigger too.
        registry.set(sidebarAttentionSourceAtom, {
          threads: threads.map((thread, index) =>
            index === 0
              ? {
                  ...thread,
                  lastVisitedAt: "2026-10-26T02:00:00.000Z",
                  hasPendingApprovals: false,
                }
              : thread,
          ),
          visits: {},
          discordMode: false,
        });
        expect(registry.get(sidebarAttentionCountsAtom)).toEqual({ unread: 21, needsYou: 3 });
        registry.set(sidebarAttentionSourceAtom, { threads: [], visits: {}, discordMode: false });
        expect(registry.get(sidebarAttentionCountsAtom)).toEqual({ unread: 0, needsYou: 0 });
      } finally {
        registry.dispose();
      }
    }),
  );

  it("keeps exact counts accessible even when visual badges cap at 99+", () => {
    expect(sidebarAttentionDescription({ unread: 1200, needsYou: 103 })).toBe(
      "1200 unread chats, 103 chats need you",
    );
    expect(sidebarAttentionDescription({ unread: 1, needsYou: 1 })).toBe(
      "1 unread chat, 1 chat needs you",
    );
    expect(sidebarAttentionDescription({ unread: 0, needsYou: 0 })).toBe(
      "0 unread chats, 0 chats need you",
    );
  });
});

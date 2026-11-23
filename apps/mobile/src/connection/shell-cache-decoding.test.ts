import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, RuntimeRequestId, RunId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import {
  firstScreenShellSnapshot,
  SHELL_PREVIEW_THREAD_LIMIT,
  encodeStoredShellPreview,
  decodeStoredShellPreview,
} from "./shell-cache-decoding";
import { homeMachineSummaries } from "../lib/thread-summaries";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";

describe("first screen shell cache", () => {
  it("excludes Models helpers from phone rows, unread and needs-you counts", () => {
    const helper = {
      ...v2ThreadShell,
      id: ThreadId.make("models:saved"),
      latestRunId: RunId.make("models-run"),
      status: "waiting" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("key"),
        kind: "user_input" as const,
        createdAt: v2ThreadShell.updatedAt,
      },
      latestVisibleMessage: {
        id: MessageId.make("model-reply"),
        role: "assistant" as const,
        text: "Need a key",
        updatedAt: v2ThreadShell.updatedAt,
      },
      lastVisitedAt: DateTime.makeUnsafe(0),
    };
    const environmentId = EnvironmentId.make("models-counts");
    const baseline = firstScreenShellSnapshot(
      { ...v2ShellSnapshot, threads: [v2ThreadShell] },
      environmentId,
    );
    const preview = firstScreenShellSnapshot(
      { ...v2ShellSnapshot, threads: [helper, v2ThreadShell] },
      environmentId,
    );
    expect(preview.threads.map((thread) => thread.id)).toEqual([v2ThreadShell.id]);
    expect(preview.previewCounts).toEqual(baseline.previewCounts);
  });

  it("counts a child request on its parent without presenting the child's row", () => {
    let titleReads = 0;
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("hidden"),
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
      status: "running" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("pending"),
        kind: "user_input" as const,
        createdAt: v2ThreadShell.createdAt,
      },
      get title() {
        titleReads++;
        return "Child";
      },
    };
    const preview = firstScreenShellSnapshot(
      { ...v2ShellSnapshot, threads: [v2ThreadShell, child] },
      EnvironmentId.make("preview"),
    );
    expect(preview.threads).toEqual([v2ThreadShell]);
    expect(preview.previewCounts).toMatchObject({ visibleChats: 1, needsYou: 1, pendingInput: 0 });
    expect(titleReads).toBe(0);
  });

  it("counts an actionable plan in the machine chip before and after hydration", () => {
    const environmentId = EnvironmentId.make("plans");
    const planChat = { ...v2ThreadShell, hasActionableProposedPlan: true };
    const preview = firstScreenShellSnapshot(
      { ...v2ShellSnapshot, threads: [planChat] },
      environmentId,
    );
    expect(preview.previewCounts?.needsYou).toBe(1);
    const live = homeMachineSummaries([presentThreadShell(environmentId, planChat)]);
    expect(live.get(environmentId)?.needsYou).toBe(1);
  });

  it.effect("stores full counts including unread and active chats outside the first 64 rows", () =>
    Effect.gen(function* () {
      const id = EnvironmentId.make("counts");
      const requests = Array.from({ length: 150 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`a-request-${index}`),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make(`request-${index}`),
          kind: "user_input" as const,
          createdAt: v2ThreadShell.updatedAt,
        },
      }));
      const working = Array.from({ length: 20 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`w-working-${index}`),
        latestRunId: RunId.make(`run-${index}`),
        status: "running" as const,
      }));
      const unread = {
        ...v2ThreadShell,
        id: ThreadId.make("z-unread"),
        lastVisitedAt: DateTime.makeUnsafe(0),
        latestVisibleMessage: {
          id: MessageId.make("reply"),
          role: "assistant" as const,
          text: "Ready",
          updatedAt: v2ThreadShell.updatedAt,
        },
      };
      const full = { ...v2ShellSnapshot, threads: [...requests, ...working, unread] };
      const preview = firstScreenShellSnapshot(full, id);
      const partial = preview.threads.map((thread) => presentThreadShell(id, thread));
      expect(homeMachineSummaries(partial).get(id)).toEqual({ needsYou: 64, unread: false });
      expect(preview.previewCounts).toEqual({
        visibleChats: 171,
        needsYou: 150,
        unread: true,
        working: 20,
        pendingInput: 150,
      });
      expect(
        homeMachineSummaries(partial, new Map([[id, preview.previewCounts!]])).get(id),
      ).toEqual({ needsYou: 150, unread: true });
      const decoded = yield* encodeStoredShellPreview({
        schemaVersion: 3,
        environmentId: id,
        snapshot: preview,
      }).pipe(Effect.flatMap(decodeStoredShellPreview));
      expect(decoded.snapshot.previewCounts).toEqual(preview.previewCounts);
      expect(full.threads).toHaveLength(171);
    }),
  );
  it("bounds startup rows and prioritizes pinned, active and recent visible chats", () => {
    const threads = Array.from({ length: 5_000 }, (_, index) => ({
      ...v2ThreadShell,
      id: ThreadId.make(`chat-${index}`),
      updatedAt: DateTime.makeUnsafe(index * 1_000),
    }));
    const pinned = { ...threads[0]!, pinnedAt: DateTime.makeUnsafe(1) };
    const working = { ...threads[1]!, status: "running" as const };
    const child = {
      ...threads[4_999]!,
      lineage: { ...v2ThreadShell.lineage, relationshipToParent: "subagent" as const },
    };
    threads[0] = pinned;
    threads[1] = working;
    threads[4_999] = child;
    const full = { ...v2ShellSnapshot, threads };
    const preview = firstScreenShellSnapshot(full, EnvironmentId.make("preview"));
    expect(preview.threads).toHaveLength(SHELL_PREVIEW_THREAD_LIMIT);
    expect(preview.threads.slice(0, 3)).toEqual([pinned, working, threads[4_998]]);
    expect(preview.threads).not.toContain(child);
    expect(full.threads).toHaveLength(5_000);
    expect(preview.snapshotSequence).toBe(full.snapshotSequence);
  });
});

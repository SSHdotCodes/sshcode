import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { TeamBoardJournal, TeamBoardNotice } from "./TeamBoardJournal.ts";
import { RETENTION_MS } from "./model.ts";

export const BOARD_NOTICE_PREFIX = "SSHCode team board (from sibling subagents, not the user): ";
export const BOARD_CROSS_CHAT_PREFIX =
  "SSHCode team board (from another chat in this repo, not the user): ";
export const BOARD_USER_PREFIX = "From the user, via the team board: ";
export const BOARD_NOTICE_BYTES = 1_200;

export interface NoticeDelivery {
  readonly text: string;
  readonly notices: ReadonlyArray<TeamBoardNotice>;
  readonly finish: (accepted: boolean) => Effect.Effect<void>;
}

export const make = Effect.fnUntraced(function* (journal: TeamBoardJournal["Service"]) {
  const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
  const restore = yield* journal.loadNotices.pipe(
    Effect.catch(() =>
      Effect.logWarning("Could not restore team board notices").pipe(Effect.as([])),
    ),
  );
  const boxes = new Map<ThreadId, Map<string, TeamBoardNotice>>();
  const usedGuidance = new Set<RunId>();
  const reserved = new Set<string>();
  const offered = new Set<string>();
  let removed = false;
  const lane = yield* Semaphore.make(1);
  const getBox = (threadId: ThreadId) => {
    const box = boxes.get(threadId) ?? new Map<string, TeamBoardNotice>();
    boxes.set(threadId, box);
    return box;
  };
  for (const notice of restore) {
    if (notice.at > cutoff) getBox(notice.threadId).set(notice.id, notice);
  }
  const save = Effect.suspend(() =>
    journal.saveNotices([...boxes.values()].flatMap((box) => [...box.values()])),
  ).pipe(Effect.catch(() => Effect.logWarning("Could not checkpoint team board notices")));
  const pendingGuidance = (threadId: ThreadId, runId: RunId) =>
    [...(boxes.get(threadId)?.values() ?? [])].some(
      (notice) => notice.guidance && notice.runId === runId,
    );
  const pendingLeadGuidance = (threadId: ThreadId, runId: RunId, pushId: string) =>
    [...(boxes.get(threadId)?.values() ?? [])].some(
      (notice) => notice.leadGuidance && notice.runId === runId && notice.pushId === pushId,
    );
  const markUsed = (runId: RunId) => {
    if (usedGuidance.size >= 4_096) usedGuidance.delete(usedGuidance.values().next().value!);
    usedGuidance.add(runId);
  };
  const enqueue = (notice: TeamBoardNotice) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        if (
          notice.guidance &&
          (usedGuidance.has(notice.runId) || pendingGuidance(notice.threadId, notice.runId))
        )
          return false;
        if (
          notice.leadGuidance &&
          notice.pushId !== undefined &&
          pendingLeadGuidance(notice.threadId, notice.runId, notice.pushId)
        )
          return false;
        const box = getBox(notice.threadId);
        const prior =
          notice.batchAt === undefined
            ? undefined
            : [...box.values()].find(
                (candidate) =>
                  candidate.batchAt === notice.batchAt &&
                  candidate.runId === notice.runId &&
                  candidate.pushId === notice.pushId &&
                  !candidate.attachOnly &&
                  !offered.has(candidate.id) &&
                  !reserved.has(candidate.id),
              );
        if (prior === undefined) box.set(notice.id, notice);
        else {
          // Batched handoffs use their neutral commit-and-files form. A single
          // handoff still gets its normal mode-limited steer.
          const text = `${prior.fallbackText ?? prior.text}\n${notice.fallbackText ?? notice.text}`;
          if (Buffer.byteLength(text) > BOARD_NOTICE_BYTES) {
            box.set(notice.id, { ...notice, attachOnly: true });
          } else {
            const { from: _from, fallbackText: _fallback, ...batch } = prior;
            box.set(prior.id, {
              ...batch,
              text,
              postIds: [...(prior.postIds ?? []), ...(notice.postIds ?? [])],
            });
          }
        }
        if (notice.batchAt === undefined) offered.add(notice.id);
        yield* save;
        return notice.batchAt === undefined;
      }),
    );
  const due = (now: number) => {
    const queued: TeamBoardNotice[] = [];
    for (const box of boxes.values())
      for (const notice of box.values()) {
        if (offered.has(notice.id) || reserved.has(notice.id) || (notice.batchAt ?? 0) > now)
          continue;
        offered.add(notice.id);
        if (!notice.attachOnly) queued.push(notice);
      }
    return queued;
  };
  const reserve = (
    threadId: ThreadId,
    isLive: (notice: TeamBoardNotice) => boolean,
    steerId?: string,
    runId?: RunId,
  ): NoticeDelivery | undefined => {
    const box = boxes.get(threadId);
    if (box === undefined) return undefined;
    const single = steerId === undefined ? undefined : box.get(steerId);
    if (steerId !== undefined && single === undefined) return undefined;
    const selected: TeamBoardNotice[] = [];
    const lines: string[] = [];
    let size = 0;
    for (const notice of single === undefined ? box.values() : [single]) {
      if (reserved.has(notice.id)) continue;
      // Check the exact cohort and run before offering anything, including a
      // notice recovered from disk or a steer queued before a member finished.
      if (!isLive(notice)) {
        box.delete(notice.id);
        offered.delete(notice.id);
        removed = true;
        continue;
      }
      if (!offered.has(notice.id) || (runId !== undefined && notice.runId !== runId)) continue;
      const line = single === undefined ? (notice.fallbackText ?? notice.text) : notice.text;
      const length = Buffer.byteLength(line) + 1;
      if (lines.length > 0 && size + length > BOARD_NOTICE_BYTES) break;
      size += length;
      reserved.add(notice.id);
      selected.push(notice);
      lines.push(line);
    }
    if (box.size === 0) boxes.delete(threadId);
    if (selected.length === 0) return undefined;
    return {
      text: lines.join("\n"),
      notices: selected,
      finish: (accepted) =>
        lane.withPermits(1)(
          Effect.gen(function* () {
            for (const notice of selected) {
              reserved.delete(notice.id);
              if (!accepted) continue;
              box.delete(notice.id);
              offered.delete(notice.id);
              if (notice.guidance) markUsed(notice.runId);
            }
            if (!accepted) return;
            if (box.size === 0 && boxes.get(threadId) === box) boxes.delete(threadId);
            yield* save;
          }),
        ),
    };
  };
  const prune = lane.withPermits(1)(
    Effect.gen(function* () {
      if (boxes.size === 0) return;
      const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
      let removed = false;
      for (const [threadId, box] of boxes) {
        for (const [id, notice] of box) {
          if (notice.at > cutoff || reserved.has(id)) continue;
          box.delete(id);
          offered.delete(id);
          removed = true;
        }
        if (box.size === 0) boxes.delete(threadId);
      }
      if (removed) yield* save;
    }),
  );
  const flushRemoved = lane.withPermits(1)(
    Effect.suspend(() => {
      if (!removed) return Effect.void;
      removed = false;
      return save;
    }),
  );
  // Previously offered immediate notices are eligible for fallback as soon as the server restarts.
  const activate = (now: number) => {
    for (const box of boxes.values())
      for (const notice of box.values()) if ((notice.batchAt ?? 0) <= now) offered.add(notice.id);
  };
  activate(cutoff + RETENTION_MS);
  return {
    enqueue,
    due,
    reserve,
    pendingGuidance,
    pendingLeadGuidance,
    usedGuidance,
    prune,
    flushRemoved,
    pending: (id: ThreadId) => boxes.has(id),
  };
});

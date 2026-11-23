/**
 * Which timeline rows just arrived in an open chat, so only those animate in. Rows also
 * appear when a chat opens, when older history is paged in and when the reader switches
 * chats; none of those are arrivals.
 */
export const TIMELINE_ARRIVAL_MS = 600;
// More than this many new rows at once is a load, not something that just happened.
const MAX_ARRIVALS_AT_ONCE = 3;
// New rows land at the end, or just above the working indicator that stays last.
const TAIL_ROWS = 4;
const MAX_TRACKED_CHATS = 8;

interface ChatRows {
  readonly known: Set<string>;
  length: number;
}

const chats = new Map<string, ChatRows>();
const arrivedAt = new Map<string, number>();

/** Call with the chat's rows whenever they change. */
export function noteTimelineRows(
  chatKey: string,
  rows: ReadonlyArray<{ readonly id: string }>,
  now: number,
): void {
  const chat = chats.get(chatKey);
  if (chat === undefined) {
    // First sight of this chat: everything in it was already there.
    chats.set(chatKey, { known: new Set(rows.map((row) => row.id)), length: rows.length });
    if (chats.size > MAX_TRACKED_CHATS) chats.delete(chats.keys().next().value!);
    return;
  }
  const last = rows.at(-1);
  // Text streaming into existing rows changes the array many times a second: leave early.
  if (rows.length <= chat.length && (last === undefined || chat.known.has(last.id))) {
    chat.length = rows.length;
    return;
  }
  chat.length = rows.length;
  const fresh: string[] = [];
  let added = 0;
  for (let index = 0; index < rows.length; index++) {
    const id = rows[index]!.id;
    if (chat.known.has(id)) continue;
    chat.known.add(id);
    added++;
    if (index >= rows.length - TAIL_ROWS) fresh.push(id);
  }
  if (added === 0 || added > MAX_ARRIVALS_AT_ONCE) return;
  for (const [id, at] of arrivedAt) if (now - at >= TIMELINE_ARRIVAL_MS) arrivedAt.delete(id);
  for (const id of fresh) arrivedAt.set(id, now);
}

/** True for a moment after the row first appeared at the end of an open chat. */
export function timelineRowArrived(rowId: string, now: number): boolean {
  const at = arrivedAt.get(rowId);
  return at !== undefined && now - at < TIMELINE_ARRIVAL_MS;
}

export function resetTimelineArrivalsForTest(): void {
  chats.clear();
  arrivedAt.clear();
}

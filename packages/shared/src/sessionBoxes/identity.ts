import { SESSION_BOX_FACE_COUNTS } from "./faces.ts";
import type { SessionBoxFaceVariant, SessionBoxIconId, SessionBoxTopic } from "./taxonomy.ts";
import { fnv1a } from "./text.ts";

/**
 * Each box keeps one paint color for life, so a chat stays recognizable at a glance as
 * boxes move. Twelve hues spaced around the wheel; the thread id picks one.
 */
export const SESSION_BOX_HUES = [8, 28, 45, 85, 140, 165, 190, 210, 232, 262, 290, 330] as const;

export function sessionBoxHue(threadId: string): number {
  return SESSION_BOX_HUES[fnv1a(threadId) % SESSION_BOX_HUES.length]!;
}

/** A topic's painting by number, 1 being its first; numbers past its last wrap around. */
export function sessionBoxFace(
  topic: SessionBoxTopic,
  variant: number,
  counts: Readonly<Record<SessionBoxTopic, number>> = SESSION_BOX_FACE_COUNTS,
): SessionBoxIconId {
  const count = counts[topic];
  const index = (((variant - 1) % count) + count) % count;
  return index === 0 ? `topic-${topic}` : `topic-${topic}-${(index + 1) as SessionBoxFaceVariant}`;
}

/** A painting's topic and number (1 for its first), if `id` names one this build has. */
export function sessionBoxFaceOf(
  id: string,
  counts: Readonly<Record<SessionBoxTopic, number>> = SESSION_BOX_FACE_COUNTS,
): { readonly topic: SessionBoxTopic; readonly variant: number } | null {
  const match = /^topic-([a-z]+)(?:-(\d+))?$/u.exec(id);
  const topic = match?.[1] as SessionBoxTopic | undefined;
  if (topic === undefined || counts[topic] === undefined) return null;
  const variant = match?.[2] === undefined ? 1 : Number(match[2]);
  return variant >= 1 && variant <= counts[topic] ? { topic, variant } : null;
}

/** The painting a chat gets on its own: its id picks one of its topic's paintings. */
export function sessionBoxDefaultFace(threadId: string, topic: SessionBoxTopic): SessionBoxIconId {
  return sessionBoxFace(topic, 1 + (fnv1a(`${threadId}#face`) % SESSION_BOX_FACE_COUNTS[topic]));
}

/**
 * Paintings for a list of chats, so chats on the same topic look different. Oldest first,
 * each chat takes its `preferred` painting (the one its title step picked) or else the one
 * its id picks, unless a chat on that topic already has it; then a painting no chat has,
 * or else the one whose last chat is oldest. So the newest chats on a topic, up to its
 * number of paintings, all differ, and a chat keeps its painting as newer ones arrive.
 */
export function sessionBoxFaces(
  chats: Iterable<{
    readonly id: string;
    readonly topic: SessionBoxTopic;
    readonly createdAt: string;
    readonly preferred?: string | null | undefined;
  }>,
  counts: Readonly<Record<SessionBoxTopic, number>> = SESSION_BOX_FACE_COUNTS,
): Map<string, SessionBoxIconId> {
  const ordered = [...chats].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const lastUse = new Map<SessionBoxTopic, number[]>();
  const faces = new Map<string, SessionBoxIconId>();
  ordered.forEach((chat, order) => {
    const preferred = chat.preferred ? sessionBoxFaceOf(chat.preferred, counts) : null;
    const topic = preferred?.topic ?? chat.topic;
    const count = counts[topic];
    const uses = lastUse.get(topic) ?? Array.from({ length: count }, () => -1);
    lastUse.set(topic, uses);
    let pick = preferred !== null ? preferred.variant - 1 : fnv1a(`${chat.id}#face`) % count;
    if (uses[pick] !== -1) {
      const free = uses.indexOf(-1);
      pick = free !== -1 ? free : uses.indexOf(Math.min(...uses));
    }
    uses[pick] = order;
    faces.set(chat.id, sessionBoxFace(topic, pick + 1, counts));
  });
  return faces;
}

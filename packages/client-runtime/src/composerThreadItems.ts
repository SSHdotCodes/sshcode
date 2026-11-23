import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
  /** What the chat runs on; a description may name it ("the Muse Wonder one"). */
  readonly providerInstanceId?: string | undefined;
  readonly modelSelection?: { readonly model: string } | null | undefined;
  /** Says whether an agent started the chat as its subagent. */
  readonly lineage?: { readonly relationshipToParent: string | null } | undefined;
}

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads the `@` picker offers next to file paths. The agent can only read threads on its
 * own server, so candidates stay within the composer's environment unless the caller names
 * other machines: a chat picked from one of those travels as its transcript instead. A query
 * is required: bare `@` stays a file picker. Overview opts into empty queries and
 * working-first ordering.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
  allowEmptyQuery?: boolean;
  workingThreadIds?: ReadonlySet<ThreadId>;
  limit?: number;
  /** Another machine's name when its chats may be offered too; null leaves them out. */
  otherEnvironmentLabel?: (environmentId: EnvironmentId) => string | null;
}): ComposerThreadItem[] {
  const otherLabels = new Map<EnvironmentId, string | null>();
  const otherLabel = (environmentId: EnvironmentId) => {
    if (environmentId === input.environmentId || !input.otherEnvironmentLabel) return null;
    if (!otherLabels.has(environmentId))
      otherLabels.set(environmentId, input.otherEnvironmentLabel(environmentId));
    return otherLabels.get(environmentId) ?? null;
  };
  const query = input.query.trim().toLowerCase();
  if (query.length === 0 && !input.allowEmptyQuery) return [];
  return input.shells
    .filter(
      (shell) =>
        (shell.environmentId === input.environmentId || otherLabel(shell.environmentId) !== null) &&
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        shell.deletedAt == null &&
        shell.title.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(input.workingThreadIds?.has(right.id) ?? false) -
          Number(input.workingThreadIds?.has(left.id) ?? false) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit ?? COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description:
        shell.environmentId !== input.environmentId
          ? `Chat on ${otherLabel(shell.environmentId)}`
          : input.workingThreadIds?.has(shell.id)
            ? "Working chat"
            : "Thread",
    }));
}

const CHAT_MENTION_RESULT_LIMIT = 8;
// The search did not return the chat.
const UNRANKED = Number.MAX_SAFE_INTEGER;
const CHAT_MENTION_QUERY_MAX_LENGTH = 200;

// Words that only say "a chat" or hold a description together. They name nothing to look
// for, and the keyword half of the server's search needs every word it is given.
const CHAT_MENTION_FILLER = new Set(
  (
    "a an and about at chat chats conversation conversations convo for from i in is it my of " +
    "on one our session sessions that the thread threads this to was we were where which with"
  ).split(" "),
);

// "student's" is the word "student": its ending is no word of its own.
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/['\u2019]s(?![\p{L}\p{N}])/gu, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The words of a chat's description that can match something. A lone letter says nothing
 * (it matched every title with an "'s" in it); a lone digit can be a version ("Qwen 4").
 */
export function chatMentionWords(query: string): string[] {
  const seen = new Set<string>();
  return wordsOf(query).filter((word) => {
    if (CHAT_MENTION_FILLER.has(word) || seen.has(word)) return false;
    if (word.length === 1 && !/\p{N}/u.test(word)) return false;
    seen.add(word);
    return true;
  });
}

/**
 * What to ask the server's chat search for: the description without its filler words
 * ("chat with black hole muse wonder" asks for "black hole muse wonder"). A description made
 * of nothing else is asked as written.
 */
export function chatMentionSearchQuery(query: string): string {
  const words = chatMentionWords(query);
  return (words.length > 0 ? words.join(" ") : query.trim()).slice(
    0,
    CHAT_MENTION_QUERY_MAX_LENGTH,
  );
}

// A described word matches a title word it begins ("simul" for "simulation") or that it
// only adds an ending to ("taxes" for "tax"). "opencode" is not "open".
const sameWord = (word: string, token: string) =>
  word === token ||
  (word.length >= 3 && token.startsWith(word)) ||
  (token.length >= 3 && word.startsWith(token) && word.length - token.length <= 2);

/** What a search can read a chat's name from: its title and what it runs on. */
export interface NameableChat {
  readonly title: string;
  readonly model?: string | null | undefined;
  readonly providerInstanceId?: string | null | undefined;
}

/**
 * How far a description's words name a chat. `named` counts in tenths so equal matches
 * compare equal: ten for a word the title carries, eight for one only its model or harness
 * carries. The model counts a little less than the title: many chats share one. It still has
 * to tell apart chats whose titles are the same, which is when it gets named.
 */
export function chatNaming(
  words: ReadonlyArray<string>,
  chat: NameableChat,
): { named: number; share: number; inTitle: number; covered: number } {
  const title = wordsOf(chat.title);
  const runsOn = wordsOf(`${chat.model ?? ""} ${chat.providerInstanceId ?? ""}`);
  let named = 0;
  let inTitle = 0;
  let covered = 0;
  for (const word of words) {
    if (title.some((token) => sameWord(word, token))) {
      named += 10;
      inTitle += 1;
      covered += 1;
    } else if (runsOn.some((token) => sameWord(word, token))) {
      named += 8;
      covered += 1;
    }
  }
  return { named, share: words.length > 0 ? named / (10 * words.length) : 0, inTitle, covered };
}

const NAMED_CHATS_ADDED_LIMIT = 20;

/**
 * Puts the chats a search names ahead of the ones that only talk about its words.
 * `results` is the list as found (title matches, then what was said in each chat), which
 * cannot see what a chat ran on: "muse wonder full black hole" found the two Muse Wonder
 * Full black hole chats eleventh and sixteenth, behind chats that mention those words.
 *
 * A chat is named when its title and model carry at least half the words, one of them in
 * the title; its model alone names it only when it carries every word ("muse wonder full").
 * More words named come first, and the found order settles the rest. `others` are chats no
 * search returned, in list order: those the title helps name are added.
 */
export function liftNamedChats<T>(input: {
  readonly query: string;
  readonly results: ReadonlyArray<T>;
  readonly chatOf: (result: T) => NameableChat | null;
  readonly others?: ReadonlyArray<T> | undefined;
}): T[] {
  const words = chatMentionWords(input.query);
  if (words.length === 0) return [...input.results];
  const naming = (result: T) => {
    const chat = input.chatOf(result);
    return chat ? chatNaming(words, chat) : null;
  };
  const ranked = input.results.map((result, index) => {
    const name = naming(result);
    const isNamed =
      name !== null && name.share >= 0.5 && (name.inTitle > 0 || name.covered === words.length);
    return { result, index, named: isNamed ? name.named : 0 };
  });
  let added = 0;
  for (const other of input.others ?? []) {
    if (added >= NAMED_CHATS_ADDED_LIMIT) break;
    const name = naming(other);
    if (name === null || name.share < 0.5 || name.inTitle === 0) continue;
    ranked.push({ result: other, index: ranked.length, named: name.named });
    added += 1;
  }
  return ranked
    .sort((left, right) => right.named - left.named || left.index - right.index)
    .map((entry) => entry.result);
}

/**
 * The chats a `@[description]` most likely means, best first. Two readings are fused: the
 * server's search by meaning and keyword over what was said in each chat (`matches`, best
 * first), and how many of the description's words the chat's title and its model carry,
 * which the server's search cannot see ("the Muse Wonder one"). Chats the description names
 * (half its words or more) come first, most words first; the rest follow by meaning. Nothing to go on yet lists the chats in use
 * and the latest ones. Subagent chats are left out, as the server's search leaves them out:
 * they repeat their lead's words and outnumber the chats a person works in.
 */
export function rankComposerChatMentions(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
  matches: ReadonlyArray<{ readonly threadId: ThreadId }>;
  workingThreadIds?: ReadonlySet<ThreadId>;
  limit?: number;
  /** How long ago a chat was last used, as the app writes it ("2h ago"). */
  age?: (updatedAt: string) => string | null | undefined;
}): ComposerThreadItem[] {
  const words = chatMentionWords(input.query);
  const semanticRank = new Map<ThreadId, number>();
  for (const match of input.matches) {
    if (!semanticRank.has(match.threadId)) semanticRank.set(match.threadId, semanticRank.size);
  }
  const working = (shell: ComposerThreadCandidate) =>
    Number(input.workingThreadIds?.has(shell.id) ?? false);
  const ranked = input.shells
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        shell.deletedAt == null &&
        shell.lineage?.relationshipToParent !== "subagent",
    )
    .map((shell) => {
      const { named, share } = chatNaming(words, {
        title: shell.title,
        model: shell.modelSelection?.model,
        providerInstanceId: shell.providerInstanceId,
      });
      const rank = semanticRank.get(shell.id) ?? UNRANKED;
      return {
        shell,
        named,
        rank,
        // The description names this chat: its title and model carry at least half the words.
        isNamed: share >= 0.5,
        score: share + (rank === UNRANKED ? 0 : 0.6 / (1 + 0.25 * rank)),
      };
    })
    .filter((entry) => words.length === 0 || entry.score > 0)
    .sort(
      (left, right) =>
        // Named chats first, the one more words point at ahead; the search's order only
        // settles ties there. It ranks what was said in a chat, which is much the same
        // across the chats of one topic, so it must not lift a chat missing a named word
        // ("muse wonder" asked for, Muse Ember listed first) over one that has them all.
        Number(right.isNamed) - Number(left.isNamed) ||
        (left.isNamed
          ? right.named - left.named || left.rank - right.rank
          : right.score - left.score) ||
        working(right.shell) - working(left.shell) ||
        right.shell.updatedAt.localeCompare(left.shell.updatedAt),
    );
  return ranked.slice(0, input.limit ?? CHAT_MENTION_RESULT_LIMIT).map(({ shell }) => {
    // Chats often share a title (the same task given to several models), so each row says
    // what it ran on and when: the two things a description picks between.
    const model = shell.modelSelection?.model
      .replace(/\([^)]*\)/g, "")
      .split("/")
      .pop()
      ?.trim();
    const description = [
      working(shell) ? "Working" : null,
      model || null,
      input.age?.(shell.updatedAt) || null,
    ]
      .filter((part) => part !== null)
      .join(" · ");
    return {
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: description || "Chat",
    };
  });
}

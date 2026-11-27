import type {
  NodeId,
  RunId,
  TeamBoardFile,
  TeamBoardPost,
  TeamBoardSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const POST_LIMIT = 300;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
const ARCHIVE_LIMIT = 50;
const ARCHIVE_BYTES = 2_000_000;
export const RECEIPT_BYTES = 1_200;
export const PINNED_BYTES = 560;
export const PRESENCE_MS = 10 * 60_000;
export const NOTICE_BATCH_MS = 2 * 60_000;
export const TEAM_BOARD_TOOL = "team_board";
export const TEAM_BOARD_DESCRIPTION =
  "Use with live siblings. Claim path or path#symbol before shared edits. New posts arrive by steer or with your next SSHCode tool result. Don't poll with read. Read for missing details. Writes include unread posts. Reuse handoffs. Done releases claims. Reply to replace a pin.";
export const TEAM_BOARD_CLAUSE =
  "Claim exact paths or path#symbols on team_board before shared edits. Ask the owner if held. Reuse matching handoffs before editing. Post only what changes a sibling's work. New posts arrive by steer or with your next SSHCode tool result. Don't poll with read. Read when a receipt lacks needed details. Writes include unread posts. Done releases claims.";
export const EMPTY_BOARD_READ = "Nothing new. New posts reach you automatically.";
export const NO_BOARD_SIBLINGS = "No sibling subagents right now.";
export const EMPTY_BOARD_STATE = "Board is empty.";

/** Keep complete titles and paths when the kickoff needs to summarize a large board. */
export function compactBoardState(label: string, rows: ReadonlyArray<string>, maxBytes: number) {
  if (rows.length === 0) return "";
  const prefix = `${label}: `;
  const selected: string[] = [];
  let bytes = Buffer.byteLength(prefix);
  for (const row of rows) {
    const next = Buffer.byteLength(row) + (selected.length === 0 ? 0 : 2);
    const extra = rows.length - selected.length - 1;
    if (bytes + next + (extra === 0 ? 1 : Buffer.byteLength(` (+${extra} more).`)) > maxBytes)
      break;
    selected.push(row);
    bytes += next;
  }
  const remaining = rows.length - selected.length;
  if (selected.length === 0) return `${label}: ${remaining} entries.`;
  return `${prefix}${selected.join(", ")}${remaining === 0 ? "" : ` (+${remaining} more)`}.`;
}

export interface BoardMember {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly taskId: NodeId;
  readonly runId?: RunId;
  readonly resumedFrom?: ReadonlyArray<RunId>;
  readonly cwd: string;
  readonly base?: string;
  readonly worktree: boolean;
}

export interface BoardTeam {
  readonly leadId: ThreadId;
  readonly repo: string;
  readonly repoName?: string;
  readonly members: ReadonlyArray<BoardMember>;
  readonly pendingMembers?: ReadonlyMap<NodeId, string>;
}

export interface BoardTarget {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface BoardActor {
  readonly leadId: ThreadId;
  readonly repo: string;
  readonly author: TeamBoardPost["author"];
  readonly runId?: RunId;
}

export interface Claim {
  readonly repo: string;
  readonly file: string;
  readonly post: string;
  readonly memberId: NodeId;
  readonly runId: RunId;
}

export interface StoredPost {
  readonly repo: string;
  readonly pushId?: string;
  readonly post: TeamBoardPost;
  readonly requestId?: string;
  readonly replaces?: string;
}

export interface OpenPush {
  readonly repo: string;
  readonly repoName?: string;
  readonly startedAt: number;
  readonly members: Readonly<Record<string, string>>;
  readonly namesByThread?: Readonly<Record<string, string>>;
  readonly implicitNotices?: Readonly<Record<string, number>>;
  readonly ended?: ReadonlyArray<EndedMember>;
  readonly liveEdits?: ReadonlyArray<{ readonly threadId: ThreadId; readonly edit: StoredEdit }>;
  readonly pairs?: ReadonlyArray<BoardPair>;
}

export interface EndedMember {
  readonly member: BoardMember;
  readonly claims: ReadonlyArray<string>;
  readonly edit?: StoredEdit;
}

export type StoredEdit = Omit<EditState, "committed"> & {
  readonly committed: ReadonlyArray<string>;
};

export interface ArchivedPush extends Omit<
  OpenPush,
  "ended" | "liveEdits" | "pairs" | "namesByThread" | "implicitNotices"
> {
  readonly id: string;
  readonly endedAt: number;
  readonly posts: ReadonlyArray<StoredPost>;
  readonly files: ReadonlyArray<TeamBoardFile>;
  readonly overlapCount: number;
}

export interface BoardStats {
  readonly claims: number;
  readonly conflicts: number;
  readonly postsWritten: number;
  readonly postsRead: number;
  readonly lateNotices: number;
}

export interface Ledger {
  readonly posts: ReadonlyArray<StoredPost>;
  readonly claims: ReadonlyArray<Claim>;
  readonly reads: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly stats: Readonly<Record<string, BoardStats>>;
  readonly open?: Readonly<Record<string, OpenPush>>;
  readonly history?: ReadonlyArray<ArchivedPush>;
  readonly closed?: { readonly at: number; readonly files: ReadonlyArray<TeamBoardFile> };
}

export const emptyLedger: Ledger = { posts: [], claims: [], reads: {}, stats: {} };
export const emptyStats: BoardStats = {
  claims: 0,
  conflicts: 0,
  postsWritten: 0,
  postsRead: 0,
  lateNotices: 0,
};

export type LedgerEntry =
  | { readonly type: "snapshot"; readonly snapshot: Ledger }
  | { readonly type: "post"; readonly stored: StoredPost; readonly claims: ReadonlyArray<Claim> }
  | { readonly type: "claims"; readonly claims: ReadonlyArray<Claim> }
  | { readonly type: "read"; readonly reader: string; readonly read: ReadonlyArray<string> }
  | { readonly type: "closed"; readonly closed: NonNullable<Ledger["closed"]> }
  | { readonly type: "open"; readonly id: string; readonly push: OpenPush }
  | { readonly type: "archive"; readonly push: ArchivedPush }
  | { readonly type: "stats"; readonly cohort: string; readonly stats?: BoardStats };

export function foldLedger(current: Ledger, entry: LedgerEntry): Ledger {
  if (entry.type === "snapshot") return entry.snapshot;
  if (entry.type === "post") {
    const posts = current.posts.map((stored) =>
      stored.post.id === entry.stored.replaces
        ? { ...stored, post: { ...stored.post, pinned: false } }
        : stored,
    );
    posts.push(entry.stored);
    const inPush = ({ pushId }: StoredPost) => pushId === entry.stored.pushId;
    if (posts.filter(inPush).length > POST_LIMIT) {
      const evict = posts.findIndex((row) => inPush(row) && !row.post.pinned);
      posts.splice(evict < 0 ? posts.findIndex(inPush) : evict, 1);
    }
    return { ...current, posts, claims: entry.claims };
  }
  if (entry.type === "claims") return { ...current, claims: entry.claims };
  if (entry.type === "read") {
    return { ...current, reads: { ...current.reads, [entry.reader]: entry.read } };
  }
  if (entry.type === "closed") return { ...current, closed: entry.closed };
  if (entry.type === "open")
    return { ...current, open: { ...current.open, [entry.id]: entry.push } };
  if (entry.type === "archive") {
    const open = { ...current.open };
    delete open[entry.push.id];
    return {
      ...current,
      open,
      history: [...(current.history ?? []), entry.push],
      posts: current.posts.filter(({ pushId }) => pushId !== entry.push.id),
    };
  }
  const stats = { ...current.stats };
  if (entry.stats === undefined) delete stats[entry.cohort];
  else stats[entry.cohort] = entry.stats;
  return { ...current, stats };
}

const archiveSizes = new WeakMap<ArchivedPush, number>();
function pruneHistory(ledger: Ledger, now: number, legacy: boolean): ReadonlyArray<ArchivedPush> {
  const history = ledger.history ?? [];
  const retained: ArchivedPush[] = [];
  let bytes = legacy
    ? jsonBytes([ledger.closed, ledger.posts.filter(({ pushId }) => pushId === undefined)])
    : 0;
  for (
    let i = history.length - 1;
    i >= 0 && retained.length < ARCHIVE_LIMIT - Number(legacy);
    i--
  ) {
    const push = history[i]!;
    if (push.endedAt <= now - RETENTION_MS) continue;
    const size = archiveSizes.get(push) ?? jsonBytes(push) + 1;
    archiveSizes.set(push, size);
    bytes += size;
    if (bytes > ARCHIVE_BYTES) break;
    retained.push(push);
  }
  return retained.reverse();
}

export function pruneLedger(ledger: Ledger, now: number): Ledger {
  const posts = ledger.posts.filter(
    ({ post }) => DateTime.toEpochMillis(post.at) > now - RETENTION_MS,
  );
  const ids = new Set(posts.map(({ post }) => post.id));
  const { closed, history, ...rest } = ledger;
  const retainLegacy = closed !== undefined && closed.at > now - RETENTION_MS;
  return {
    ...rest,
    ...(retainLegacy ? { closed } : {}),
    ...(history === undefined ? {} : { history: pruneHistory(ledger, now, retainLegacy) }),
    posts,
    reads: Object.fromEntries(
      Object.entries(ledger.reads)
        .slice(-256)
        .flatMap(([reader, idsRead]) => {
          const retained = idsRead.filter((id) => ids.has(id.split("/", 1)[0]!));
          return retained.length === 0 ? [] : [[reader, retained]];
        }),
    ),
  };
}

export function pathOf(file: string): string {
  const separator = file.indexOf("#");
  return separator === -1 ? file : file.slice(0, separator);
}

export function pathsOverlap(left: string, right: string): boolean {
  const path = pathOf(left);
  return path === pathOf(right) && (left === right || left === path || right === path);
}

export function normalizePaths(files: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
  const result = new Set<string>();
  for (const file of files) {
    const path = pathOf(file.trim())
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/)+/, "");
    const suffix = file.trim().slice(pathOf(file.trim()).length);
    if (
      path === "" ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.split("/").some((part) => part === ".." || part === "." || part === "") ||
      suffix === "#" ||
      /\p{Cc}/u.test(file)
    )
      return undefined;
    result.add(`${path}${suffix}`);
  }
  const normalized = [...result];
  return jsonBytes(normalized) <= 420 ? normalized : undefined;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const jsonBytes = (value: unknown) => Buffer.byteLength(encodeJson(value));

export function similarFinding(left: string, right: string): boolean {
  const tokenize = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const a = tokenize(left);
  const b = tokenize(right);
  const common = [...a].filter((word) => b.has(word)).length;
  return common > 0 && common * 2 >= a.size + b.size - common;
}

export interface BoardToolPost {
  readonly id: string;
  readonly by: string;
  readonly kind: string;
  readonly repo?: string;
  readonly text: string;
  readonly files?: ReadonlyArray<string>;
  readonly to?: string;
  readonly replyTo?: string;
  readonly commit?: string;
  readonly pinned?: boolean;
  readonly part?: number;
}

export interface BoardConflict {
  readonly file: string;
  readonly owner: string;
  readonly claim: string;
}

export interface BoardHandoff {
  readonly by: string;
  readonly commit: string;
  readonly files?: ReadonlyArray<string>;
}

export interface BoardReceipt {
  readonly conflicts?: ReadonlyArray<BoardConflict>;
  readonly claimed?: ReadonlyArray<string>;
  readonly notGranted?: ReadonlyArray<string>;
  readonly handoffs?: ReadonlyArray<BoardHandoff>;
  readonly posts: ReadonlyArray<BoardToolPost>;
  readonly more?: number;
  readonly notice?: string;
}

export function toolPost(post: TeamBoardPost): BoardToolPost {
  return {
    id: post.id,
    by: post.author.name,
    kind: post.kind,
    text: post.text,
    ...(post.files === undefined ? {} : { files: post.files }),
    ...(post.to === undefined ? {} : { to: post.to }),
    ...(post.replyTo === undefined ? {} : { replyTo: post.replyTo }),
    ...(post.commit === undefined ? {} : { commit: post.commit }),
    ...(post.pinned ? { pinned: true } : {}),
  };
}

const fragmentPost = (post: BoardToolPost): ReadonlyArray<BoardToolPost> => {
  const { files, text, ...metadata } = post;
  const fragments: BoardToolPost[] = [{ ...metadata, text: "", part: 1 }];
  const next = (body: Pick<BoardToolPost, "text" | "files">): BoardToolPost => ({
    id: post.id,
    by: "",
    kind: post.kind,
    part: fragments.length + 1,
    ...body,
  });
  if (files !== undefined) fragments.push(next({ text: "", files }));
  let pending = "";
  for (const character of text) {
    if (jsonBytes(next({ text: pending + character })) > 500) {
      fragments.push(next({ text: pending }));
      pending = "";
    }
    pending += character;
  }
  if (pending !== "") fragments.push(next({ text: pending }));
  return fragments;
};

/** Reserve space for the unread count before adding rows. Only emitted IDs advance reads. */
export function readPosts(input: {
  readonly posts: ReadonlyArray<TeamBoardPost>;
  readonly actor: BoardActor;
  readonly read: ReadonlySet<string>;
  readonly files: ReadonlyArray<string>;
  readonly claimFiles?: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<BoardConflict>;
  readonly claimed?: ReadonlyArray<string>;
  readonly notice?: string;
  readonly repos?: ReadonlyMap<string, string>;
}) {
  const { actor, posts } = input;
  const render = (post: TeamBoardPost): BoardToolPost => {
    const repo = input.repos?.get(post.id);
    return repo === undefined ? toolPost(post) : { ...toolPost(post), repo };
  };
  const own = (post: TeamBoardPost) =>
    post.author.taskId === actor.author.taskId && !post.author.user;
  const relevantHandoffs = new Map<string, BoardHandoff>();
  if (input.claimFiles?.length) {
    const claimFiles = input.claimFiles;
    const covered = new Set<string>();
    for (const post of posts.toReversed()) {
      if (post.commit === undefined || own(post)) continue;
      const files = claimFiles.filter(
        (file) => !covered.has(file) && post.files?.some((fixed) => pathsOverlap(file, fixed)),
      );
      if (files.length === 0) continue;
      relevantHandoffs.set(post.id, { by: post.author.name, commit: post.commit, files });
      for (const file of files) covered.add(file);
    }
  }
  const ownPostIds = new Set(posts.filter(own).map((post) => post.id));
  const selected: BoardToolPost[] = [];
  const reservedPins = new Set<string>();
  for (const post of posts) {
    if (!post.pinned) continue;
    const pin = render(post);
    if (input.repos !== undefined && jsonBytes([...selected, pin]) > PINNED_BYTES) continue;
    selected.push(pin);
    reservedPins.add(post.id);
  }
  const unread = posts.filter(
    (post) => !reservedPins.has(post.id) && (post.pinned || !own(post)) && !input.read.has(post.id),
  );
  const priority = (post: TeamBoardPost) => {
    if (post.pinned) return -1;
    if (relevantHandoffs.has(post.id)) return -1;
    if (
      (post.conflict?.owner.taskId !== undefined &&
        post.conflict.owner.taskId === actor.author.taskId) ||
      (post.kind === "claim" &&
        post.files?.some((file) => input.files.some((ours) => pathsOverlap(file, ours))))
    )
      return 0;
    if (
      post.to?.toLowerCase() === actor.author.name.toLowerCase() ||
      (post.replyTo !== undefined && ownPostIds.has(post.replyTo))
    )
      return 1;
    return post.author.taskId === undefined ? 2 : 3;
  };
  unread.sort((a, b) => priority(a) - priority(b));
  const conflicts: BoardConflict[] = [];
  const handoffs: BoardHandoff[] = [];
  let notGranted: ReadonlyArray<string> | undefined;
  const delivered: string[] = [];
  let completed = 0;
  let notice = input.notice;
  const receipt = (): BoardReceipt => ({
    ...(conflicts.length === 0 ? {} : { conflicts }),
    ...(input.claimed === undefined ? {} : { claimed: input.claimed }),
    ...(notGranted === undefined ? {} : { notGranted }),
    ...(handoffs.length === 0 ? {} : { handoffs }),
    posts: selected,
    ...(completed === unread.length ? {} : { more: unread.length - completed }),
    ...(notice === undefined ? {} : { notice }),
  });
  if (notice !== undefined && jsonBytes(receipt()) > RECEIPT_BYTES)
    notice = Array.from(notice).slice(0, 80).join("");
  if (jsonBytes(receipt()) > RECEIPT_BYTES) notice = undefined;
  for (const conflict of input.conflicts) {
    conflicts.push(conflict);
    if (jsonBytes(receipt()) > RECEIPT_BYTES) {
      if (conflicts.length > 1) {
        conflicts.pop();
        break;
      }
      // A denied claim must always carry its owner and claim ID.
      notice = undefined;
      while (jsonBytes(receipt()) > RECEIPT_BYTES && selected.length > 0) selected.pop();
    }
  }
  if (input.claimed !== undefined && conflicts.length < input.conflicts.length) {
    notGranted = [...new Set(input.conflicts.map(({ file }) => file))];
    if (jsonBytes(receipt()) > RECEIPT_BYTES) notice = undefined;
    while (jsonBytes(receipt()) > RECEIPT_BYTES && selected.length > 0) selected.pop();
    while (jsonBytes(receipt()) > RECEIPT_BYTES && conflicts.length > 1) conflicts.pop();
  }
  // A sibling may claim a file after its owner finished and released it.
  // Keep the matching commit visible even when the full done post won't fit.
  for (const handoff of relevantHandoffs.values()) {
    handoffs.push(handoff);
    if (jsonBytes(receipt()) <= RECEIPT_BYTES) continue;
    handoffs[handoffs.length - 1] = { by: handoff.by, commit: handoff.commit };
    if (jsonBytes(receipt()) <= RECEIPT_BYTES) continue;
    if (handoffs.length === 1)
      while (jsonBytes(receipt()) > RECEIPT_BYTES && selected.length > 0) selected.pop();
    if (jsonBytes(receipt()) > RECEIPT_BYTES) handoffs.pop();
    break;
  }
  for (const post of unread) {
    const full = render(post);
    if (!input.read.has(`${post.id}/1`)) {
      selected.push(full);
      if (jsonBytes(receipt()) <= RECEIPT_BYTES) {
        delivered.push(post.id);
        completed++;
        continue;
      }
      selected.pop();
      // Let the next read try the complete post first unless it exceeds even
      // an otherwise empty receipt.
      if (delivered.length > 0 || conflicts.length > 0 || notice !== undefined) break;
    }
    const parts = fragmentPost(full);
    for (const [index, part] of parts.entries()) {
      const cursor = `${post.id}/${index + 1}`;
      if (input.read.has(cursor)) continue;
      selected.push(part);
      if (jsonBytes(receipt()) > RECEIPT_BYTES) {
        selected.pop();
        return { result: receipt(), delivered, completed };
      }
      delivered.push(index === parts.length - 1 ? post.id : cursor);
    }
    completed++;
  }
  return { result: receipt(), delivered, completed };
}

export interface EditedFile {
  readonly path: string;
  readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  readonly newFile?: true;
}

export interface EditState {
  readonly head: string;
  readonly committed: ReadonlySet<string>;
  readonly files: ReadonlyArray<EditedFile>;
  readonly signature: string;
  readonly changedAt: number;
  readonly stale?: boolean;
}

/** Git emits old-side hunks in line order. Whole-file changes have no known hunks. */
export function overlapEdits(a: EditedFile, b: EditedFile): boolean {
  if (a.path !== b.path) return false;
  if (a.newFile && b.newFile) return true;
  let i = 0;
  let j = 0;
  while (i < a.ranges.length && j < b.ranges.length) {
    const left = a.ranges[i]!;
    const right = b.ranges[j]!;
    if (left.end < right.start) i++;
    else if (right.end < left.start) j++;
    else return true;
  }
  return false;
}

export interface BoardPair {
  readonly a: NodeId;
  readonly b: NodeId;
  readonly path: string;
  readonly severity: number;
  readonly confirmed?: boolean;
}

export function boardSnapshot(
  input: {
    readonly ledger: Ledger;
    readonly members: ReadonlyArray<BoardMember>;
    readonly edits: ReadonlyMap<ThreadId, EditState>;
    readonly pairs: ReadonlyArray<BoardPair>;
    readonly active: boolean;
    readonly presenceMembers?: ReadonlySet<NodeId>;
    readonly presenceCutoff?: number;
  },
  details: boolean,
): TeamBoardSnapshot {
  const { ledger, members, edits, pairs } = input;
  const fileMap = new Map<string, TeamBoardFile["agents"][number][]>();
  const presence = [...Map.groupBy(members, ({ threadId }) => threadId).values()].flatMap(
    (runs) => {
      const member =
        runs.findLast(({ taskId }) => input.presenceMembers?.has(taskId)) ?? runs.at(-1)!;
      const claims = ledger.claims.filter((claim) =>
        runs.some(({ taskId }) => claim.memberId === taskId),
      );
      const edit = edits.get(member.threadId);
      const changed = edit?.files ?? [];
      const paths = [
        ...new Set([...claims.map(({ file }) => pathOf(file)), ...changed.map(({ path }) => path)]),
      ];
      for (const path of paths) {
        const byAgent = fileMap.get(path) ?? [];
        const claimed = claims.filter(({ file }) => pathOf(file) === path).map(({ file }) => file);
        const ranges = changed.find((edit) => edit.path === path)?.ranges;
        byAgent.push({
          author: { name: member.name, taskId: member.taskId },
          ...(claimed.length === 0 ? {} : { claims: claimed }),
          ...(ranges === undefined ? {} : { ranges }),
          ...(ranges === undefined || !edit?.stale ? {} : { stale: true }),
        });
        fileMap.set(path, byAgent);
      }
      if (input.presenceMembers?.has(member.taskId) === false) return [];
      const freshPaths = new Set(
        claims.flatMap(({ file, memberId }) => (memberId === member.taskId ? [pathOf(file)] : [])),
      );
      if (edit !== undefined && !edit.stale && edit.changedAt > (input.presenceCutoff ?? -1))
        for (const { path } of changed) freshPaths.add(path);
      return freshPaths.size === 0 ? [] : [{ taskId: member.taskId, files: [...freshPaths] }];
    },
  );
  const files = [...fileMap].flatMap(([path, agents]): TeamBoardFile[] => {
    if (agents.length < 2) return [];
    const comparisons = pairs.filter((pair) => pair.path === path && pair.confirmed !== undefined);
    return [
      {
        path,
        agents,
        ...(comparisons.length === 0
          ? {}
          : { willConflict: comparisons.some((pair) => pair.confirmed) }),
      },
    ];
  });
  const latestPost = ledger.posts.at(-1)?.post;
  return {
    active: input.active,
    postCount: ledger.posts.length,
    overlapCount: new Set([
      ...(input.active
        ? []
        : (ledger.closed?.files.filter((file) => file.willConflict).map((file) => file.path) ??
          [])),
      ...pairs
        .filter((pair) => pair.severity > 0 && pair.confirmed !== false)
        .map((pair) => pair.path),
      ...ledger.posts.flatMap(({ post }) =>
        post.conflict === undefined ? [] : [pathOf(post.conflict.file)],
      ),
    ]).size,
    ...(latestPost === undefined ? {} : { latestPostId: latestPost.id }),
    presence,
    ...(details
      ? {
          posts: ledger.posts.toReversed().map(({ post }) => post),
          files: input.active ? files : (ledger.closed?.files ?? files),
        }
      : {}),
  };
}

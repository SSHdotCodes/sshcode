import {
  connectionWorkLabel,
  connectionWorkStatus,
  type EnvironmentConnectionPhase,
} from "../connection/presentation.ts";
import {
  siblingWordShare,
  needsYouReason,
  needsYouScore,
  SESSION_BOX_ACTIVITY_INFO,
  SESSION_BOX_TOPIC_INFO,
  sessionBoxActivity,
  sessionBoxDefaultFace,
  sessionBoxFaceOf,
  sessionBoxFaces,
  sessionBoxHue,
  sessionBoxName,
  type NeedsYouReason,
  type SessionBoxActivity,
  type SessionBoxIconId,
  type SessionBoxTopic,
} from "@t3tools/shared/sessionBoxes";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * How a chat appears as a session box: a stable painted face (its topic) and color, a
 * short name, and, on top, what it is doing or what it needs from the user. Web and
 * mobile render boxes from this, so both read the same at a glance.
 */
export type SessionBoxTone = "asking" | "working" | "failed" | "unread" | "quiet";

export interface SessionBoxPresentation {
  readonly connectionStatus?: "connecting" | "reconnecting" | "offline";
  /** The title, or its strongest words when it doesn't fit; the topic's name for placeholders. */
  readonly label: string;
  /** The opening of the user's latest request, when the chat has moved on from its title. */
  readonly now: string | null;
  readonly topic: SessionBoxTopic;
  readonly hue: number;
  /** The painted face: one of its topic's paintings, kept while the chat works. */
  readonly face: SessionBoxIconId;
  /** A painted badge over the face for what is happening now, if anything. */
  readonly badge: SessionBoxIconId | null;
  readonly activity: SessionBoxActivity | null;
  /** "Running tests", "Your call", "2h ago"… */
  readonly status: string;
  /** The status in a word or two, for small boxes: "Testing", "Your call", "2h ago". */
  readonly statusShort: string;
  readonly reason: NeedsYouReason | null;
  readonly tone: SessionBoxTone;
  /** When the current activity started, for an elapsed timer. */
  readonly since: string | null;
  /** Higher needs the user more. */
  readonly score: number;
  readonly mascot: "idle" | "working" | "waiting" | "done" | "failed";
}

/** Hide stale progress and timers on cached active work while disconnected. */
export function sessionBoxConnectionPresentation(
  box: SessionBoxPresentation,
  phase: EnvironmentConnectionPhase | undefined,
): SessionBoxPresentation {
  const status = connectionWorkStatus(phase);
  if (
    status === null ||
    box.tone === "asking" ||
    (box.tone !== "working" && box.activity !== "waiting")
  )
    return box;
  const label = connectionWorkLabel(status);
  return {
    ...box,
    connectionStatus: status,
    status: label,
    statusShort: label,
    tone: "quiet",
    activity: null,
    since: null,
    badge: null,
    mascot: "idle",
  };
}

export interface SessionBoxContext {
  readonly now: number;
  /**
   * `siblingWordShare` of the titles shown beside this one: words most boxes share
   * ("acme ·") drop out of the label.
   */
  readonly siblingShare?: ReadonlyMap<string, number>;
  /** Finished since the user last looked. */
  readonly unseen: boolean;
  readonly hasUnsentDraft?: boolean;
  /** Small boxes: names cut to about two short lines (28 characters, not 36). */
  readonly compact?: boolean;
  /**
   * The chat's painting from `sessionBoxFacesFor` over the chats shown with it, so chats
   * on the same topic differ; without it the chat's id picks one.
   */
  readonly face?: SessionBoxIconId | undefined;
}

type CachedName = {
  readonly siblingShare: SessionBoxContext["siblingShare"];
  readonly name: ReturnType<typeof sessionBoxName>;
};

const names = {
  compact: new WeakMap<EnvironmentThreadShell, CachedName>(),
  full: new WeakMap<EnvironmentThreadShell, CachedName>(),
};

function nameFor(thread: EnvironmentThreadShell, context: SessionBoxContext) {
  const cache = context.compact ? names.compact : names.full;
  const cached = cache.get(thread);
  if (cached && cached.siblingShare === context.siblingShare) return cached.name;
  const name = sessionBoxName(thread.title, {
    ...(context.siblingShare ? { siblingShare: context.siblingShare } : {}),
    ...(context.compact ? { maxChars: 28 } : {}),
  });
  // Clock ticks change age/attention, but do not change the title's model features.
  cache.set(thread, { siblingShare: context.siblingShare, name });
  return name;
}

const REASON_TEXT: Record<NeedsYouReason, string> = {
  approval: "Approve?",
  question: "Question",
  secret: "Needs a key",
  decision: "Your call",
  blocked: "Blocked",
  plan: "Plan ready",
  failed: "Failed",
  results: "Results",
};

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function relativeAge(time: number | null, now: number): string {
  if (time === null) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

// What a working chat is doing, in words anyone reads at a glance. The command line, file
// name or tool name of the step is left out on purpose: a list is no place for
// `python3 -I - <<'EOF'`, and the chat itself shows the step in full.
const STEP_PHRASE: Record<SessionBoxActivity, string> = {
  thinking: "Thinking",
  replying: "Writing a reply",
  reading: "Reading files",
  searching: "Searching the files",
  editing: "Editing files",
  testing: "Running tests",
  building: "Building",
  running: "Running a command",
  installing: "Installing packages",
  git: "Working with Git",
  browsing: "Browsing the web",
  remote: "Working on another machine",
  gpu: "Using the GPU",
  delegating: "Working with a subagent",
  waiting: "Waiting",
};

/** What the box says about the current step, e.g. "Running tests". */
export function sessionBoxStepText(
  activity: SessionBoxActivity,
  step: { readonly itemType: string } | null,
): string {
  switch (step?.itemType) {
    case "web_search":
      return "Searching the web";
    case "compaction":
      return "Compacting the chat";
    case "dynamic_tool":
    case "mcp_tool_call":
      // A tool that fits no kind of work is not "a command".
      return activity === "running" ? "Using a tool" : STEP_PHRASE[activity];
    default:
      return STEP_PHRASE[activity];
  }
}

export function presentSessionBox(
  thread: EnvironmentThreadShell,
  context: SessionBoxContext,
): SessionBoxPresentation {
  const name = nameFor(thread, context);
  const topic = name.topic;
  // The server's local model names boxes when it is installed; otherwise the title decides.
  const label =
    thread.source.boxName ?? (name.meaningful ? name.label : SESSION_BOX_TOPIC_INFO[topic].name);
  const runtimeStatus = thread.runtime?.status ?? null;
  const pendingRequest =
    thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval"
      ? ("approval" as const)
      : thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input"
        ? ("user_input" as const)
        : null;
  const working = runtimeStatus !== null && ACTIVE_STATUSES.has(runtimeStatus);
  const backgroundWaiting = runtimeStatus === "idle";
  const failed = runtimeStatus === "failed" && thread.runtime?.lastErrorClass !== "usage_limit";
  const limited = runtimeStatus === "failed" && thread.runtime?.lastErrorClass === "usage_limit";
  const attention = working ? null : (thread.source.replyAttention ?? null);
  const completedAt = epoch(thread.latestRun?.completedAt);
  const needsYouInput = {
    pendingRequest,
    attention,
    working,
    failed,
    limited,
    unseen: context.unseen,
    hasActionablePlan: thread.hasActionableProposedPlan,
    hasUnsentDraft: context.hasUnsentDraft ?? false,
    pinned: thread.pinnedAt !== null,
    completedAt,
    lastUserMessageAt: epoch(thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt),
    createdAt: epoch(thread.createdAt) ?? context.now,
    now: context.now,
  };
  const reason = needsYouReason(needsYouInput);
  const step = thread.source.currentStep ?? null;
  const activity: SessionBoxActivity | null = working
    ? step
      ? sessionBoxActivity({ itemType: step.itemType, detail: step.detail })
      : "thinking"
    : backgroundWaiting
      ? "waiting"
      : null;
  const picked = thread.source.boxFace ?? null;
  const face =
    context.face ??
    (picked !== null && sessionBoxFaceOf(picked) !== null
      ? (picked as SessionBoxIconId)
      : sessionBoxDefaultFace(thread.id, topic));
  const badge: SessionBoxIconId | null =
    pendingRequest !== null
      ? "state-asking"
      : activity !== null
        ? `activity-${activity}`
        : limited
          ? "state-limited"
          : failed
            ? "state-failed"
            : reason !== null
              ? "state-asking"
              : context.unseen
                ? "state-done"
                : null;
  const tone: SessionBoxTone =
    pendingRequest !== null || (reason !== null && reason !== "failed" && reason !== "results")
      ? "asking"
      : working
        ? "working"
        : failed || limited
          ? "failed"
          : context.unseen
            ? "unread"
            : "quiet";
  const asking = pendingRequest !== null || (reason !== null && !working);
  const age = relativeAge(completedAt ?? epoch(thread.updatedAt), context.now);
  // A chat that reports its own stages says more with the stage it is on ("Draw the phone
  // cards") than with its latest step ("Running a command").
  const stage = working
    ? (thread.source.liveProgress?.stages.find((item) => item.status === "active")?.title.trim() ??
      "")
    : "";
  const status = asking
    ? REASON_TEXT[reason ?? "question"]
    : activity !== null
      ? stage !== ""
        ? stage
        : sessionBoxStepText(activity, working ? step : null)
      : limited
        ? "Hit a usage limit"
        : age;
  const statusShort = asking
    ? REASON_TEXT[reason ?? "question"]
    : activity !== null
      ? SESSION_BOX_ACTIVITY_INFO[activity].verb
      : limited
        ? "Limit"
        : age;
  const since = working
    ? step?.startedAt
      ? DateTime.formatIso(step.startedAt)
      : (thread.runtime?.activityStartedAt ?? null)
    : null;
  return {
    label,
    now: thread.source.latestRequest ?? null,
    topic,
    hue: sessionBoxHue(thread.id),
    face,
    badge,
    activity,
    status,
    statusShort,
    reason,
    tone,
    since,
    score: needsYouScore(needsYouInput),
    mascot:
      pendingRequest !== null || tone === "asking"
        ? "waiting"
        : working
          ? "working"
          : failed
            ? "failed"
            : context.unseen
              ? "done"
              : "idle",
  };
}

/** Most-needed first; equal scores keep the most recently active first. */
export function compareSessionBoxes(
  left: { readonly box: SessionBoxPresentation; readonly updatedAt: string },
  right: { readonly box: SessionBoxPresentation; readonly updatedAt: string },
): number {
  const difference = right.box.score - left.box.score;
  if (Math.abs(difference) > 1e-9) return difference;
  return (epoch(right.updatedAt) ?? 0) - (epoch(left.updatedAt) ?? 0);
}

let lastShare: { readonly titles: string; readonly share: ReadonlyMap<string, number> } | null =
  null;

/** `siblingWordShare` for the titles on screen, reused while they don't change. */
export function sessionBoxSiblingShare(titles: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const key = titles.join("\n");
  if (lastShare?.titles !== key) lastShare = { titles: key, share: siblingWordShare(titles) };
  return lastShare.share;
}

let lastFaces: {
  readonly key: string;
  readonly faces: ReadonlyMap<string, SessionBoxIconId>;
} | null = null;
const topicByTitle = new Map<string, SessionBoxTopic>();

function topicOf(title: string): SessionBoxTopic {
  let topic = topicByTitle.get(title);
  if (topic === undefined) {
    if (topicByTitle.size >= 4096) topicByTitle.clear();
    topic = sessionBoxName(title).topic;
    topicByTitle.set(title, topic);
  }
  return topic;
}

/**
 * Paintings for the chats on screen, keyed by thread id: chats on the same topic get
 * different ones (`sessionBoxFaces`). Reused while the chats and their titles don't change.
 */
export function sessionBoxFacesFor(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "title" | "createdAt" | "source">>,
): ReadonlyMap<string, SessionBoxIconId> {
  const key = threads
    .map((thread) => `${thread.id}\u0000${thread.title}\u0000${thread.source.boxFace ?? ""}`)
    .join("\n");
  if (lastFaces?.key !== key)
    lastFaces = {
      key,
      faces: sessionBoxFaces(
        threads.map((thread) => ({
          id: thread.id,
          topic: topicOf(thread.title),
          createdAt: thread.createdAt,
          preferred: thread.source.boxFace,
        })),
      ),
    };
  return lastFaces.faces;
}

// One cache per size: the sidebar's small boxes and the Board's big ones show at once.
const presented = {
  compact: new WeakMap<
    EnvironmentThreadShell,
    { readonly context: SessionBoxContext; readonly box: SessionBoxPresentation }
  >(),
  full: new WeakMap<
    EnvironmentThreadShell,
    { readonly context: SessionBoxContext; readonly box: SessionBoxPresentation }
  >(),
};

/**
 * `presentSessionBox`, returning the same object while the thread and its context are
 * unchanged, so memoized boxes skip re-rendering on unrelated shell updates.
 */
export function presentSessionBoxCached(
  thread: EnvironmentThreadShell,
  context: SessionBoxContext,
): SessionBoxPresentation {
  const cache = context.compact ? presented.compact : presented.full;
  const cached = cache.get(thread);
  if (
    cached &&
    cached.context.now === context.now &&
    cached.context.unseen === context.unseen &&
    cached.context.siblingShare === context.siblingShare &&
    cached.context.compact === context.compact &&
    cached.context.face === context.face &&
    cached.context.hasUnsentDraft === context.hasUnsentDraft
  ) {
    return cached.box;
  }
  const box = presentSessionBox(thread, context);
  cache.set(thread, { context, box });
  return box;
}

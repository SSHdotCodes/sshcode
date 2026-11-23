import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /**
   * Pictures the chat's icon can be, by id: when given, the same reply also picks the one
   * that fits the chat best (`icon`).
   */
  pictures?: ThreadTitlePictures | undefined;
  /**
   * The chat tabs there are, with a few of their chats' titles: when given, the same reply
   * also files the chat into one of them, a new one, or none (`tab`).
   */
  tabs?: ThreadTitleTabs | undefined;
}

/** Chat tabs offered with a title or a sort, each with some of its chats' titles. */
export type ThreadTitleTabs = ReadonlyArray<{
  readonly name: string;
  readonly chats: ReadonlyArray<string>;
}>;

/** Icon pictures offered with a title, grouped by what their topic covers. */
export type ThreadTitlePictures = ReadonlyArray<{
  readonly covers: string;
  readonly pictures: ReadonlyArray<{ readonly id: string; readonly picture: string }>;
}>;

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
  /** The id of the picture picked from `pictures`, when the reply named one of them. */
  icon?: string | undefined;
  /** Present when `tabs` were offered: the tab the chat belongs in, or "" for none. */
  tab?: string | undefined;
}

export interface ChatTabsGenerationInput {
  cwd: string;
  /** The tabs there are already; the reply reuses their names. */
  tabs: ThreadTitleTabs;
  /** Chats to sort, by an id the reply repeats. */
  chats: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ChatTabsGenerationResult {
  /** One tab per chat id; "" for a chat that belongs in none. */
  assignments: ReadonlyArray<{ readonly id: string; readonly tab: string }>;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  /** The layer's head in the checkout, null where it could not be fetched. */
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  /** A disposable checkout of the change's head. The model investigates it read-only. */
  cwd: string;
  number: number;
  title: string;
  /** The author's own description, which states intent the diff cannot. */
  description: string;
  baseBranch: string;
  /** The commit the change is measured from, present in `cwd`. */
  baseCommit: string;
  /**
   * What review already settled: resolved conversations, reduced to who raised what. The guide
   * leaves these alone rather than raising them again.
   */
  settledReview: string;
  /** The maintainer's preferences for guides (tone, emphasis, ordering). Empty for none. */
  instructions?: string | undefined;
  /**
   * The stack the change is a layer of, bottom first, when it is in one. Another layer's head is
   * fetched into `cwd` where the host served it, so the model can read across a seam.
   */
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/** A guide as the model wrote it, before the server holds it to the change. */
export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

/** Commit, change request, branch, and title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /** Prose-only display rewrites, using the same tool-free utility runner as titles. */
  readonly rewriteProse?: (input: {
    cwd: string;
    prompt: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ output: string }, TextGenerationError>;

  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate change request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /** Sort existing chats into tabs by their titles. */
  readonly generateChatTabs: (
    input: ChatTabsGenerationInput,
  ) => Effect.Effect<ChatTabsGenerationResult, TextGenerationError>;

  /** Explain a change request to the maintainer deciding whether it lands. */
  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}

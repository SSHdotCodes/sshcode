import type { PullRequestActivity, PullRequestDetail } from "@t3tools/contracts";
import type { ReviewGuideGenerationInput } from "@t3tools/provider-core/server/textGeneration";

/** Longest a settled remark is quoted. The guide needs what was raised, not the argument. */
const SETTLED_REMARK_CHARS = 200;

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function oneLine(text: string): string {
  const flat = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= SETTLED_REMARK_CHARS) return flat;
  const end = splitsSurrogatePair(flat, SETTLED_REMARK_CHARS)
    ? SETTLED_REMARK_CHARS - 1
    : SETTLED_REMARK_CHARS;
  return `${flat.slice(0, end)}…`;
}

/**
 * What review already settled, one line per conversation: resolved threads, and threads whose
 * line a later push removed. These are the review loop's finished work; the guide is told about
 * them so it does not raise them again.
 */
export function settledReviewSummary(activity: PullRequestActivity): string {
  return activity.reviewThreads
    .filter((thread) => thread.isResolved || thread.isOutdated)
    .flatMap((thread) => {
      const opener = thread.comments[0];
      if (opener === undefined) return [];
      const who = opener.author?.login ?? "ghost";
      const state = thread.isResolved ? "resolved" : "outdated";
      return [`- ${thread.path} (${state}, ${who}): ${oneLine(opener.body)}`];
    })
    .join("\n");
}

/** The prompt input for a guide, minus the checkout and model the caller provides. */
export function reviewGuideInputFromPullRequest(
  detail: PullRequestDetail,
  activity: PullRequestActivity,
  baseCommit: string,
): Omit<ReviewGuideGenerationInput, "cwd" | "modelSelection"> {
  return {
    number: detail.number,
    title: detail.title,
    description: detail.body,
    baseBranch: detail.baseBranch,
    baseCommit,
    settledReview: settledReviewSummary(activity),
  };
}

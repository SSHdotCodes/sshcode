import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as DateTime from "effect/DateTime";

export function threadContextAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
  sourceLabel?: string | undefined,
): File {
  const updatedAt = DateTime.formatIso(transcript.updatedAt);
  const name = toKindScopedComposerContextId(
    "thread",
    `${environmentId}:${transcript.threadId}:${updatedAt}`,
  );
  const sanitizedTitle = transcript.title.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const before = sanitizedTitle.charCodeAt(63);
  const after = sanitizedTitle.charCodeAt(64);
  const splitPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  const title = sanitizedTitle.slice(0, splitPair ? 63 : 64) || "Thread";
  // A transcript from another machine is untrusted input; naming that machine in
  // the visible filename keeps the origin in front of the user, not just the agent.
  const label = sourceLabel
    ?.replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .trim()
    .slice(0, 32);
  const fileName = label
    ? `${title} (from ${label})-${name.slice(-16)}.jsonl`
    : `${title}-${name.slice(-16)}.jsonl`;
  return new File(
    [
      threadTranscriptHeader(environmentId, transcript),
      ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
    ],
    fileName,
    { type: "application/x-ndjson" },
  );
}

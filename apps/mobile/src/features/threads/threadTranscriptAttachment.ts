import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";

import {
  createPastedTextComposerAttachment,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";

/**
 * A chat from another machine as a file for the message: the agent here can't read that
 * machine's chats itself. Same format as a chat dragged into the composer on the Mac.
 */
export async function threadTranscriptComposerAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
): Promise<DraftComposerFileAttachment> {
  const text = [
    threadTranscriptHeader(environmentId, transcript),
    ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
  ].join("");
  const title = transcript.title.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 64) || "Thread";
  const { source: _pasted, ...attachment } = await createPastedTextComposerAttachment({
    text,
    name: `${title}.jsonl`,
    maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  });
  return { ...attachment, mimeType: "application/x-ndjson" };
}

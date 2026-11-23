import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { plainContextText } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";

import { collectComposerModelMentions } from "../composerModelMentions.ts";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  // A chip reads as its label: a chat started from "[Some chat](t3-context://…)" seeds that name.
  let text = "";
  let cursor = 0;
  for (const mention of collectComposerModelMentions(value)) {
    text += value.slice(cursor, mention.start) + mention.model;
    cursor = mention.end;
  }
  return plainContextText(assistantCitationsToPlainText(text + value.slice(cursor)));
}

export function deriveThreadTitleSeed(input: ThreadTitleSeedInput): string {
  const text = normalizeTitleSeed(input.text);
  if (text.length > 0) {
    return truncate(text);
  }

  const attachmentName = normalizeTitleSeed(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) {
    return truncate(`Image: ${attachmentName}`);
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return "New thread";
}

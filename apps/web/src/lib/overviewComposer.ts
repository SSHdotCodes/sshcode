import type {
  OrchestrationMessageContext,
  ScopedThreadRef,
  ThreadContextRecord,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { replaceTextRange, type ComposerTrigger } from "../composer-logic";
import { inlineContextReferenceReplacement } from "./composerContextReferences";
import { threadContextRecord, threadContextReference } from "./composerContextRecords";

export function insertOverviewChatMention(
  text: string,
  trigger: ComposerTrigger,
  thread: ScopedThreadRef,
  title: string,
) {
  const record = threadContextRecord(thread, title);
  const replacement = inlineContextReferenceReplacement(
    text,
    { start: trigger.rangeStart, end: trigger.rangeEnd },
    [threadContextReference(record)],
  );
  return {
    ...replaceTextRange(text, replacement.start, replacement.end, replacement.text),
    record,
  };
}

/** Deleted chips leave no hidden context in the question sent to Overview. */
export function overviewMessageContext(
  text: string,
  threads: ReadonlyArray<ThreadContextRecord>,
): OrchestrationMessageContext | undefined {
  const ids = new Set(
    collectComposerContextReferences(text).map((reference) => reference.contextId),
  );
  const records = threads.filter((record) => ids.has(record.contextId));
  return records.length > 0 ? { version: 1, records } : undefined;
}

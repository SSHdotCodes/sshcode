import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatImageAttachment,
  type ChatFileAttachment,
} from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  createEmptyThreadDraft,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  previewAnnotationContextReference,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import {
  formatInlineContextReference,
  producerIdFromComposerContextId,
} from "../../lib/composerContextReferences";
import type { RecoveredQueuedEdit } from "./recoveredQueuedEdits";

/** Restore a saved edit into an empty composer while retaining the saved copy. */
export function restoreQueuedEdit(input: {
  entry: RecoveredQueuedEdit;
  destination: ComposerThreadTarget;
  files: ReadonlyArray<File>;
}): void {
  const { entry } = input;
  const originalRecords = entry.context?.records ?? [];
  const known = originalRecords.map(asKnownContextRecord);
  if (
    known.some(
      (record) =>
        !record ||
        ![
          "image",
          "file",
          "terminal",
          "review-comment",
          "preview-annotation",
          "thread",
          "element",
        ].includes(record.kind),
    )
  ) {
    throw new Error(
      "This edit contains context this version cannot restore. The saved edit is still available.",
    );
  }
  if (entry.existingAttachments.length !== input.files.length)
    throw new Error("Could not restore every attachment.");
  const state = useComposerDraftStore.getState();
  const source = state.getComposerDraft(entry.draftId) ?? createEmptyThreadDraft();
  const destination = state.getComposerDraft(input.destination) ?? createEmptyThreadDraft();
  if (composerDraftHasUserContent(destination))
    throw new Error("Clear or stash the current draft before restoring this edit.");
  if (
    source.images.length + source.files.length + input.files.length >
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  ) {
    throw new Error("This edit has too many attachments to restore.");
  }
  const originalImages = [];
  const originalFiles = [];
  const usedIds = new Set([...source.images, ...source.files].map((attachment) => attachment.id));
  const restoredAttachments = entry.existingAttachments.map((attachment, index) => {
    if (attachment.type !== "image" && attachment.type !== "file")
      throw new Error("This attachment type cannot be restored.");
    const file = input.files[index]!;
    const record = known.find(
      (candidate) =>
        candidate &&
        (candidate.kind === "image" || candidate.kind === "file") &&
        candidate.attachmentId === attachment.id,
    );
    const id = record
      ? producerIdFromComposerContextId(record.kind, record.contextId)
      : attachment.id;
    if (usedIds.has(id)) throw new Error("This edit has conflicting attachment references.");
    usedIds.add(id);
    return { attachment, file, id };
  });
  for (const { attachment, file, id } of restoredAttachments) {
    const common = {
      id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: file.size,
      file,
    };
    if (attachment.type === "image")
      originalImages.push({
        ...common,
        type: "image" as const,
        previewUrl: URL.createObjectURL(file),
        ...((attachment as ChatImageAttachment).source
          ? { source: (attachment as ChatImageAttachment).source }
          : {}),
      });
    else
      originalFiles.push({
        ...common,
        type: "file" as const,
        ...((attachment as ChatFileAttachment).source
          ? { source: (attachment as ChatFileAttachment).source }
          : {}),
      });
  }
  const records = known.filter(
    (record): record is NonNullable<typeof record> => record !== undefined,
  );
  const terminals = records
    .filter((record) => record.kind === "terminal")
    .map((record) => terminalContextDraftFromRecord(record, entry.threadId));
  const reviews = records
    .filter((record) => record.kind === "review-comment")
    .map(reviewCommentFromRecord);
  const elementReferences = new Map<string, ReturnType<typeof previewAnnotationContextReference>>();
  const previews = records.flatMap((record) => {
    if (record.kind === "preview-annotation") return [previewAnnotationFromRecord(record)];
    if (record.kind !== "element") return [];
    const annotation = elementContextToPreviewAnnotation(
      record,
      producerIdFromComposerContextId("element", record.contextId),
      new Date().toISOString(),
    );
    elementReferences.set(record.contextId, previewAnnotationContextReference(annotation));
    return [annotation];
  });
  const threads = records.filter((record) => record.kind === "thread");
  const merge = <T>(original: T[], edited: T[], key: (value: T) => string) => [
    ...new Map([...original, ...edited].map((value) => [key(value), value])).values(),
  ];
  const sourceImages = source.images.map((image) => ({
    ...image,
    previewUrl: URL.createObjectURL(image.file),
  }));
  const next = {
    ...destination,
    prompt: replaceComposerContextReferences(source.prompt, (reference) => {
      const replacement = elementReferences.get(reference.contextId);
      return replacement ? formatInlineContextReference(replacement) : reference.source;
    }),
    images: [...originalImages, ...sourceImages],
    files: [...originalFiles, ...source.files],
    persistedAttachments: [...source.persistedAttachments],
    nonPersistedImageIds: [
      ...source.nonPersistedImageIds,
      ...originalImages.map((image) => image.id),
    ],
    terminalContexts: merge(terminals, source.terminalContexts, (item) => item.id),
    reviewComments: merge(reviews, source.reviewComments, (item) => item.id),
    previewAnnotations: merge(previews, source.previewAnnotations, (item) => item.id),
    threadContexts: merge(threads, source.threadContexts, (item) => item.contextId),
  };
  useComposerDraftStore.setState((current) => {
    const targetKey = resolveComposerDraftKey(current, input.destination);
    if (!targetKey || composerDraftHasUserContent(current.draftsByThreadKey[targetKey]))
      throw new Error(
        "The current draft changed while restoring. Your saved edit is still available.",
      );
    return { draftsByThreadKey: { ...current.draftsByThreadKey, [targetKey]: next } };
  });
}

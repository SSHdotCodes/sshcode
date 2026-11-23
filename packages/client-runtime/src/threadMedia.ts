import {
  isSingleRowReplacement,
  visibleTurnItemsRevision,
} from "./state/orchestrationV2Projection.ts";
import type {
  AssetResource,
  ChatImageOriginal,
  ImageAttachmentDimensions,
  MessageId,
  OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { resolveMediaSource, type ResolvedMediaSource } from "./mediaSource.ts";
import { turnItemOutputImageMetadata } from "./work-log/itemDetail.ts";
import { resolveViewedImageAsset } from "./work-log/presentation.ts";

/** A media occurrence, not a unique file: the same image can appear more than once. */
export interface ThreadMediaItem {
  readonly id: string;
  readonly kind: "image" | "video";
  readonly name: string;
  readonly mimeType: string;
  readonly original?: ChatImageOriginal;
  readonly sentSize?: ImageAttachmentDimensions;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly messageId?: MessageId;
  readonly unavailable?: boolean;
  readonly target:
    | { readonly type: "asset"; readonly resource: AssetResource; readonly srcFragment?: string }
    | { readonly type: "url"; readonly url: string };
}

export function threadMediaOriginalResource(item: ThreadMediaItem) {
  if (!item.original || item.target.type !== "asset") return null;
  return {
    ...item.target.resource,
    fileName: item.original.name,
    mimeType: item.original.mimeType,
    original: true,
  };
}

const parser = unified().use(remarkParse);
type MarkdownRoot = ReturnType<typeof parser.parse>;
type MarkdownNode = MarkdownRoot | MarkdownRoot["children"][number];
const markdownCache = new WeakMap<
  object,
  { text: string; media: Array<{ href: string; imageEmbed: boolean }> }
>();

/** Collect rendered image syntax and explicit video links, excluding code examples. */
function markdownMedia(markdown: string): Array<{ href: string; imageEmbed: boolean }> {
  if (!/!\[|<|\]\s*[[(]/u.test(markdown)) return [];
  const root = parser.parse(markdown);
  const definitions = new Map<string, string>();
  const result: Array<{ href: string; imageEmbed: boolean }> = [];
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition") definitions.set(node.identifier.toLowerCase(), node.url);
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(root);
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") result.push({ href: node.url, imageEmbed: true });
    else if (node.type === "imageReference") {
      const href = definitions.get(node.identifier.toLowerCase());
      if (href !== undefined) result.push({ href, imageEmbed: true });
    } else if (node.type === "link") result.push({ href: node.url, imageEmbed: false });
    else if (node.type === "html") {
      for (const tag of node.value.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
        const attributes = tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g);
        const src = [...attributes].find((attribute) => attribute[1]?.toLowerCase() === "src");
        const href = (src?.[2] ?? src?.[3] ?? src?.[4])?.replace(/&amp;/gi, "&");
        if (href) result.push({ href, imageEmbed: true });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return result;
}

function cachedMarkdownMedia(owner: object, text: string) {
  const cached = markdownCache.get(owner);
  if (cached?.text === text) return cached.media;
  const media = markdownMedia(text);
  markdownCache.set(owner, { text, media });
  return media;
}

function targetForMedia(media: ResolvedMediaSource): ThreadMediaItem["target"] | null {
  if (media.access === "direct") return { type: "url", url: media.uri };
  if (media.access === "environment") {
    return { type: "asset", resource: media.resource, srcFragment: media.srcFragment };
  }
  return null;
}

export function threadMediaOccurrenceId(
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  type: string,
  key: string | number,
): string {
  return JSON.stringify([JSON.stringify([sourceThreadId, sourceItemId]), type, key]);
}

/** Extract one occurrence group without fetching assets or withheld details. */
function buildRowMedia(
  row: MediaProjection["visibleTurnItems"][number],
  message: MediaProjection["messages"][number] | undefined,
  options: MediaOptions,
): ThreadMediaItem[] {
  const result: ThreadMediaItem[] = [];
  const item = row.item;
  const source = { sourceThreadId: row.sourceThreadId, sourceItemId: row.sourceItemId };
  const occurrence = (type: string, key: string | number) =>
    threadMediaOccurrenceId(row.sourceThreadId, row.sourceItemId, type, key);
  if (item.type === "user_message" || item.type === "assistant_message") {
    const attachments = message?.attachments ?? item.attachments ?? [];
    const seenAttachments = new Set<string>();
    const attachmentItems: ThreadMediaItem[] = [];
    for (const attachment of attachments) {
      const mimeType = imageMimeType(attachment) ?? videoMimeType(attachment);
      if (!mimeType || seenAttachments.has(attachment.id)) continue;
      seenAttachments.add(attachment.id);
      attachmentItems.push({
        ...source,
        id: occurrence("attachment", attachment.id),
        messageId: item.messageId,
        kind: mimeType.startsWith("video/") ? "video" : "image",
        name: attachment.name,
        mimeType,
        ...(attachment.type === "image" && "original" in attachment && attachment.original
          ? {
              original: attachment.original,
              ...("sentSize" in attachment && attachment.sentSize
                ? { sentSize: attachment.sentSize }
                : {}),
            }
          : {}),
        target: {
          type: "asset",
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
    }
    if (item.type !== "assistant_message") {
      result.push(...attachmentItems);
      return result;
    }
    const text = message?.text ?? item.text;
    let index = 0;
    for (const { href, imageEmbed } of cachedMarkdownMedia(message ?? item, text)) {
      const media = resolveMediaSource(href, {
        threadId: item.threadId,
        workspaceRoot: options.workspaceRoot,
        imageEmbed,
      });
      if (!media || (!imageEmbed && media.kind !== "video")) continue;
      const target = targetForMedia(media);
      if (!target) continue;
      result.push({
        ...source,
        id: occurrence("markdown", index++),
        messageId: item.messageId,
        kind: media.kind,
        name: media.name,
        mimeType: media.mimeType,
        target,
      });
    }
    result.push(...attachmentItems);
  } else if (item.type === "dynamic_tool") {
    if (item.viewedImagePath) {
      const viewed = resolveViewedImageAsset(item.viewedImagePath, {
        threadId: item.threadId,
        workspaceRoot: options.workspaceRoot,
      });
      if (viewed)
        result.push({
          ...source,
          id: occurrence("viewed", 0),
          kind: "image",
          name: viewed.alt,
          mimeType: imageMimeType({ name: viewed.alt, mimeType: "" }) ?? "image/*",
          target: { type: "asset", resource: viewed.resource, srcFragment: viewed.srcFragment },
        });
    }
    for (const { resource, mimeType, unavailable } of turnItemOutputImageMetadata(item)) {
      result.push({
        ...source,
        id: occurrence("output", resource.index),
        kind: "image",
        name: item.title || `Tool image ${resource.index + 1}`,
        mimeType,
        ...(unavailable ? { unavailable: true } : {}),
        target: { type: "asset", resource },
      });
    }
  }
  return result;
}

type MediaProjection = Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "messages">;
type MediaOptions = { readonly workspaceRoot?: string | null | undefined };
const messageMaps = new WeakMap<
  MediaProjection["messages"],
  Map<MessageId, MediaProjection["messages"][number]>
>();
const rowMediaCache = new WeakMap<
  MediaProjection["visibleTurnItems"][number],
  {
    message: MediaProjection["messages"][number] | undefined;
    workspaceRoot: string | null | undefined;
    items: ThreadMediaItem[];
  }
>();

function messagesForMedia(projection: MediaProjection) {
  let messages = messageMaps.get(projection.messages);
  if (!messages) {
    messages = new Map(projection.messages.map((message) => [message.id, message]));
    messageMaps.set(projection.messages, messages);
  }
  return messages;
}

function rowMedia(
  row: MediaProjection["visibleTurnItems"][number],
  messages: ReturnType<typeof messagesForMedia>,
  options: MediaOptions,
) {
  const item = row.item;
  const message =
    item.type === "user_message" || item.type === "assistant_message"
      ? messages.get(item.messageId)
      : undefined;
  const cached = rowMediaCache.get(row);
  if (cached && cached.message === message && cached.workspaceRoot === options.workspaceRoot)
    return cached.items;
  const items = buildRowMedia(row, message, options);
  rowMediaCache.set(row, { message, workspaceRoot: options.workspaceRoot, items });
  return items;
}

/** Visit each occurrence once, retaining the canonical first-row and first-message precedence. */
function visitMedia(
  projection: MediaProjection,
  options: MediaOptions,
  visit: (items: ThreadMediaItem[], index: number) => boolean,
) {
  const messages = messagesForMedia(projection);
  const seenRows = new Map<ThreadId, Set<TurnItemId>>();
  const seenMessages = new Set<MessageId>();
  for (const [index, row] of projection.visibleTurnItems.entries()) {
    let seen = seenRows.get(row.sourceThreadId);
    if (!seen) seenRows.set(row.sourceThreadId, (seen = new Set()));
    if (seen.has(row.sourceItemId)) continue;
    seen.add(row.sourceItemId);
    const item = row.item;
    if (item.type === "user_message" || item.type === "assistant_message") {
      if (seenMessages.has(item.messageId)) continue;
      seenMessages.add(item.messageId);
    }
    if (visit(rowMedia(row, messages, options), index)) return true;
  }
  return false;
}

function mediaRowIdentity(row: MediaProjection["visibleTurnItems"][number]) {
  return {
    threadId: row.sourceThreadId,
    itemId: row.sourceItemId,
    type: row.item.type,
    messageId: "messageId" in row.item ? row.item.messageId : undefined,
  };
}

interface MediaPresenceSummary {
  readonly version: ReturnType<typeof visibleTurnItemsRevision>;
  readonly identities: ReadonlyMap<number, ReturnType<typeof mediaRowIdentity>>;
  readonly messages: MediaProjection["messages"];
  readonly workspaceRoot: MediaOptions["workspaceRoot"];
  readonly firstMediaIndex: number;
  readonly complete: boolean;
  readonly eligible: ReadonlySet<number>;
}
const presenceSummaries = new WeakMap<object, MediaPresenceSummary>();

/** A chunk updates one presence bit; gallery occurrences are assembled only on demand. */
export function threadHasMedia(projection: MediaProjection, options: MediaOptions = {}): boolean {
  const version = visibleTurnItemsRevision(projection.visibleTurnItems);
  const cached = presenceSummaries.get(version.revision);
  if (cached?.messages === projection.messages && cached.workspaceRoot === options.workspaceRoot)
    return cached.firstMediaIndex >= 0;
  const previous =
    (version.previousRevision && presenceSummaries.get(version.previousRevision)) ||
    presenceSummaries.get(version.originRevision);
  let firstMediaIndex = -1;
  let eligible: ReadonlySet<number> | undefined;
  let identities = previous?.identities;
  let complete = previous?.complete ?? false;
  if (
    previous &&
    previous.messages === projection.messages &&
    previous.workspaceRoot === options.workspaceRoot &&
    isSingleRowReplacement(previous.version, version) &&
    version.index !== null
  ) {
    const index = version.index;
    const before = previous.identities.get(index);
    const after = projection.visibleTurnItems[index];
    const identity = after ? mediaRowIdentity(after) : undefined;
    if (previous.firstMediaIndex >= 0 && index > previous.firstMediaIndex && !previous.complete) {
      firstMediaIndex = previous.firstMediaIndex;
      eligible = previous.eligible;
    } else if (
      before &&
      after &&
      identity &&
      before.threadId === identity.threadId &&
      before.itemId === identity.itemId &&
      before.type === identity.type &&
      before.messageId === identity.messageId
    ) {
      if (previous.firstMediaIndex >= 0 && previous.firstMediaIndex !== index) {
        firstMediaIndex = previous.firstMediaIndex;
        eligible = previous.eligible;
        if (
          complete &&
          previous.eligible.has(index) &&
          rowMedia(after, messagesForMedia(projection), options).length > 0
        )
          complete = false;
      } else if (previous.eligible.has(index)) {
        const hasMedia = rowMedia(after, messagesForMedia(projection), options).length > 0;
        if (hasMedia || previous.firstMediaIndex < 0 || previous.complete) {
          firstMediaIndex = hasMedia ? index : -1;
          eligible = previous.eligible;
        }
      } else if (previous.firstMediaIndex < 0) {
        eligible = previous.eligible;
      }
    }
  }
  if (!eligible) {
    const seen = new Set<number>();
    visitMedia(projection, options, (items, index) => {
      seen.add(index);
      if (items.length === 0) return false;
      firstMediaIndex = index;
      return true;
    });
    complete = firstMediaIndex < 0 || firstMediaIndex === projection.visibleTurnItems.length - 1;
    eligible = seen;
    identities = new Map(
      [...seen].map((index) => [index, mediaRowIdentity(projection.visibleTurnItems[index]!)]),
    );
  }
  // Store only identity fields, never old row arrays or revision chains.
  presenceSummaries.set(version.revision, {
    version: { ...version, previousRevision: null },
    identities: identities!,
    messages: projection.messages,
    workspaceRoot: options.workspaceRoot,
    firstMediaIndex,
    complete,
    eligible,
  });
  return firstMediaIndex >= 0;
}

/** Unchanged immutable rows reuse their media; streamed chunks only parse the changed row. */
export function threadMediaIndex(
  projection: MediaProjection,
  options: MediaOptions = {},
): ThreadMediaItem[] {
  const items: ThreadMediaItem[] = [];
  visitMedia(projection, options, (media) => {
    items.push(...media);
    return false;
  });
  return items;
}

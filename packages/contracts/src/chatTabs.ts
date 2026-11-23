import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Chat tabs group related chats under one name, like browser tab groups: the session title
 * model files a new chat into a tab as it titles it, and the user can move chats, rename,
 * reorder and delete tabs. Each server keeps its own chats' tabs; clients show tabs with the
 * same name on different machines as one tab.
 */

/** Longest tab name, in characters. */
export const CHAT_TAB_NAME_MAX_LENGTH = 32;

/** Names that would make a catch-all tab, which defeats the point of tabs. */
const NOT_A_TAB = /^(?:all|none|no tab|n\/a|null|other|others|misc|miscellaneous|general)$/iu;

/**
 * A tab name as a model or a person wrote it, made one line without wrapping quotes or end
 * punctuation and cut to the length limit at a word. "" when nothing names a tab.
 */
export function cleanChatTabName(raw: string): string {
  let name = raw
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d.,;:!?]+$/gu, "")
    .trim();
  if (name.length > CHAT_TAB_NAME_MAX_LENGTH) {
    const cut = name.slice(0, CHAT_TAB_NAME_MAX_LENGTH + 1);
    const space = cut.lastIndexOf(" ");
    name = (space >= 8 ? cut.slice(0, space) : cut.slice(0, CHAT_TAB_NAME_MAX_LENGTH)).trim();
  }
  return NOT_A_TAB.test(name) ? "" : name;
}

export const ChatTabName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_TAB_NAME_MAX_LENGTH),
);
export type ChatTabName = typeof ChatTabName.Type;

export const CHAT_TAB_ICON_SIZE = 96;
export const CHAT_TAB_ICON_PIXEL_BYTES = CHAT_TAB_ICON_SIZE * CHAT_TAB_ICON_SIZE * 4;

/** One emoji, including flags, skin tones and joined emoji. */
export function isChatTabEmoji(value: string): boolean {
  return (
    value.length <= 32 &&
    /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u.test(
      value,
    )
  );
}

const ChatTabEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: Schema.String.check(Schema.isMaxLength(32), Schema.makeFilter(isChatTabEmoji)),
});

/** Private tab art, delivered through the authenticated owner catalog only. */
export const ChatTabIcon = Schema.Union([
  ChatTabEmojiIcon,
  Schema.Struct({
    kind: Schema.Literal("image"),
    dataUrl: Schema.String.check(
      Schema.isMaxLength(52_000),
      Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u),
    ),
  }),
]);
export type ChatTabIcon = typeof ChatTabIcon.Type;

/** A fixed pixel buffer lets the server encode its own PNG without trusting uploaded files. */
export const ChatTabIconInput = Schema.Union([
  ChatTabEmojiIcon,
  Schema.Struct({
    kind: Schema.Literal("image"),
    pixels: Schema.String.check(
      Schema.isMinLength((CHAT_TAB_ICON_PIXEL_BYTES * 4) / 3),
      Schema.isMaxLength((CHAT_TAB_ICON_PIXEL_BYTES * 4) / 3),
      Schema.isPattern(/^[A-Za-z0-9+/]+$/u),
    ),
  }),
]);
export type ChatTabIconInput = typeof ChatTabIconInput.Type;

export const ChatTab = Schema.Struct({
  name: ChatTabName,
  position: Schema.Number,
  /** Explicitly created tabs remain visible even when empty. */
  keepEmpty: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(ChatTabIcon),
});
export type ChatTab = typeof ChatTab.Type;

/** The tab a chat is in, as thread shells carry it. */
export const ChatTabRef = Schema.Struct({
  name: Schema.String,
  /** The tab's place in the strip, lowest first. */
  position: Schema.Number,
  /** The user put this chat in the tab, so the tab shows even while it holds only this chat. */
  manual: Schema.Boolean,
});
export type ChatTabRef = typeof ChatTabRef.Type;

/** A server-owned comparison, carried on every member's shell. */
export const ModelComparison = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
});
export type ModelComparison = typeof ModelComparison.Type;

export const ChatTabsCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("create"), tab: ChatTabName }),
  Schema.Struct({
    action: Schema.Literal("set-icon"),
    tab: ChatTabName,
    icon: Schema.NullOr(ChatTabIconInput),
  }),
  Schema.Struct({ action: Schema.Literal("compare"), comparison: ModelComparison }),
  Schema.Struct({
    action: Schema.Literal("continue-comparison"),
    comparisonId: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
  /** Puts chats in a tab (made if new), or takes them out of tabs with `tab: null`. */
  Schema.Struct({
    action: Schema.Literal("move"),
    threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    tab: Schema.NullOr(ChatTabName),
  }),
  /** Renames a tab; renaming onto another tab's name merges the two. */
  Schema.Struct({ action: Schema.Literal("rename"), tab: ChatTabName, to: ChatTabName }),
  /** Removes a tab. Its chats stay, outside any tab, and the model leaves them there. */
  Schema.Struct({ action: Schema.Literal("delete"), tab: ChatTabName }),
  /** Moves a tab to just before `before`, or to the end. */
  Schema.Struct({
    action: Schema.Literal("reorder"),
    tab: ChatTabName,
    before: Schema.NullOr(ChatTabName),
  }),
]);
export type ChatTabsCommand = typeof ChatTabsCommand.Type;

export class ChatTabsError extends Schema.TaggedError<ChatTabsError>()("ChatTabsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

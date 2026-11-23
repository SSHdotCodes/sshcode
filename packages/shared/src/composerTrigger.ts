export type ComposerTriggerKind =
  | "path"
  | "chat"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** As long as the server's chat search accepts. */
const CHAT_MENTION_MAX_LENGTH = 200;

/**
 * `@[words with spaces]` describes a chat instead of naming a word of its title; the brackets
 * are what let the description hold spaces. The trigger spans the whole bracket, closed or
 * not, so picking a chat replaces all of it, and it stays active with the caret just past the
 * closing bracket, which is where typing the description out in full ends.
 */
export function detectChatMentionTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const boundary = isWhitespaceChar ?? isWhitespace;
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const inside = cursor > 0 && text[cursor - 1] === "]" ? cursor - 1 : cursor;
  if (inside < 2) return null;
  const open = text.lastIndexOf("@[", inside - 2);
  if (open < lineStart) return null;
  if (open > 0 && !boundary(text[open - 1] ?? "")) return null;
  if (text.slice(open + 2, inside).includes("]")) return null;
  // A closing bracket further along the line ends this one, unless another opens first.
  let close = -1;
  for (let index = inside; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\n" || (char === "@" && text[index + 1] === "[")) break;
    if (char === "]") {
      close = index;
      break;
    }
  }
  const end = close === -1 ? cursor : close;
  if (end - (open + 2) > CHAT_MENTION_MAX_LENGTH) return null;
  return {
    kind: "chat",
    query: text.slice(open + 2, end).trim(),
    rangeStart: open,
    rangeEnd: close === -1 ? cursor : close + 1,
  };
}

/**
 * Detect an active trigger (@path, @[chat], $skill, /command) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const chat = detectChatMentionTrigger(text, cursor, isWhitespaceChar);
  if (chat) return chat;
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/i.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

export interface ComposerEmojiTrigger {
  kind: "emoji";
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

/** Emoji is opt-in for editors so existing command consumers keep their trigger contract. */
export function detectComposerEmojiTrigger(
  text: string,
  cursorInput: number,
): ComposerEmojiTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const prefix = text.slice(0, cursor);
  const match = /(?:^|[\s([{\uFFFC])(:([a-z0-9_+-]{1,64}))$/i.exec(prefix);
  if (!match) return null;
  const rangeStart = cursor - match[1]!.length;
  // Code may still be incomplete while the user is typing it.
  let fence: { character: string; length: number } | null = null;
  let inlineTicks = 0;
  for (const line of prefix.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) {
        fence = { character: run[0]!, length: run.length };
      } else if (
        run[0] === fence.character &&
        run.length >= fence.length &&
        !delimiter[2]!.trim()
      ) {
        fence = null;
      }
      inlineTicks = 0;
      continue;
    }
    if (fence) continue;
    for (const tick of line.matchAll(/(?<!\\)`+/g)) {
      if (!inlineTicks) inlineTicks = tick[0].length;
      else if (inlineTicks === tick[0].length) inlineTicks = 0;
    }
  }
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (fence || inlineTicks || /^(?: {4}|\t)/.test(currentLine)) return null;
  return { kind: "emoji", query: match[2]!, rangeStart, rangeEnd: cursor };
}

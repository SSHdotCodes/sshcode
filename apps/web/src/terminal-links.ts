import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
const PARENTHESIZED_LOCATION = String.raw`\((\d+)(?:,(\d+))?\)`;
const COMPILER_DIAGNOSTIC = String.raw`:\s+(?:fatal\s+)?(?:error|warning)\s+[A-Za-z]+\d+:`;
const FILE_PATH_PATTERN = new RegExp(
  [
    String.raw`(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'\`<>]+`,
    String.raw`[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:${PARENTHESIZED_LOCATION}(?=:)|(?::\d+){0,2})`,
    String.raw`(?<![\w.-])[A-Za-z0-9._-]+\.[A-Za-z][A-Za-z0-9_-]*${PARENTHESIZED_LOCATION}(?=${COMPILER_DIAGNOSTIC})`,
  ].join("|"),
  "g",
);
const PARENTHESIZED_POSITION = new RegExp(String.raw`(?<![\\/])${PARENTHESIZED_LOCATION}$`, "u");
const COMPILER_DIAGNOSTIC_SUFFIX = new RegExp(`^${COMPILER_DIAGNOSTIC}`, "u");
const PHP_STACK_FRAME_PREFIX = /^\s*#\d+\s+$/u;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  let output = value.replace(
    kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN,
    "",
  );
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw, kind);
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const end = start + trimmed.length;
    // Interpret the numeric suffix only in a compiler diagnostic or a PHP stack frame.
    const text =
      kind === "path" &&
      line[end] === ":" &&
      (COMPILER_DIAGNOSTIC_SUFFIX.test(line.slice(end)) ||
        PHP_STACK_FRAME_PREFIX.test(line.slice(0, start)))
        ? trimmed.replace(PARENTHESIZED_POSITION, (_, row: string, column?: string) =>
            column === undefined ? `:${row}` : `:${row}:${column}`,
          )
        : trimmed;
    const candidate: TerminalLinkMatch = {
      kind,
      text,
      start,
      end,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, urlMatches);
  return [...urlMatches, ...pathMatches].toSorted((a, b) => a.start - b.start);
}

export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

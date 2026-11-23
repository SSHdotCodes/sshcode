import { composerModelMathRanges } from "@t3tools/client-runtime/composerModelMath";
import { collectComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import type { AssistantCitation } from "@t3tools/contracts";
import { collectGithubLinks } from "@t3tools/shared/githubLinks";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "github-link";
      label: string;
      source: string;
    }
  | {
      type: "mention";
      path: string;
      source: string;
    }
  | {
      type: "skill";
      name: string;
      source: string;
    }
  | {
      type: "model";
      instanceId: string;
      model: string;
      source: string;
    }
  | {
      type: "citation";
      citation: AssistantCitation;
      source: string;
    }
  | {
      type: "context-reference";
      kind: string;
      contextId: string;
      label: string;
      source: string;
    };

function rangeIncludesIndex(start: number, end: number, index: number): boolean {
  return start <= index && index < end;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function forEachPromptTextSlice(
  prompt: string,
  visitor: (text: string, promptOffset: number) => boolean | void,
): boolean {
  return prompt.length > 0 && visitor(prompt, 0) === true;
}

function forEachMentionMatch(
  prompt: string,
  visitor: (
    match: Extract<ComposerInlineToken, { type: "mention" }>,
    promptOffset: number,
  ) => boolean | void,
): boolean {
  return forEachPromptTextSlice(prompt, (text, promptOffset) => {
    for (const match of collectComposerPromptInlineTokens(text)) {
      if (match.type !== "mention") {
        continue;
      }
      if (visitor(match, promptOffset) === true) {
        return true;
      }
    }
    return false;
  });
}

export function collectComposerPromptInlineTokens(
  text: string,
  options?: { readonly githubLinks?: boolean },
) {
  const inlineTokens = collectComposerInlineTokens(text);
  const taken = [...inlineTokens, ...composerModelMathRanges(text)];
  const models = collectComposerModelMentions(text)
    .filter(
      (mention) =>
        (mention.label !== undefined || /\s/.test(text[mention.end] ?? "")) &&
        !taken.some((range) => mention.start < range.end && mention.end > range.start),
    )
    .map((mention) => ({ ...mention, type: "model" as const }));
  const tokens = [...inlineTokens, ...models].sort((left, right) => left.start - right.start);
  const citations = collectAssistantCitations(text);
  const references = collectComposerContextReferences(text);
  // A GitHub URL is a chip once whitespace follows it, never at the end of the prompt. The
  // editor leaves the URL being typed as text, and its doc and this parse must agree on every
  // chip, or cursor positions disagree and the editor and composer move the caret forever.
  const githubLinks = options?.githubLinks === false ? [] : collectGithubLinks(text, false);
  if (citations.length === 0 && references.length === 0 && githubLinks.length === 0) return tokens;

  // An unfinished @ mention can otherwise consume the start of a link label.
  const links = [
    ...githubLinks,
    ...citations.map((match) => ({ ...match, type: "citation" as const })),
    ...references.map((match) => ({ ...match, type: "context-reference" as const })),
  ];
  return [
    ...tokens.filter(
      (token) => !links.some((link) => token.start < link.end && token.end > link.start),
    ),
    ...links,
  ].sort((left, right) => left.start - right.start);
}

function splitPromptTextIntoComposerSegments(
  text: string,
  options?: { readonly githubLinks?: boolean },
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  const tokenMatches = collectComposerPromptInlineTokens(text, options);
  let cursor = 0;
  for (const match of tokenMatches) {
    if (match.start < cursor) {
      continue;
    }

    if (match.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, match.start));
    }

    if (match.type === "github-link") {
      segments.push({ type: "github-link", label: match.label, source: match.source });
    } else if (match.type === "citation") {
      segments.push({ type: "citation", citation: match.citation, source: match.source });
    } else if (match.type === "context-reference") {
      segments.push({
        type: "context-reference",
        kind: match.kind,
        contextId: match.contextId,
        label: match.label,
        source: match.source,
      });
    } else if (match.type === "mention") {
      segments.push({
        type: "mention",
        path: match.value,
        source: match.source,
      });
    } else if (match.type === "model") {
      segments.push({
        type: "model",
        instanceId: match.instanceId,
        model: match.model,
        source: match.source,
      });
    } else {
      segments.push({ type: "skill", name: match.value, source: match.source });
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }

  return forEachMentionMatch(prompt, (match, promptOffset) => {
    const mentionStart = promptOffset + match.start;
    const mentionEnd = promptOffset + match.end;
    const beforeMentionIndex = mentionStart - 1;
    const afterMentionIndex = mentionEnd;

    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, beforeMentionIndex)
    ) {
      return true;
    }

    if (
      afterMentionIndex < prompt.length &&
      /\s/.test(prompt[afterMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, afterMentionIndex)
    ) {
      return true;
    }
    return false;
  });
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  options?: { readonly githubLinks?: boolean },
): ComposerPromptSegment[] {
  return splitPromptTextIntoComposerSegments(prompt, options);
}

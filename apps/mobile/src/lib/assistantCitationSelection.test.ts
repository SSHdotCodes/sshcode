import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  findAssistantCitationText,
  parseAssistantCitationHref,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  citedMessageMissing,
  collectAssistantTextChoices,
  nativeSelectionOccurrence,
  resolveAssistantTextChoice,
  splitAssistantMarkdown,
} from "./assistantCitationSelection";

const firstRow = (markdown: string) =>
  splitAssistantMarkdown(markdown).find((row) => row.kind === "markdown")!.key;
const noPills = { isPill: () => false };

describe("collectAssistantTextChoices", () => {
  it("maps a selection to offsets and context in the message's rendered text", () => {
    const markdown = "Intro **bold** words.\n\n- one item\n- the cited part here";
    const [choice] = collectAssistantTextChoices(markdown, firstRow(markdown), "cited part");
    const rendered = "Intro bold words. one item the cited part here";
    expect(choice?.selector).toMatchObject({
      text: "cited part",
      start: rendered.indexOf("cited part"),
      end: rendered.indexOf("cited part") + "cited part".length,
    });
    expect(findAssistantCitationText(rendered, choice!.selector)).toEqual({
      start: rendered.indexOf("cited part"),
      end: rendered.indexOf("cited part") + 10,
    });
  });

  it("offers each copy in the row, numbered across the whole message", () => {
    const markdown = "first **quote** then **quote** last";
    const choices = collectAssistantTextChoices(markdown, firstRow(markdown), "quote");
    expect(choices.map(({ index, count }) => [index, count])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(choices[1]?.selector.start).toBe(17);
    expect(choices[1]?.selector.prefix).toBe("first quote then ");
  });

  it("counts copies in rows split around a lifted image strip", () => {
    const markdown = "quote before\n\n![a](a.png) ![b](b.png)\n\nquote after";
    const rows = splitAssistantMarkdown(markdown).filter((row) => row.kind === "markdown");
    expect(rows).toHaveLength(2);
    const [second] = collectAssistantTextChoices(markdown, rows[1]!.key, "quote");
    expect([second?.index, second?.count]).toEqual([1, 2]);
    expect(findAssistantCitationText("quote before quote after", second!.selector)).toEqual({
      start: 13,
      end: 18,
    });
  });

  it("uses the displayed label of a compacted GitHub link", () => {
    const markdown = "See https://github.com/pingdotgg/t3code/pull/12 for details";
    const [choice] = collectAssistantTextChoices(
      markdown,
      firstRow(markdown),
      "pingdotgg/t3code#12 for",
    );
    expect(choice?.selector.prefix).toBe("See ");
  });

  it("rejects blank, missing and over-repeated selections instead of guessing", () => {
    const markdown = "quote quote";
    const row = firstRow(markdown);
    expect(collectAssistantTextChoices(markdown, row, " ")).toEqual([]);
    expect(collectAssistantTextChoices(markdown, row, "other")).toEqual([]);
    expect(collectAssistantTextChoices(markdown, "missing", "quote")).toEqual([]);
    const repeated = "quote ".repeat(21);
    expect(collectAssistantTextChoices(repeated, firstRow(repeated), "quote")).toEqual([]);
  });

  it("serializes choices into the Mac's v1 link format", () => {
    const markdown = "first **quote** then **quote** last";
    const [, second] = collectAssistantTextChoices(markdown, firstRow(markdown), "quote");
    const href = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      ...second!.selector,
    });
    expect(href.startsWith("[Assistant quote](t3-citation://v1/env/thread/assistant?")).toBe(true);
    expect(parseAssistantCitationHref(href.slice(18, -1))?.start).toBe(17);
  });
});

describe("nativeSelectionOccurrence", () => {
  it("finds the copy at the selection's own offset in a paragraph", () => {
    const markdown = "first quote then quote last";
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 17, end: 22 }, noPills),
    ).toEqual({ index: 1, count: 2 });
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 6, end: 11 }, noPills),
    ).toEqual({ index: 0, count: 2 });
  });

  it("counts a link pill as one character, as the native view stores it", () => {
    const markdown = "Open [a long file label](/repo/file.ts) then quote, and later quote again";
    const isPill = (url: string) => url === "/repo/file.ts";
    // "Open " + pill + " then " puts the first copy at storage offset 12.
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 12, end: 17 }, { isPill }),
    ).toEqual({ index: 0, count: 2 });
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 29, end: 34 }, { isPill }),
    ).toEqual({ index: 1, count: 2 });
  });

  it("tolerates small drift but asks when copies sit too close together", () => {
    const spaced = "quote and some words between them, then quote";
    expect(
      nativeSelectionOccurrence(spaced, { text: "quote", start: 43, end: 48 }, noPills),
    ).toEqual({ index: 1, count: 2 });
    expect(
      nativeSelectionOccurrence("quote quote", { text: "quote", start: 6, end: 11 }, noPills),
    ).toBeNull();
  });

  it("asks when copies in separate native views share a local offset", () => {
    const markdown = "quote\n\n```\nquote\n```";
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 0, end: 5 }, noPills),
    ).toBeNull();
  });

  it("restarts offsets in each code block, quote and table cell", () => {
    const markdown = "intro text\n\n> a quote here\n\nlater words and a quote";
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 2, end: 7 }, noPills),
    ).toEqual({ index: 0, count: 2 });
    expect(
      nativeSelectionOccurrence(markdown, { text: "quote", start: 18, end: 23 }, noPills),
    ).toEqual({ index: 1, count: 2 });
  });
});

describe("citedMessageMissing", () => {
  const reply = MessageId.make("reply");
  const row = (messageId: string) =>
    ({
      sourceItemId: `item-${messageId}`,
      item: { id: `item-${messageId}`, type: "assistant_message", messageId },
    }) as unknown as OrchestrationV2ProjectedTurnItem;

  it("is missing only once the whole history is loaded without the reply", () => {
    expect(citedMessageMissing([row("other")], false, reply)).toBe(true);
    expect(citedMessageMissing([row("other"), row("reply")], false, reply)).toBe(false);
    expect(citedMessageMissing([row("other")], true, reply)).toBe(false);
    expect(citedMessageMissing(null, false, reply)).toBe(false);
  });
});

describe("resolveAssistantTextChoice", () => {
  const markdown = "first **quote** then **quote** last";
  const choices = collectAssistantTextChoices(markdown, firstRow(markdown), "quote");

  it("takes the only copy, or the one the native position names", () => {
    expect(resolveAssistantTextChoice(choices.slice(0, 1), null)).toBe(choices[0]);
    expect(resolveAssistantTextChoice(choices, { index: 1, count: 2 })).toBe(choices[1]);
  });

  it("asks when the native view counted a different number of copies", () => {
    expect(resolveAssistantTextChoice(choices, null)).toBeNull();
    expect(resolveAssistantTextChoice(choices, { index: 1, count: 3 })).toBeNull();
  });
});

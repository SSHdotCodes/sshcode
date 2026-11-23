import { expect, it } from "vite-plus/test";
import {
  findThreadSearchOccurrences,
  focusThreadSearchSnippet,
  splitThreadSearchText,
} from "./threadSearch.ts";

it("finds non-overlapping occurrences without invalidating Unicode offsets", () => {
  expect(findThreadSearchOccurrences("Deploy the Deployment", "deploy")).toEqual([0, 11]);
  expect(findThreadSearchOccurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(findThreadSearchOccurrences("İİİ needle", "needle")).toEqual([4]);
});

it("splits search text into highlighted and unhighlighted parts", () => {
  expect(splitThreadSearchText("one TWO three two", " two ")).toEqual([
    { text: "one ", highlighted: false, start: 0 },
    { text: "TWO", highlighted: true, start: 4 },
    { text: " three ", highlighted: false, start: 7 },
    { text: "two", highlighted: true, start: 14 },
  ]);
});

it("matches both Greek sigma forms without changing source offsets", () => {
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "Σ")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "ς")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("İ ΟΣ", "Σ")).toEqual([3]);
});

it("brings a match that sits deep in a snippet into view for a one-line row", () => {
  const snippet =
    "Waiting on the Mac build; a subagent is adding blocking-stack capture to the stall journal.";
  expect(focusThreadSearchSnippet(snippet, "Stall journal")).toBe("…capture to the stall journal.");
  // A match near the start needs no cut.
  expect(focusThreadSearchSnippet("The stall journal records each freeze", "stall journal")).toBe(
    "The stall journal records each freeze",
  );
  // The whole phrase is absent: the longest word that does appear is used.
  expect(
    focusThreadSearchSnippet(`${"word ".repeat(10)}the journal is rotated`, "stall journal"),
  ).toBe("…word word the journal is rotated");
  // A meaning match has no words to centre on.
  expect(focusThreadSearchSnippet(snippet, "freeze log")).toBe(snippet);
  expect(focusThreadSearchSnippet(snippet, "  ")).toBe(snippet);
  // No word boundary before the match: cut by length, never through a surrogate pair.
  expect(focusThreadSearchSnippet(`${"😀".repeat(12)}needle`, "needle")).toBe(
    `…${"😀".repeat(9)}needle`,
  );
});

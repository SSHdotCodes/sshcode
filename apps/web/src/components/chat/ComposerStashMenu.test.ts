import {
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { stashEntrySnippet } from "./ComposerStashMenu";

const entry = (prompt: string) => ({
  id: "stash-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  prompt,
  attachments: [],
  droppedImageNames: [],
});

describe("stashEntrySnippet", () => {
  it("shows context chips by their label", () => {
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    expect(stashEntrySnippet(entry(`Summarize ${file} please`))).toBe("Summarize README.md please");
  });
});

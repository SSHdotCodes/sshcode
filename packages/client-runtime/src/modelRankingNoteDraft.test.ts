import { describe, expect, it } from "vite-plus/test";
import * as Draft from "./modelRankingNoteDraft.ts";

const note = "sol catches subtle regressions and explains my fixes well";

describe("model ranking note drafts", () => {
  it("commits the latest change after dismissal and ignores an unchanged source snapshot", () => {
    let draft = Draft.create("");
    draft = Draft.change(draft, "sol catches");
    draft = Draft.change(draft, note);
    expect(note).toHaveLength(57);
    draft = Draft.receive(draft, "");
    expect(draft.text).toBe(note);
    expect(Draft.commitValue(draft)).toBe(note);
    // A failed or coalesced write has no acknowledgment: the text remains retryable.
    expect(Draft.commitValue(Draft.receive(draft, ""))).toBe(note);
    draft = Draft.acknowledge(draft, note);
    expect(Draft.commitValue(draft)).toBeNull();
    expect(Draft.receive(draft, "").text).toBe(note);
    draft = Draft.receive(draft, note);
    expect(draft.text).toBe(note);
    expect(Draft.receive(draft, "Edited on desktop").text).toBe("Edited on desktop");
  });

  it("keeps unsaved text across a remote update and an acknowledgment of an older edit", () => {
    let draft = Draft.change(Draft.create("Original"), "First edit");
    const submitted = Draft.commitValue(draft)!;
    draft = Draft.change(draft, "Second edit");
    draft = Draft.receive(draft, "Updated on desktop");
    expect(draft.text).toBe("Second edit");
    draft = Draft.acknowledge(draft, submitted);
    draft = Draft.receive(draft, submitted);
    expect(draft.text).toBe("Second edit");
    expect(Draft.commitValue(draft)).toBe("Second edit");
  });

  it("supports clearing a saved note, preserving its empty draft until acknowledgment", () => {
    let draft = Draft.change(Draft.create(note), "   ");
    expect(Draft.commitValue(draft)).toBe("");
    expect(Draft.receive(draft, note).text).toBe("   ");
    draft = Draft.acknowledge(draft, "");
    expect(draft.text).toBe("");
    expect(Draft.commitValue(draft)).toBeNull();
    expect(Draft.receive(draft, note).text).toBe("");
    expect(Draft.receive(draft, "").text).toBe("");
  });

  it("normalizes notes and follows source updates after an edit is canceled", () => {
    let draft = Draft.change(Draft.create("Original note"), "  Updated note  ");
    expect(Draft.commitValue(draft)).toBe("Updated note");
    draft = Draft.change(draft, "Original note");
    expect(Draft.commitValue(draft)).toBeNull();
    expect(Draft.receive(draft, "Edited on desktop").text).toBe("Edited on desktop");
  });
});

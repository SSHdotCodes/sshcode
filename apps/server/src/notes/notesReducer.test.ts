import { describe, expect, it } from "@effect/vitest";
import { NoteId, type NoteOperation, type NotesState } from "@t3tools/contracts";
import { applyNoteOperation } from "./notesReducer.ts";

const a = NoteId.make("a");
const b = NoteId.make("b");
const c = NoteId.make("c");
const createdAt = "2026-10-15T12:00:00.000Z";
const updatedAt = "2026-10-15T12:01:00.000Z";
const empty: NotesState = { version: 1, items: [] };
const apply = (state: NotesState, ...operations: ReadonlyArray<NoteOperation>) =>
  operations.reduce((state, operation) => applyNoteOperation(state, operation, updatedAt), state);
const initial = applyNoteOperation(empty, { type: "add", id: a, text: "First idea" }, createdAt);

describe("notes operations", () => {
  it("merges independent additions and changes without overwriting other fields", () => {
    const state = apply(
      initial,
      { type: "add", id: b, text: "From the phone" },
      { type: "setDone", id: a, done: true },
      { type: "updateText", id: a, text: "Edited on the Mac" },
    );
    expect(state.items).toEqual([
      { id: a, text: "Edited on the Mac", done: true, createdAt, updatedAt },
      { id: b, text: "From the phone", done: false, createdAt: updatedAt, updatedAt },
    ]);
    expect(apply(state, { type: "setDone", id: a, done: false }).items[0]?.done).toBe(false);
  });

  it("does not resurrect deletes with late edits, checks, or moves", () => {
    expect(
      apply(
        initial,
        { type: "delete", id: a },
        { type: "updateText", id: a, text: "Late edit" },
        { type: "setDone", id: a, done: true },
        { type: "reorder", id: a, beforeId: null },
      ),
    ).toEqual(empty);
  });

  it("deduplicates retries of an add and sets a desired completion state", () => {
    const state = apply(
      initial,
      { type: "add", id: a, text: "Duplicate" },
      { type: "setDone", id: a, done: true },
      { type: "setDone", id: a, done: true },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe("First idea");
    expect(state.items[0]?.done).toBe(true);
  });

  it("moves one item while preserving a concurrent addition", () => {
    const state = apply(
      initial,
      { type: "add", id: b, text: "Second" },
      { type: "add", id: c, text: "Concurrent" },
      { type: "reorder", id: b, beforeId: a },
    );
    expect(state.items.map((item) => item.id)).toEqual([b, a, c]);
    expect(
      apply(state, { type: "reorder", id: b, beforeId: null }).items.map((item) => item.id),
    ).toEqual([a, c, b]);
    expect(apply(state, { type: "reorder", id: b, beforeId: NoteId.make("deleted") })).toBe(state);
    expect(apply(state, { type: "reorder", id: b, beforeId: b })).toBe(state);
  });

  it("clears only items that are done when the operation is applied", () => {
    const state = apply(
      initial,
      { type: "setDone", id: a, done: true },
      { type: "add", id: b, text: "Still open" },
      { type: "add", id: c, text: "Checked then unchecked" },
      { type: "setDone", id: c, done: true },
      { type: "setDone", id: c, done: false },
      { type: "clearDone" },
    );
    expect(state.items.map((item) => item.id)).toEqual([b, c]);
  });
});
